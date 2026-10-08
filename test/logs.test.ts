import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { request } from "node:http";
import { fixture } from "./helpers.ts";
import { ComposeDriver, SystemdDriver } from "../src/drivers.ts";
import { streamCommand } from "../src/logs.ts";
import { Manager } from "../src/manager.ts";
import { Daemon, client, followLogs } from "../src/server.ts";
import { Problem, type Command, type StreamRunner } from "../src/model.ts";
import { checked, run } from "../src/util.ts";

async function collect(logs: AsyncIterable<string>) {
  const lines: string[] = []; for await (const line of logs) lines.push(line); return lines;
}
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const query = (path: string, service = "web", extra = {}) => "/v1/logs?" + new URLSearchParams({ path, service, ...extra });

test("log readers preserve UTF-8, redact split credentials and stderr, and flush final partial lines", async () => {
  const source = `
    process.stdout.write(Buffer.from([0xc3]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0xa9]));
      process.stdout.write(' token=fixture-');
      setTimeout(() => {
        process.stdout.write('secret\\n');
        process.stderr.write('password=fixture-secret\\n');
        process.stdout.write('final partial line');
      }, 10);
    }, 10);
  `;
  const lines = await collect(streamCommand({ file: process.execPath, args: ["-e", source] }, new AbortController().signal));
  assert.ok(lines.includes("é token=[redacted]\n"));
  assert.ok(lines.includes("password=[redacted]\n"));
  assert.ok(lines.includes("final partial line"));
  assert.doesNotMatch(lines.join(""), /fixture-secret/);
});

