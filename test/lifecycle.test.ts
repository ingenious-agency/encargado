import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, manifest } from "./helpers.ts";
import { Manager } from "../src/manager.ts";

test("concurrent registration is idempotent and worktrees get separate namespaces, ports, and data", async t => {
  const f = await fixture(); t.after(f.close);
  const [a, b] = await Promise.all([f.manager.register(f.project), f.manager.register(f.project)]);
  assert.deepEqual(a, b);
  const wt = await f.worktree();
  const second = await f.manager.register(wt);
  assert.equal(second.projects[0].id, a.projects[0].id);
  assert.notEqual(second.checkouts[0].id, a.checkouts[0].id);
  const all = Object.values(f.manager.state.services);
  assert.equal(new Set(all.flatMap(s => Object.values(s.ports))).size, 4);
  assert.equal(new Set(all.map(s => s.composeProject)).size, 2);
  assert.equal(new Set(all.map(s => s.dataDir)).size, 2);
});
test("deps up excludes the application; concurrent up starts each process once; stop preserves dependencies", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project);
  await f.manager.up(f.project, { depsOnly: true });
  assert.deepEqual(f.driver.starts, ["postgres"]);
  await Promise.all([f.manager.up(f.project), f.manager.up(f.project)]);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
  await assert.rejects(f.manager.stop(f.project, { depsOnly: true }), /still needed/);
  await f.manager.stop(f.project);
  assert.deepEqual(f.driver.stops, ["web"]);
  await f.manager.stop(f.project, { depsOnly: true });
  assert.deepEqual(f.driver.stops, ["web", "postgres"]);
});
test("shared dependencies are reused and protected while another worktree uses them", async t => {
  const f = await fixture(manifest(true)); t.after(f.close);
  await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  assert.equal(Object.values(f.manager.state.services).filter(s => s.name === "postgres").length, 1);
  await f.manager.up(f.project); await f.manager.up(wt);
  assert.equal(f.driver.starts.filter(n => n === "postgres").length, 1);
  await f.manager.stop(f.project);
  await assert.rejects(f.manager.stop(f.project, { service: "postgres" }), /still needed/);
  await f.manager.stop(wt);
  await assert.rejects(f.manager.stop(wt, { depsOnly: true }), /explicitly/);
  await f.manager.stop(wt, { service: "postgres" });
});
test("failed readiness cleans up the new app, preserves healthy dependencies, and records a useful failure", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project);
  f.driver.responseStatus = 503;
  await assert.rejects(f.manager.up(f.project), /readiness timed out/);
  assert.deepEqual(f.driver.stops, ["web"]);
  const inventory = await f.manager.inventory();
  assert.equal(inventory.services.find(s => s.name === "postgres")!.observed.ready, true);
  assert.match(inventory.services.find(s => s.name === "web")!.lastError!, /readiness/);
});
test("dependency launch failure prevents the application launch", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project); f.driver.failService = "postgres";
  await assert.rejects(f.manager.up(f.project), /launch failed/);
  assert.deepEqual(f.driver.starts, ["postgres"]);
});
test("registry reload recovers running services and persistent endpoints without respawning them", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project); await f.manager.expose(f.project, "web"); await f.manager.up(f.project);
  const recovered = new Manager(f.config, f.manager.runner, undefined, f.manager.drivers, f.routes);
  await recovered.load(); await recovered.reconcile(); await recovered.up(f.project);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
  const web = Object.values(recovered.state.services).find(s => s.name === "web")!;
  assert.equal(f.routes.targets.get(web.id), "http://127.0.0.1:" + web.ports.http);
  await f.driver.stop(web); await recovered.reconcile();
  assert.equal(web.status, "failed");
  assert.equal(f.routes.targets.get(web.id), "http://127.0.0.1:0");
});
test("changing a running recipe fails atomically and route failures are visible", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project); await f.manager.up(f.project);
  const before = await readFile(join(f.config.stateDir, "registry.json"), "utf8");
  const changed = manifest(); changed.services.web.command = ["mix", "run", "--no-halt"];
  await writeFile(join(f.project, "encargado.json"), JSON.stringify(changed));
  await assert.rejects(f.manager.register(f.project), /stop the service/);
  assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), before);
  await f.manager.stop(f.project); f.routes.fail = true;
  const exposed = await f.manager.expose(f.project, "web");
  assert.match(exposed.services.find(s => s.name === "web")!.routeError!, /Route unavailable/);
});
test("unregister requires stopped owned services and never deletes their data", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project); await f.manager.up(f.project);
  await assert.rejects(f.manager.unregister(f.project), /Stop all/);
  await f.manager.stop(f.project); await f.manager.stop(f.project, { depsOnly: true });
  const service = Object.values(f.manager.state.services)[0];
  await writeFile(join(service.dataDir, "sentinel"), "retain");
  await f.manager.unregister(f.project);
  assert.equal(await readFile(join(service.dataDir, "sentinel"), "utf8"), "retain");
  assert.equal(Object.keys(f.manager.state.services).length, 0);
});
