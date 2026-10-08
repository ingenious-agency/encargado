import { spawn } from "node:child_process";
import { PassThrough, Transform, type TransformCallback } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { Problem, type Command, type StreamRunner } from "./model.ts";
import { redact } from "./util.ts";

export function logLineCount(value: unknown = 100): number {
  const lines = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 0 || lines > 10000) {
    throw new Problem("lines must be an integer between 0 and 10000");
  }
  return lines;
}

// Buffer a complete line before redaction: credentials can cross pipe chunks.
class LogLines extends Transform {
  decoder = new StringDecoder("utf8"); pending = "";
  constructor() { super({ readableObjectMode: true }); }
  emitLine(line: string) {
    if (Buffer.byteLength(line) > 64 * 1024) throw new Problem("Log line exceeds 64 KiB");
    this.push(redact(line));
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      this.pending += this.decoder.write(chunk);
      let newline: number;
      while ((newline = this.pending.indexOf("\n")) >= 0) {
        this.emitLine(this.pending.slice(0, newline + 1)); this.pending = this.pending.slice(newline + 1);
      }
      if (Buffer.byteLength(this.pending) > 64 * 1024) throw new Problem("Log line exceeds 64 KiB");
      callback();
    } catch (error) { callback(error as Error); }
  }
  _flush(callback: TransformCallback) {
    try { this.pending += this.decoder.end(); if (this.pending) this.emitLine(this.pending); callback(); }
    catch (error) { callback(error as Error); }
  }
}

export const streamCommand: StreamRunner = async function* (command, signal) {
  if (signal.aborted) return;
  const child = spawn(command.file, command.args, {
    cwd: command.cwd, env: { ...(command.env ?? process.env), LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const output = new PassThrough({ objectMode: true });
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (!child.pid || killTimer) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
    killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1000);
  };
  const closed = new Promise<number | null>(resolve => child.once("close", code => { if (killTimer) clearTimeout(killTimer); resolve(code); }));
  child.once("error", error => output.destroy(new Problem("Cannot read logs using " + command.file + ": " + redact(error.message))));
  const readers = [child.stdout, child.stderr].map(pipe => {
    const lines = new LogLines(); pipe.pipe(lines).pipe(output, { end: false }); return lines;
  });
  const completion = Promise.all([...readers.map(reader => finished(reader, { cleanup: true })), closed]).then(results => {
    const code = results.at(-1);
    if (!signal.aborted && code !== 0) output.destroy(new Problem("Log reader " + command.file + " exited with status " + code));
    else output.end();
  }).catch(error => output.destroy(error));
  const abort = () => { stop(); output.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const line of output) yield line as string;
  } catch (error) { if (!signal.aborted) throw error; }
  finally {
    stop(); signal.removeEventListener("abort", abort);
    for (const reader of readers) reader.destroy();
    output.destroy(); await closed; await completion;
  }
};

// Keep at most one pending item per reader; cancellation reaches every reader.
export async function* mergeLogCommands(commands: Command[], runner: StreamRunner, signal: AbortSignal): AsyncIterable<string> {
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const iterators = commands.map(command => runner(command, controller.signal)[Symbol.asyncIterator]());
  const next = (index: number) => iterators[index].next().then(result => ({ index, result }), error => ({ index, error: error as unknown }));
  const pending = new Map(iterators.map((_iterator, index) => [index, next(index)]));
  try {
    while (pending.size && !controller.signal.aborted) {
      const item = await Promise.race(pending.values());
      if ("error" in item) throw item.error;
      const { index, result } = item;
      if (result.done) pending.delete(index);
      else { yield result.value; pending.set(index, next(index)); }
    }
  } finally {
    controller.abort(); signal.removeEventListener("abort", abort);
    await Promise.allSettled(iterators.map(iterator => iterator.return?.()));
  }
}
