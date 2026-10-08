import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, manifest } from "./helpers.ts";
import { Manager } from "../src/manager.ts";
import { Daemon, client } from "../src/server.ts";
import { checked, run } from "../src/util.ts";

test("configuration is a side-effect-free, secret-free view of the selected worktree and survives reload", async t => {
  const raw = manifest();
  raw.services.web.environment = { PRIVATE_TOKEN: "fixture-secret" };
  raw.services.web.urls = ["office", "proposals"];
  const f = await fixture(raw); t.after(f.close);
  await assert.rejects(f.manager.configuration(f.project), /not registered/);
  await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  await mkdir(join(wt, "nested"));
  const before = await readFile(join(f.config.stateDir, "registry.json"), "utf8");
  const first = await f.manager.configuration(f.project), second = await f.manager.configuration(join(wt, "nested"));
  assert.equal(first.project.id, second.project.id);
  assert.notEqual(first.checkout.id, second.checkout.id);
  assert.notEqual(first.services.postgres.ports.database, second.services.postgres.ports.database);
  assert.equal(await f.manager.get(wt, "web.urls.office"), `http://office.localhost:${second.services.web.ports.http}`);
  assert.equal(f.driver.starts.length, 0);
  assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), before);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_TOKEN|fixture-secret|environmentFiles/);
  await f.manager.expose(wt, "web");
  // Alias lookup is independent of the order in which endpoints are stored.
  const web = f.manager.service(await f.manager.context(wt), "web");
  web.endpoints.reverse(); await f.manager.save();
  assert.equal(await f.manager.get(wt, "web.urls.office"), web.endpoints.find(endpoint => endpoint.name === "office")!.url);
  const recovered = new Manager(f.config, f.manager.runner, undefined, f.manager.drivers, f.routes);
  await recovered.load();
  assert.deepEqual(await recovered.configuration(wt), await f.manager.configuration(wt));
  for (const key of ["__proto__", "web.constructor", "web.environment.PRIVATE_TOKEN", "missing.ports.http"]) {
    await assert.rejects(f.manager.get(wt, key));
  }
});

test("configuration returns the canonical allocation for a shared dependency", async t => {
  const f = await fixture(manifest(true)); t.after(f.close);
  await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  assert.equal(await f.manager.get(f.project, "postgres.ports.database"), await f.manager.get(wt, "postgres.ports.database"));
});

test("dev provisions aliases before startup reads the API, retries public readiness, and reuses concurrent starts", async t => {
  const raw = manifest(); raw.services.web.urls = ["office", "proposals"];
  const f = await fixture(raw), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start();
  const start = f.driver.start.bind(f.driver);
  f.driver.start = async service => {
    if (service.name === "web") {
      const facts = await client(f.config.socket, "GET", "/v1/context?path=" + encodeURIComponent(f.project));
      assert.match(facts.services.web.urls.office, /^https:\/\//);
      assert.equal(f.routes.targets.get(service.id), "http://127.0.0.1:" + f.manager.landingPort);
    }
    await start(service);
  };
  let attempts = 0;
  const verify = f.manager.verify.bind(f.manager);
  f.manager.verify = async (path, name) => {
    attempts++;
    const web = f.manager.service(await f.manager.context(path), name!);
    // The fake routes do not resolve in DNS. Exercise local readiness with the
    // actual HTTP fixture, then simulate one pending public advertisement.
    const endpoints = web.endpoints; web.endpoints = [];
    const result = await verify(path, name); web.endpoints = endpoints;
    result[0].ready &&= attempts > 1;
    return result;
  };
  const [first, second] = await Promise.all([f.manager.dev(f.project), f.manager.dev(f.project)]);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
  assert.equal(first.verification[0].ready, true);
  assert.equal(second.verification[0].ready, true);
  assert.equal(attempts, 3);
  assert.equal(first.services.find(service => service.name === "web")!.urls.filter(url => url.scope === "tailnet").length, 2);
});

test("local dev works without gateway settings and leaves another worktree running", async t => {
  const f = await fixture(); t.after(f.close);
  f.config.tailscale = undefined;
  await f.manager.dev(f.project, { local: true });
  const wt = await f.worktree();
  const result = await f.manager.dev(wt, { service: "web", local: true });
  assert.equal(result.verification[0].ready, true);
  assert.equal(result.services.find(service => service.name === "web")!.urls.length, 1);
  assert.deepEqual(f.driver.starts, ["postgres", "web", "postgres", "web"]);
  assert.equal(f.driver.stops.length, 0);
});

test("dev reports route and readiness failures, and protects running recipes and origins", async t => {
  const f = await fixture(); t.after(f.close);
  f.routes.fail = true;
  await assert.rejects(f.manager.dev(f.project), /Route unavailable/);
  assert.equal(f.driver.starts.length, 0);
  f.routes.fail = false; f.driver.responseStatus = 503;
  await assert.rejects(f.manager.dev(f.project), /readiness timed out/);
  assert.deepEqual(f.driver.stops, ["web"]);
  assert.equal((await f.manager.inventory()).services.find(service => service.name === "postgres")!.observed.ready, true);
  f.driver.responseStatus = 200;
  await f.manager.unexpose(f.project, "web");
  await f.manager.dev(f.project, { local: true });
  await assert.rejects(f.manager.dev(f.project), /stop the service before.*URLs/);
  const changed = manifest(); changed.services.web.command = ["mix", "run", "--no-halt"];
  await writeFile(join(f.project, "encargado.json"), JSON.stringify(changed));
  await assert.rejects(f.manager.dev(f.project, { local: true }), /stop the service before changing its recipe/);
});

test("dev bounds public verification retries and retains an otherwise healthy application", async t => {
  const f = await fixture(); t.after(f.close);
  f.manager.verify = async () => [{ service: "fixture", name: "web", localReady: true, websocketConfigured: false, endpoints: [], ready: false }];
  await assert.rejects(f.manager.dev(f.project), /URL verification timed out/);
  assert.equal(f.driver.stops.length, 0);
  assert.equal((await f.manager.inventory()).services.find(service => service.name === "web")!.observed.ready, true);
});

test("CLI and Unix API share configuration selectors and the development operation", async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start();
  await assert.rejects(client(f.config.socket, "POST", "/v1/dev", { path: f.project, local: "yes" }), /local must be a boolean/);
  const result = await client(f.config.socket, "POST", "/v1/dev", { path: f.project, service: "web", local: true });
  assert.equal(result.verification[0].ready, true);
  const cli = async (...args: string[]) => checked(run, { file: process.execPath, args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args, "--path", f.project], env: { ...process.env, ENCARGADO_HOME: f.config.stateDir } });
  const port = await f.manager.get(f.project, "postgres.ports.database");
  assert.equal(await cli("get", "postgres.ports.database"), port + "\n");
  assert.equal(JSON.parse(await cli("get", "postgres.ports.database", "--json")), port);
  assert.deepEqual(JSON.parse(await cli("context")), await f.manager.configuration(f.project));
  assert.equal(Number(await checked(run, { file: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "get", "postgres.ports.database", "--path", f.project],
    env: { ...process.env, ENCARGADO_HOME: undefined, ENCARGADO_SOCKET: f.config.socket },
  })), port);
  assert.equal(JSON.parse(await cli("dev", "web", "--local", "--json")).verification[0].ready, true);
  await assert.rejects(cli("get", "web.environment"), /Unknown configuration key/);
});
