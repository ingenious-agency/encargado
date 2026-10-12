import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, manifest } from "./helpers.ts";
import { Manager } from "../src/manager.ts";
import { TailscaleRoutes } from "../src/routes.ts";
import { checked, hash, readJson, run } from "../src/util.ts";
import type { Command } from "../src/model.ts";

async function namedRoutes(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, "serve.json"), calls: Command[] = [];
  await writeFile(path, JSON.stringify({ Services: {} }));
  f.config.tailscale!.serveConfigFile = path;
  const routes = new TailscaleRoutes(f.config, async command => {
    calls.push(command);
    return { code: 0, stdout: "{}", stderr: "" };
  });
  f.manager.routes = routes;
  return { path, routes, calls };
}

function localVerification(manager: Manager) {
  // These disposable gateway routes have no DNS. Keep the real local probe,
  // and simulate successful public verification for the dev operation.
  manager.verify = async (path, name) => {
    const service = manager.service(await manager.context(path), name!);
    const observed = await manager.observe(service);
    return [{ service: service.id, name: service.name, localReady: observed.ready,
      websocketConfigured: false, endpoints: [], ready: observed.ready }];
  };
}

test("new URLs use normalized worktree directory names and valid bounded DNS labels", async t => {
  const raw = manifest(); raw.services.web.urls = ["office", "proposals"];
  const f = await fixture(raw); t.after(f.close);
  const { routes } = await namedRoutes(f);
  await f.manager.register(f.project);
  const web = f.manager.service(await f.manager.context(f.project), "web");
  const endpoints = routes.endpoints(web, "sample");
  assert.deepEqual(endpoints.map(endpoint => endpoint.url), [
    "https://enc-sample-office-project.test.ts.net",
    "https://enc-sample-proposals-project.test.ts.net",
  ]);
  assert.equal(endpoints[0].serviceName, "svc:enc-sample-office-project");
  assert.equal(routes.endpoints({ ...web, cwd: join(f.root, "Feature_One") }, "sample")[0].hostname,
    "enc-sample-office-feature-one.test.ts.net");
  assert.equal(routes.endpoints({ ...web, cwd: join(f.root, "----") }, "sample")[0].hostname,
    "enc-sample-office-project.test.ts.net");
  web.spec.urls = ["abcdefghijklmno-other"];
  const long = routes.endpoints({ ...web, cwd: join(f.root, "a".repeat(23) + "-truncated") }, "a".repeat(14) + "-project")[0];
  const label = long.hostname.split(".")[0];
  assert.ok(label.length <= 63);
  assert.match(label, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  assert.equal(label, "enc-" + "a".repeat(14) + "-abcdefghijklmno-" + "a".repeat(23));
});

test("URLs and service allocations survive commits, branch switches, detached HEAD, and reload", async t => {
  const f = await fixture(); t.after(f.close);
  const { path, routes } = await namedRoutes(f);
  await f.manager.register(f.project);
  const wt = await f.worktree(); await f.manager.register(wt);
  await Promise.all([f.manager.expose(f.project, "web"), f.manager.expose(wt, "web"), f.manager.expose(wt, "web")]);
  localVerification(f.manager); await f.manager.dev(wt);
  const web = f.manager.service(await f.manager.context(wt), "web");
  const before = structuredClone(web), configBefore = await readFile(path, "utf8");
  assert.equal(web.endpoints[0].hostname, "enc-sample-web-feature.test.ts.net");
  const git = (...args: string[]) => checked(run, { file: "git", args: ["-C", wt, ...args] });
  const head = await git("rev-parse", "HEAD");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "new worktree commit");
  assert.notEqual(await git("rev-parse", "HEAD"), head);
  await f.manager.register(wt); await f.manager.dev(wt);
  await git("switch", "-c", "renamed-branch");
  await f.manager.register(wt); await f.manager.dev(wt);
  await git("switch", "--detach", "HEAD");
  await f.manager.register(wt); await f.manager.dev(wt);
  assert.deepEqual(f.manager.service(await f.manager.context(wt), "web"), before);
  assert.equal(await readFile(path, "utf8"), configBefore);
  const recovered = new Manager(f.config, run, undefined, f.manager.drivers, routes);
  await recovered.load(); await recovered.reconcile(); localVerification(recovered); await recovered.dev(wt);
  assert.equal(await recovered.get(wt, "web.urls.web"), before.endpoints[0].url);
  assert.deepEqual(recovered.service(await recovered.context(wt), "web").ports, before.ports);
  assert.equal(await readFile(path, "utf8"), configBefore);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
});

