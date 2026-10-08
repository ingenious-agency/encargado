import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { Problem, type Runner } from "./model.ts";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "project";
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function redact(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/(https?:\/\/|postgres(?:ql)?:\/\/|ecto:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:password|secret|token|api[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomBytes(6).toString("hex") + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readJson(path: string, fallback?: unknown): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export const run: Runner = async command => new Promise((resolve, reject) => {
  const child = spawn(command.file, command.args, {
    cwd: command.cwd, env: { ...(command.env ?? process.env), LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const out: Buffer[] = [], err: Buffer[] = [];
  let size = 0, failure: string | undefined, killTimer: NodeJS.Timeout | undefined;
  const stop = (message: string) => {
    if (failure) return;
    failure = message;
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
    killTimer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
  };
  const timer = setTimeout(() => stop("Command timed out"), command.timeout ?? 30000);
  for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]] as const) {
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop("Command output exceeded limit");
      else chunks.push(chunk);
    });
  }
  child.on("error", error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(new Problem("Cannot execute " + command.file + ": " + error.message)); });
  child.on("close", code => {
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    if (failure) reject(new Problem(failure + ": " + command.file));
    else resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
  });
});
export async function checked(runner: Runner, command: Parameters<Runner>[0]): Promise<string> {
  const result = await runner(command);
  if (result.code) throw new Problem(command.file + " failed: " + redact(result.stderr.trim()).slice(0, 2000));
  return result.stdout;
}
export function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
export function object(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Problem(label + " must be an object");
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(s => typeof s === "string" && s.length && !/[\0\r\n]/.test(s))) throw new Problem(label + " must be an array of nonempty strings");
  return value;
}
