import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
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