test("shared HTTP services use the main checkout name regardless of which worktree exposes first", async t => {
  const raw = manifest(); raw.services.web.scope = "project"; raw.services.web.dependsOn = [];
  const f = await fixture(raw); t.after(f.close);
  const { path } = await namedRoutes(f);
  const wt = await f.worktree(); await f.manager.register(wt); await f.manager.expose(wt, "web");
  const web = f.manager.service(await f.manager.context(wt), "web");
  assert.equal(web.endpoints[0].hostname, "enc-sample-web-project.test.ts.net");
  await f.manager.register(f.project); await f.manager.expose(f.project, "web");
  assert.equal(f.manager.service(await f.manager.context(f.project), "web").id, web.id);
  assert.equal(Object.keys((await readJson(path)).Services).length, 1);
});

test("colliding directory names are rejected before claiming URLs or launching services", async t => {
  const f = await fixture(); t.after(f.close);
  const { path, calls } = await namedRoutes(f);
  const wt = await f.worktree(); await f.manager.register(wt); await f.manager.expose(wt, "web");
  const configBefore = await readFile(path, "utf8");
  for (const duplicate of [join(f.root, "nested", "feature"), join(f.root, "FEATURE")]) {
    await mkdir(join(f.root, "nested"), { recursive: true });
    await checked(run, { file: "git", args: ["-C", f.project, "worktree", "add", "--detach", duplicate, "HEAD"] });
    await f.manager.register(duplicate);
    const registryBefore = await readFile(join(f.config.stateDir, "registry.json"), "utf8"), callCount = calls.length;
    await assert.rejects(f.manager.expose(duplicate, "web"), /URL name collision/);
    await assert.rejects(f.manager.dev(duplicate), /URL name collision/);
    assert.equal(calls.length, callCount);
    assert.deepEqual(f.manager.service(await f.manager.context(duplicate), "web").endpoints, []);
    assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), registryBefore);
  }
  assert.equal(await readFile(path, "utf8"), configBefore);
  assert.deepEqual(f.driver.starts, []);
});

test("separate repositories with the same project and checkout names cannot share a URL", async t => {
  const f = await fixture(); t.after(f.close);
  const other = await fixture(); t.after(other.close);
  const { path } = await namedRoutes(f);
  await f.manager.register(f.project); await f.manager.expose(f.project, "web");
  const configBefore = await readFile(path, "utf8");
  await f.manager.register(other.project);
  await assert.rejects(f.manager.expose(other.project, "web"), /URL name collision/);
  assert.deepEqual(f.manager.service(await f.manager.context(other.project), "web").endpoints, []);
  assert.equal(await readFile(path, "utf8"), configBefore);
});

test("truncated aliases collide safely within a service and across planned dev exposures", async t => {
  for (const multipleServices of [false, true]) {
    const raw = manifest();
    raw.services.web.urls = ["abcdefghijklmno-one"];
    if (multipleServices) raw.services.other = { ...raw.services.web, urls: ["abcdefghijklmno-two"] };
    else raw.services.web.urls.push("abcdefghijklmno-two");
    const f = await fixture(raw); t.after(f.close);
    const { path, calls } = await namedRoutes(f);
    await f.manager.register(f.project);
    const registryBefore = await readFile(join(f.config.stateDir, "registry.json"), "utf8");
    if (!multipleServices) await assert.rejects(f.manager.expose(f.project, "web"), /URL name collision/);
    await assert.rejects(f.manager.dev(f.project), /URL name collision/);
    assert.deepEqual(calls, []);
    assert.deepEqual(f.driver.starts, []);
    assert.ok(Object.values(f.manager.state.services).every(service => !service.endpoints.length));
    assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), registryBefore);
    assert.deepEqual(await readJson(path), { Services: {} });
  }
});

