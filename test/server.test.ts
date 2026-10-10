import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture } from "./helpers.ts";
import { Daemon, client } from "../src/server.ts";
import { Manager } from "../src/manager.ts";
import { request } from "node:http";

function get(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, async res => {
      const parts: Buffer[] = []; for await (const chunk of res) parts.push(chunk);
      resolve({ status: res.statusCode!, text: Buffer.concat(parts).toString() });
    });
    req.on("error", reject); req.end();
  });
}

test("Unix API, stopped page, CSRF validation, successful start, and CLI inventory share one manager", async t => {
  const f = await fixture(); const daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start();
  assert.equal((await stat(f.config.socket)).mode & 0o777, 0o600);
  await assert.rejects(client(f.config.socket, "POST", "/v1/register", null), /body must be an object/);
  await assert.rejects(client(f.config.socket, "POST", "/v1/register", { path: f.project, manifest: 42 }), /manifest must/);
  const registered = await client(f.config.socket, "POST", "/v1/register", { path: f.project });
  const web = registered.services.find((s: any) => s.name === "web");
  const url = web.urls[0].url;
  const stopped = await fetch(url);
  assert.equal(stopped.status, 503);
  const page = await stopped.text(), token = /name="token" value="([^"]+)"/.exec(page)![1];
  const endpoint = url + "/start", origin = new URL(url).origin;
  const rejected = await fetch(endpoint, { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(rejected.status, 403); await rejected.text();
  assert.equal(f.driver.starts.length, 0);
  const accepted = await fetch(endpoint, { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(accepted.status, 303); await accepted.text();
  await f.manager.queue.execute(async () => {});
  const ready = await fetch(url, { redirect: "manual" });
  assert.equal(ready.status, 302); await ready.text();
  const inventory = await client(f.config.socket, "GET", "/v1/status?path=" + encodeURIComponent(f.project));
  assert.equal(inventory.services.find((s: any) => s.name === "web").observed.ready, true);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
});
test("second daemon cannot take the first daemon's registry or socket", async t => {
  const f = await fixture(); const daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start();
  const other = new Daemon(new Manager(f.config, f.manager.runner));
  await assert.rejects(other.start(), /already running/);
  assert.equal((await client(f.config.socket, "GET", "/v1/status")).version, 1);
});
test("concurrent daemons recover a stale lock in place and only one owns it", async t => {
  const f = await fixture();
  const daemons = Array.from({ length: 8 }, () => new Daemon(new Manager(f.config, f.manager.runner)));
  t.after(async () => { await Promise.all(daemons.map(d => d.close())); await f.close(); });
  const path = join(f.config.stateDir, "daemon.lock");
  await writeFile(path, "2147483647:stale", { mode: 0o600 });
  const inode = (await stat(path)).ino;
  const outcomes = await Promise.allSettled(daemons.map(d => d.lock()));
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  for (const outcome of outcomes) if (outcome.status === "rejected") assert.match(outcome.reason.message, /already running/);
  assert.equal((await stat(path)).ino, inode);
  const winner = daemons.find(d => d.ownsLock)!;
  await winner.close();
  assert.equal((await stat(path)).ino, inode);
  assert.equal(await readFile(path, "utf8"), "");
  const next = daemons.find(d => d !== winner)!;
  await next.lock();
  assert.equal(next.ownsLock, true);
  assert.equal((await stat(path)).ino, inode);
});
test("a killed daemon releases its lock without deleting the lock file", { timeout: 10000 }, async t => {
  const f = await fixture(), recovered = new Daemon(f.manager);
  const program = `
    import { Daemon } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
    import { Manager } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).href)};
    await new Daemon(new Manager(${JSON.stringify(f.config)})).lock();
    console.log("locked");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await recovered.close(); await f.close();
  });
  let output = "";
  for await (const chunk of child.stdout) { output += chunk; if (output.includes("locked\n")) break; }
  assert.match(output, /locked/);
  const path = join(f.config.stateDir, "daemon.lock"), inode = (await stat(path)).ino;
  await assert.rejects(recovered.lock(), /already running/);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await recovered.lock();
  assert.equal((await stat(path)).ino, inode);
  assert.equal(await readFile(path, "utf8"), recovered.lockToken);
});
test("daemon locking refuses symlinks and preserves a live legacy daemon's PID file", async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  const path = join(f.config.stateDir, "daemon.lock"), target = join(f.root, "unrelated");
  await writeFile(target, "unrelated data", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(daemon.lock(), { code: "ELOOP" });
  assert.equal(await readFile(target, "utf8"), "unrelated data");
  // Use another disposable state directory for compatibility with old PID locks.
  f.config.stateDir = join(f.root, "legacy");
  await mkdir(f.config.stateDir);
  const legacy = join(f.config.stateDir, "daemon.lock"), owner = process.pid + ":legacy";
  await writeFile(legacy, owner, { mode: 0o600 });
  await assert.rejects(daemon.lock(), /already running/);
  assert.equal(await readFile(legacy, "utf8"), owner);
});
test("failed daemon startup releases the lock for the next start", async t => {
  const f = await fixture(), daemon = new Daemon(f.manager), next = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await next.close(); await f.close(); });
  const load = t.mock.method(f.manager, "load", async () => { throw new Error("fixture load failure"); });
  await assert.rejects(daemon.start(), /fixture load failure/);
  load.mock.restore();
  await next.start();
  assert.equal((await client(f.config.socket, "GET", "/v1/status")).version, 1);
});
test("tailnet start requires an allowed identity and unknown hosts do not expose a start page", async t => {
  const f = await fixture(); const daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project); await f.manager.expose(f.project, "web");
  const service = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  const base = "http://127.0.0.1:" + f.manager.landingPort;
  const unknown = await get(base, { Host: "attacker.example" });
  assert.equal(unknown.status, 404);
  const untrusted = await get(base, { Host: service.endpoints[0].hostname });
  assert.doesNotMatch(untrusted.text, /<form/);
  const trusted = await get(base, { Host: service.endpoints[0].hostname, "Tailscale-User-Login": "owner@example.test" });
  assert.match(trusted.text, /<form/);
  const spoofed = await get(base + "/s/" + service.id, { Host: "127.0.0.1:" + f.manager.landingPort, "X-Forwarded-Proto": "https", "Tailscale-User-Login": "stranger@example.test" });
  assert.equal(spoofed.status, 404);
  assert.doesNotMatch(spoofed.text, /<form/);
});
