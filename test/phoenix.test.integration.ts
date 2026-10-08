import test from "node:test";
import assert from "node:assert/strict";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.ts";
import { Manager } from "../src/manager.ts";
import { checked, run } from "../src/util.ts";
import { websocketUpgrade } from "../src/probe.ts";

test("Phoenix starts under systemd with correct origins and a working WebSocket endpoint", { timeout: 300000 }, async t => {
  const f = await fixture({ version: 1, project: { name: "phoenix-fixture" }, services: { web: {
    driver: "elixir", command: ["mise", "exec", "--", "mix", "phx.server"],
    ready: { path: "/", statuses: [200], timeout: 120, websocketPath: "/socket/websocket?vsn=2.0.0" },
  } } });
  const manager = new Manager(f.config, run);
  t.after(async () => { for (const s of Object.values(manager.state.services)) await run({ file: "systemctl", args: ["--user", "stop", s.unit] }); await f.close(); });
  await cp(fileURLToPath(new URL("./fixtures/phoenix/", import.meta.url)), f.project, { recursive: true });
  await checked(run, { file: "mise", args: ["exec", "--", "mix", "deps.get"], cwd: f.project, timeout: 180000 });
  await manager.register(f.project);
  const result = await manager.up(f.project);
  const service = result.services[0];
  assert.equal(service.observed.ready, true);
  assert.equal((await manager.verify(f.project))[0].ready, true);
  assert.equal(await websocketUpgrade("http://127.0.0.1:" + service.ports.http + "/socket/websocket?vsn=2.0.0", "https://untrusted.example"), false);
  await manager.stop(f.project);
});