test("following has no accumulated output cap and oversized individual lines fail safely", async () => {
  let bytes = 0;
  for await (const line of streamCommand({ file: process.execPath, args: ["-e", "process.stdout.write(('x'.repeat(127)+'\\n').repeat(33000))"] }, new AbortController().signal)) bytes += line.length;
  assert.equal(bytes, 33000 * 128);
  await assert.rejects(collect(streamCommand({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000)"] }, new AbortController().signal)), /Log line exceeds/);
});

test("reader failures are reported and cancelling a resistant reader reaps only its process", { timeout: 5000 }, async t => {
  await assert.rejects(collect(streamCommand({ file: "/encargado-fixture-missing-reader", args: [] }, new AbortController().signal)), /Cannot read logs/);
  await assert.rejects(collect(streamCommand({ file: process.execPath, args: ["-e", "process.exit(7)"] }, new AbortController().signal)), /status 7/);
  const controller = new AbortController();
  const iterator = streamCommand({ file: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"] }, controller.signal)[Symbol.asyncIterator]();
  t.after(async () => { controller.abort(); await iterator.return?.(); });
  const pid = Number((await iterator.next()).value);
  const waiting = iterator.next(); controller.abort();
  assert.equal((await waiting).done, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("drivers follow the exact registered systemd unit and concurrently selected Compose containers", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const web = f.manager.service(await f.manager.context(f.project), "web"), db = f.manager.service(await f.manager.context(f.project), "postgres");
  const calls: Command[] = [], closed: string[] = [];
  const reader: StreamRunner = async function* (command, signal) {
    calls.push(command);
    try {
      yield command.args.at(-1)! + "\n";
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally { closed.push(command.args.at(-1)!); }
  };
  const controller = new AbortController(); t.after(() => controller.abort());
  const systemd = new SystemdDriver(f.manager.runner, f.config, reader);
  const app = (await systemd.followLogs(web, f.manager.state, controller.signal, 12))[Symbol.asyncIterator]();
  await app.next();
  assert.deepEqual(calls[0], { file: "journalctl", args: ["--user", "--unit", web.unit, "--lines", "12", "--no-pager", "--output=short-iso", "--follow"] });
  const dockerCalls: Command[] = [];
  const docker = new ComposeDriver(async command => {
    dockerCalls.push(command);
    return { code: 0, stdout: command.args[0] === "ps" ? "fixture-one\nfixture-two\n" : '{"id":"fixture-one"}\n{"id":"fixture-two"}\n', stderr: "" };
  }, f.config, reader);
  const dependency = (await docker.followLogs(db, f.manager.state, controller.signal, 0))[Symbol.asyncIterator]();
  const first = await dependency.next(), second = await dependency.next();
  assert.deepEqual(new Set([first.value, second.value]), new Set(["fixture-one\n", "fixture-two\n"]));
  assert.deepEqual(dockerCalls[0].args, ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + db.composeProject, "--filter", "label=com.docker.compose.service=postgres"]);
  assert.deepEqual(calls.slice(1).map(command => command.args), [["logs", "--tail", "0", "--follow", "fixture-one"], ["logs", "--tail", "0", "--follow", "fixture-two"]]);
  controller.abort(); await app.next(); await dependency.next();
  assert.equal(closed.length, 3);
  assert.equal(f.driver.stops.length, 0);
});

test("Compose snapshots include stderr, fail on reader errors, and following absent containers fails before streaming", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const db = f.manager.service(await f.manager.context(f.project), "postgres");
  let fail = false, exists = true;
  const driver = new ComposeDriver(async command => {
    if (command.args[0] === "ps") return { code: 0, stdout: exists ? "fixture-owned" : "", stderr: "" };
    if (command.args[0] === "inspect") return { code: 0, stdout: '{"id":"fixture-owned"}', stderr: "" };
    assert.deepEqual(command.args, ["logs", "--tail", "20", "fixture-owned"]);
    return { code: fail ? 1 : 0, stdout: "stdout\n", stderr: "stderr token=fixture-secret\n" };
  }, f.config);
  assert.equal(await driver.logs(db, f.manager.state, 20), "stdout\nstderr token=[redacted]\n");
  fail = true; await assert.rejects(driver.logs(db, f.manager.state, 20), /Cannot read Docker logs/);
  exists = false; await assert.rejects(driver.followLogs(db, f.manager.state, new AbortController().signal), { status: 404 });
});

test("a failing Compose reader cancels its sibling readers", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const db = f.manager.service(await f.manager.context(f.project), "postgres");
  let stopped = false;
  const reader: StreamRunner = async function* (command, signal) {
    if (command.args.at(-1) === "bad") throw new Error("fixture reader failed");
    try { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }
    finally { stopped = true; }
  };
  const driver = new ComposeDriver(async command => ({ code: 0, stdout: command.args[0] === "ps" ? "good\nbad" : '{"id":"good"}\n{"id":"bad"}', stderr: "" }), f.config, reader);
  await assert.rejects(collect(await driver.followLogs(db, f.manager.state, new AbortController().signal)), /fixture reader failed/);
  assert.equal(stopped, true);
});

test("manager logs resolve worktrees after reload and remain readable during queued lifecycle work", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  f.driver.logs = async (service, _state, lines) => `${service.id}:${lines}`;
  const recovered = new Manager(f.config, f.manager.runner, undefined, f.manager.drivers, f.routes); await recovered.load();
  const hold = Promise.withResolvers<void>();
  const queued = recovered.queue.execute(() => hold.promise);
  try {
    const main = await recovered.logs(f.project, "web", 5), feature = await recovered.logs(wt, "web", "5");
    assert.notEqual(main, feature);
    assert.match(feature, /:5$/);
    assert.equal(f.driver.starts.length, 0);
    for (const lines of [-1, 10001, 1.5, "1x", "", null]) await assert.rejects(recovered.logs(wt, "web", lines), /lines must/);
  } finally { hold.resolve(); await queued; }
});

test("socket streams redact live output, stay worktree-specific, and disconnect without stopping services", { timeout: 5000 }, async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project); await f.manager.up(f.project);
  const wt = await f.worktree(); await f.manager.register(wt); await f.manager.up(wt);
  const live = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
  f.driver.followLogs = async (service, _state, signal, lines) => (async function* () {
    const stopped = Promise.withResolvers<void>(), abort = () => stopped.resolve();
    signal.addEventListener("abort", abort, { once: true });
    try {
      yield `history:${service.id}:${lines}\n`;
      await Promise.race([live.promise, stopped.promise]);
      if (!signal.aborted) { yield "live token=fixture-secret\n"; await stopped.promise; }
    } finally { signal.removeEventListener("abort", abort); cancelled.resolve(); }
  })();
  const controller = new AbortController(); t.after(() => controller.abort());
  const logs = followLogs(f.config.socket, query(wt, "web", { follow: "true", lines: "2" }), controller.signal)[Symbol.asyncIterator]();
  const service = f.manager.service(await f.manager.context(wt), "web");
  assert.equal((await logs.next()).value, `history:${service.id}:2\n`);
  live.resolve(); assert.equal((await logs.next()).value, "live token=[redacted]\n");
  assert.equal((await client(f.config.socket, "GET", "/v1/status")).services.length, 4);
  const waiting = logs.next(); controller.abort(); assert.equal((await waiting).done, true);
  await cancelled.promise;
  assert.equal(f.driver.stops.length, 0);
  assert.ok((await f.manager.inventory()).services.every(service => service.observed.ready));
});

test("socket log validation precedes streaming and browser origins are rejected", async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project);
  assert.deepEqual(await client(f.config.socket, "GET", query(f.project)), { logs: "fixture log" });
  assert.deepEqual(await client(f.config.socket, "GET", query(f.project, "web", { follow: "false", lines: "0" })), { logs: "fixture log" });
  for (const extra of [{ follow: "yes" }, { follow: "true", lines: "-1" }, { lines: "10001" }]) await assert.rejects(client(f.config.socket, "GET", query(f.project, "web", extra)), { status: 400 });
  await assert.rejects(collect(followLogs(f.config.socket, query(f.project, "missing", { follow: "true" }), new AbortController().signal)), /Unknown service/);
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: f.config.socket, path: query(f.project, "web", { follow: "true" }), headers: { Origin: "http://localhost" } }, res => {
      assert.equal(res.statusCode, 403); res.resume(); res.once("end", resolve);
    }); req.once("error", reject); req.end();
  });
  assert.equal(daemon.logStreams.size, 0);
});