test("concurrent conflicting exposures assign the URL to exactly one checkout", async t => {
  const f = await fixture(); t.after(f.close);
  const { path } = await namedRoutes(f);
  const wt = await f.worktree(), duplicate = join(f.root, "FEATURE");
  await checked(run, { file: "git", args: ["-C", f.project, "worktree", "add", "--detach", duplicate, "HEAD"] });
  await f.manager.register(wt); await f.manager.register(duplicate);
  const results = await Promise.allSettled([f.manager.expose(wt, "web"), f.manager.expose(duplicate, "web")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected");
  assert.ok(failed?.status === "rejected"); assert.match(failed.reason.message, /URL name collision/);
  assert.equal(Object.keys((await readJson(path)).Services).length, 1);
  assert.equal(Object.values(f.manager.state.services).filter(service => service.endpoints.length).length, 1);
});

test("legacy URLs persist through dev and recovery and migrate only after explicit unexpose", async t => {
  const f = await fixture(); t.after(f.close);
  const { path, routes } = await namedRoutes(f);
  await f.manager.register(f.project);
  const web = f.manager.service(await f.manager.context(f.project), "web");
  const label = "enc-sample-web-" + hash(web.id + "web").slice(0, 10), hostname = label + ".test.ts.net";
  const legacy = [{ name: "web", serviceName: "svc:" + label, hostname, url: "https://" + hostname }];
  web.endpoints = legacy; await f.manager.save();
  const unrelated = { TCP: { "443": { HTTPS: true } }, Web: { "production.test.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } };
  await writeFile(path, JSON.stringify({ Services: { "svc:production": unrelated } }));
  await f.manager.route(web, false);
  await f.manager.expose(f.project, "web");
  assert.deepEqual(web.endpoints, legacy);
  localVerification(f.manager); await f.manager.dev(f.project);
  const recovered = new Manager(f.config, run, undefined, f.manager.drivers, routes);
  await recovered.load(); await recovered.reconcile(); localVerification(recovered);
  await recovered.dev(f.project);
  const recoveredWeb = recovered.service(await recovered.context(f.project), "web");
  assert.deepEqual(recoveredWeb.endpoints, legacy);
  assert.deepEqual(f.driver.starts, ["postgres", "web"]);
  await recovered.stop(f.project); await recovered.unexpose(f.project, "web");
  assert.equal((await readJson(path)).Services[legacy[0].serviceName], undefined);
  await recovered.expose(f.project, "web");
  assert.equal(recoveredWeb.endpoints[0].hostname, "enc-sample-web-project.test.ts.net");
  assert.deepEqual(recoveredWeb.ports, web.ports); assert.equal(recoveredWeb.dataDir, web.dataDir);
  const config = await readJson(path);
  assert.deepEqual(config.Services["svc:production"], unrelated);
  assert.deepEqual(Object.keys(config.Services).sort(), ["svc:enc-sample-web-project", "svc:production"]);
});

for (const mode of ["file", "cli"] as const) {
  test(mode + " exposure refuses existing unregistered Services and hostnames before any mutation", async t => {
    const raw = manifest(); raw.services.web.urls = ["web", "other"];
    const f = await fixture(raw); t.after(f.close); await f.manager.register(f.project);
    const path = join(f.root, "serve.json"), calls: Command[] = [];
    if (mode === "file") f.config.tailscale!.serveConfigFile = path;
    let config: any = {};
    const routes = new TailscaleRoutes(f.config, async command => {
      calls.push(command); return { code: 0, stdout: JSON.stringify(config), stderr: "" };
    });
    f.manager.routes = routes;
    const web = f.manager.service(await f.manager.context(f.project), "web"), endpoint = routes.endpoints(web, "sample")[1];
    const foreign = { TCP: { "443": { HTTPS: true } }, Web: { [endpoint.hostname + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } };
    for (const existing of [
      { Services: { [endpoint.serviceName]: foreign } },
      { Services: { "svc:unrelated": foreign } },
      { Web: foreign.Web },
    ]) {
      config = existing; const before = JSON.stringify(config); await writeFile(path, before); calls.length = 0;
      const registryBefore = await readFile(join(f.config.stateDir, "registry.json"), "utf8");
      await assert.rejects(f.manager.expose(f.project, "web"), /already exists.*without this registration/);
      await assert.rejects(f.manager.dev(f.project), /already exists.*without this registration/);
      assert.ok(calls.every(command => command.args[1] === "status"));
      assert.equal(mode === "file" ? await readFile(path, "utf8") : JSON.stringify(config), before);
      assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), registryBefore);
      assert.deepEqual(web.endpoints, []); assert.deepEqual(f.driver.starts, []);
    }
  });
}
