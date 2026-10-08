import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { ComposeDriver, environment, SystemdDriver } from "../src/drivers.ts";
import { validateManifest } from "../src/manifest.ts";
import { TailscaleRoutes } from "../src/routes.ts";
import { readJson } from "../src/util.ts";
import type { Command } from "../src/model.ts";

test("manifest rejects cycles, missing dependencies, typos, and shared-to-private dependencies", () => {
  assert.throws(() => validateManifest({ version: 1, project: { name: "app" }, services: { a: { driver: "elixir", dependsOn: ["b"] }, b: { driver: "elixir", dependsOn: ["a"] } } }), /cycle/);
  assert.throws(() => validateManifest({ version: 1, project: { name: "app" }, services: { a: { driver: "elixir", dependsOn: ["missing"] } } }), /unknown dependency/);
  assert.throws(() => validateManifest({ version: 1, project: { name: "app" }, services: { a: { driver: "elixir", scopes: "project" } } }), /unknown field/);
  assert.throws(() => validateManifest({ version: 1, project: { name: "app" }, services: { a: { driver: "elixir", scope: "project", dependsOn: ["b"] }, b: { driver: "elixir" } } }), /Project-shared/);
  assert.throws(() => validateManifest({ version: 1, project: { name: "app" }, services: { "a-b": { driver: "compose", ports: { c: 5432 } }, a: { driver: "compose", ports: { b_c: 6379 } } } }), /duplicate environment variables/);
});
test("environment resolves allocated dependency ports and prevents manifest overrides of runtime bindings", async t => {
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project);
  const web = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  const db = Object.values(f.manager.state.services).find(s => s.name === "postgres")!;
  web.spec.environment = { DATABASE_URL: "postgres://127.0.0.1:" + "$" + "{ENCARGADO_POSTGRES_DATABASE_PORT}/app", PORT: "9999", HOST: "0.0.0.0" };
  await writeFile(join(f.project, ".env"), "PASSWORD=private-value\n");
  web.spec.environmentFiles = [".env"];
  const env = await environment(web, f.manager.state, f.config);
  assert.equal(env.ENCARGADO_SOCKET, f.config.socket);
  assert.equal(env.DATABASE_URL, "postgres://127.0.0.1:" + db.ports.database + "/app");
  assert.equal(env.PORT, String(web.ports.http));
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PASSWORD, "private-value");
  assert.doesNotMatch(JSON.stringify(await f.manager.inventory()), /private-value/);
});
test("Compose rejects fixed/public ports and shared storage before launching anything", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const db = Object.values(f.manager.state.services).find(s => s.name === "postgres")!;
  const config: any = { services: { postgres: {
    ports: [{ target: 5432, published: String(db.ports.database), host_ip: "127.0.0.1", protocol: "tcp" }],
    healthcheck: { test: ["CMD", "pg_isready"] }, volumes: [{ type: "volume", source: "data", target: "/data" }],
  } }, volumes: { data: { name: db.composeProject + "_data" } } };
  const calls: Command[] = [];
  const driver = new ComposeDriver(async command => { calls.push(command); return { code: 0, stdout: JSON.stringify(config), stderr: "" }; }, f.config);
  await driver.validate(db, f.manager.state);
  config.services.postgres.ports[0].host_ip = "0.0.0.0";
  await assert.rejects(driver.validate(db, f.manager.state), /Compose ports/);
  config.services.postgres.ports[0].host_ip = "127.0.0.1";
  config.volumes.data.name = "shared";
  await assert.rejects(driver.validate(db, f.manager.state), /volume must be namespaced/);
  assert.ok(calls.every(c => c.args.includes("config")));
  assert.ok(calls.every(c => c.args.includes(db.composeProject)));
});
test("systemd startup passes environment through a private launch file, never command arguments", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const web = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  web.spec.environment = { PRIVATE_TOKEN: "test-secret" };
  const calls: Command[] = [];
  const driver = new SystemdDriver(async command => { calls.push(command); return { code: 0, stdout: "", stderr: "" }; }, f.config);
  await driver.start(web, f.manager.state);
  assert.equal(calls[0].file, "systemd-run");
  assert.doesNotMatch(JSON.stringify(calls), /test-secret/);
  assert.equal((await readJson(join(f.config.stateDir, "launch", web.id + ".json"))).env.PRIVATE_TOKEN, "test-secret");
});
test("file-based routes preserve unrelated gateway entries and use only registered service advertisements", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const web = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  const path = join(f.root, "serve.json");
  const other = { Services: { "svc:production": { TCP: { "443": { HTTPS: true } }, Web: { "prod.test.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } } }, TCP: { "8443": { HTTPS: true } } };
  await writeFile(path, JSON.stringify(other));
  f.config.tailscale!.serveConfigFile = path;
  const calls: Command[] = [];
  const routes = new TailscaleRoutes(f.config, async command => { calls.push(command); return { code: 0, stdout: "", stderr: "" }; });
  web.endpoints = routes.endpoints(web, "sample");
  await routes.apply(web, "http://127.0.0.1:17870");
  let config = await readJson(path);
  assert.deepEqual(config.Services["svc:production"], other.Services["svc:production"]);
  assert.deepEqual(config.TCP, other.TCP);
  assert.ok(calls.every(c => c.args[1] === "advertise"));
  await routes.remove(web);
  config = await readJson(path);
  assert.deepEqual(config, other);
  assert.ok(calls.every(c => !c.args.includes("reset") && !c.args.includes("--all")));
});
test("URL names are distinct per worktree and a foreign path on a managed service is preserved", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const first = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  const wt = await f.worktree(); await f.manager.register(wt);
  const second = Object.values(f.manager.state.services).find(s => s.name === "web" && s.id !== first.id)!;
  let config: any = {};
  const routes = new TailscaleRoutes(f.config, async () => ({ code: 0, stdout: JSON.stringify(config), stderr: "" }));
  first.endpoints = routes.endpoints(first, "sample"); second.endpoints = routes.endpoints(second, "sample");
  assert.notEqual(first.endpoints[0].hostname, second.endpoints[0].hostname);
  config = {
    Services: {
      [first.endpoints[0].serviceName]: {
        TCP: { "443": { HTTPS: true } },
        Web: { [first.endpoints[0].hostname + ":443"]: { Handlers: { "/other": { Proxy: "http://127.0.0.1:8000" } } } },
      },
    },
  };
  await assert.rejects(routes.apply(first, "http://127.0.0.1:17870"), /additional routes/);
});

test("Tailscale provisioning creates the exact Service and caches successful lookups", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const web = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  f.config.tailscale!.apiTokenEnv = "ENCARGADO_TEST_API_TOKEN";
  process.env.ENCARGADO_TEST_API_TOKEN = "tskey-api-fixture-only";
  t.after(() => { delete process.env.ENCARGADO_TEST_API_TOKEN; });
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(init?.method === "PUT" ? "{}" : "", { status: init?.method === "PUT" ? 200 : 404 });
  });
  const routes = new TailscaleRoutes(f.config, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  const endpoint = routes.endpoints(web, "sample")[0];
  await routes.provision(endpoint);
  await routes.provision(endpoint);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.tailscale.com/api/v2/tailnet/-/vip-services/" + encodeURIComponent(endpoint.serviceName));
  assert.match((calls[0].init!.headers as Record<string, string>).Authorization, /^Basic /);
  assert.deepEqual(JSON.parse(calls[1].init!.body as string).ports, ["tcp:443"]);
  assert.equal(JSON.parse(calls[1].init!.body as string).name, endpoint.serviceName);
});