test("stream errors reach clients and daemon shutdown cancels idle streams", { timeout: 5000 }, async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project);
  f.driver.followLogs = async () => (async function* () { yield "first\n"; throw new Problem("reader failed token=fixture-secret"); })();
  await assert.rejects(collect(followLogs(f.config.socket, query(f.project, "web", { follow: "true" }), new AbortController().signal)), /reader failed token=\[redacted\]/);
  const prepared = Promise.withResolvers<void>(); let cancelled = false;
  f.driver.followLogs = async (_service, _state, signal) => (async function* () {
    prepared.resolve();
    try { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }
    finally { cancelled = true; }
  })();
  const logs = followLogs(f.config.socket, query(f.project, "web", { follow: "true", lines: "0" }), new AbortController().signal)[Symbol.asyncIterator]();
  const waiting = logs.next(); await prepared.promise;
  await daemon.close(); assert.equal((await waiting).done, true);
  assert.equal(cancelled, true); assert.equal(daemon.logStreams.size, 0);
  assert.equal(f.driver.stops.length, 0);
});

test("CLI follows text or NDJSON with short flags and Ctrl+C cancels its subscription", { timeout: 5000 }, async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  const service = f.manager.service(await f.manager.context(wt), "web");
  for (const json of [false, true]) {
    const cancelled = Promise.withResolvers<void>();
    f.driver.followLogs = async (service, _state, signal, lines) => (async function* () {
      try {
        yield `${service.id}:${lines} token=fixture-secret\n`;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally { cancelled.resolve(); }
    })();
    const child = spawn(process.execPath, [cliPath, "logs", "web", "-f", "-n", "3", "--path", wt, ...(json ? ["--json"] : [])], { env: { ...process.env, ENCARGADO_HOME: f.config.stateDir }, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close"); t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const output = createInterface({ input: child.stdout });
    const first = (await output[Symbol.asyncIterator]().next()).value!;
    assert.equal(json ? JSON.parse(first).logs : first + "\n", `${service.id}:3 token=[redacted]\n`);
    child.kill("SIGINT"); assert.deepEqual(await closed, [0, null]); output.close(); await cancelled.promise;
  }
  const cli = (...args: string[]) => checked(run, { file: process.execPath, args: [cliPath, ...args, "--path", wt], env: { ...process.env, ENCARGADO_HOME: f.config.stateDir } });
  assert.deepEqual(JSON.parse(await cli("logs", "web", "--json", "--lines", "1")), { logs: "fixture log" });
  await assert.rejects(cli("status", "--follow"), /--follow applies only to logs/);
  await assert.rejects(cli("logs", "web", "--lines=-1"), /lines must/);
  assert.equal(f.driver.stops.length, 0);
});
