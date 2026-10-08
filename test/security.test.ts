import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { ComposeDriver, SystemdDriver } from "../src/drivers.ts";
import { streamCommand } from "../src/logs.ts";
import { Daemon, client, followLogs } from "../src/server.ts";
import { TailscaleRoutes } from "../src/routes.ts";
import { readJson } from "../src/util.ts";
import type { Command, StreamRunner } from "../src/model.ts";

test("Compose resolves bind symlinks and missing ancestors without creating host directories", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const db = f.manager.service(await f.manager.context(f.project), "postgres");
  const outside = join(f.root, "unrelated"), inside = join(f.project, "storage");
  await mkdir(outside); await mkdir(inside);
  await symlink(outside, join(f.project, "outside-link"));
  await symlink(inside, join(f.project, "inside-link"));
  await symlink(join(f.root, "missing-outside"), join(f.project, "dangling-link"));
  const mount = { type: "bind", source: inside, target: "/data" };
  const config = { services: { postgres: {
    ports: [{ target: 5432, published: String(db.ports.database), host_ip: "127.0.0.1", protocol: "tcp" }],
    healthcheck: { test: ["CMD", "pg_isready"] }, volumes: [mount],
  } } };
  const driver = new ComposeDriver(async command => {
    assert.ok(command.args.includes("config"), "validation must not start a container");
    return { code: 0, stdout: JSON.stringify(config), stderr: "" };
  }, f.config);
  for (const source of [inside, join(f.project, "inside-link"), join(f.project, "inside-link", "new", "nested"), join(db.dataDir, "new", "nested")]) {
    mount.source = source; await driver.validate(db, f.manager.state);
  }
  await assert.rejects(stat(db.dataDir), { code: "ENOENT" });
  await mkdir(db.dataDir, { recursive: true }); await symlink(outside, join(db.dataDir, "outside-link"));
  for (const source of [outside, join(f.project, "outside-link"), join(f.project, "outside-link", "new"), join(db.dataDir, "outside-link", "new")]) {
    mount.source = source; await assert.rejects(driver.validate(db, f.manager.state), /outside its checkout\/data directory/);
  }
  for (const source of [join(f.project, "dangling-link"), join(f.project, "dangling-link", "new")]) {
    mount.source = source; await assert.rejects(driver.validate(db, f.manager.state), /dangling symlink/);
  }
  await assert.rejects(stat(join(inside, "new")), { code: "ENOENT" });
  await assert.rejects(stat(join(db.dataDir, "new")), { code: "ENOENT" });
});

test("Compose accepts ordinary local volumes and rejects driver-backed host mounts", async t => {
  const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
  const db = f.manager.service(await f.manager.context(f.project), "postgres");
  const config: any = { services: { postgres: {
    ports: [{ target: 5432, published: String(db.ports.database), host_ip: "127.0.0.1", protocol: "tcp" }],
    healthcheck: { test: ["CMD", "pg_isready"] }, volumes: [{ type: "volume", source: "data", target: "/data" }],
  } }, volumes: { data: { name: db.composeProject + "_data" } } };
  const driver = new ComposeDriver(async () => ({ code: 0, stdout: JSON.stringify(config), stderr: "" }), f.config);
  await driver.validate(db, f.manager.state);
  config.volumes.data.driver = "local"; config.volumes.data.driver_opts = {};
  await driver.validate(db, f.manager.state);
  config.volumes.data.driver_opts = { type: "none", o: "bind", device: f.root };
  await assert.rejects(driver.validate(db, f.manager.state), /ordinary local volumes without driver_opts/);
  delete config.volumes.data.driver_opts; config.volumes.data.driver = "custom-storage";
  await assert.rejects(driver.validate(db, f.manager.state), /ordinary local volumes without driver_opts/);
});

test("snapshot and streaming APIs redact authorization and quoted secrets for both drivers", { timeout: 5000 }, async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start(); await f.manager.register(f.project);
  const chunks = ['Authorization: Bea', 'rer fixture-bearer\nAuthorization: Basic fixture-basic\npassword="two ', 'words fixture-password"\n'];
  const expected = 'Authorization: [redacted]\nAuthorization: [redacted]\npassword="[redacted]"\n';
  const reader: StreamRunner = (command, signal) => streamCommand({
    file: process.execPath, args: ["-e", `const chunks = ${JSON.stringify(chunks)}; const timer = setInterval(() => { process.stdout.write(chunks.shift()); if (!chunks.length) clearInterval(timer); }, 10);`],
  }, signal);
  f.manager.drivers.elixir = new SystemdDriver(async command => ({ code: 0,
    stdout: command.file === "journalctl" ? chunks.join("") : "LoadState=not-found\n", stderr: "" }), f.config, reader);
  f.manager.drivers.compose = new ComposeDriver(async command => ({ code: 0,
    stdout: command.args[0] === "ps" ? "fixture-owned" : command.args[0] === "inspect" ? '{"id":"fixture-owned","status":"exited","ports":{}}' : chunks.join(""), stderr: "" }), f.config, reader);
  for (const service of ["web", "postgres"]) {
    const query = "/v1/logs?" + new URLSearchParams({ path: f.project, service });
    assert.equal((await client(f.config.socket, "GET", query)).logs, expected);
    let streamed = "";
    for await (const line of followLogs(f.config.socket, query + "&follow=true", new AbortController().signal)) streamed += line;
    assert.equal(streamed, expected);
  }
});

for (const mode of ["file", "cli"] as const) {
  test(mode + " route removal checks every alias before mutating and preserves drifted registrations", async t => {
    const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
    const web = f.manager.service(await f.manager.context(f.project), "web");
    web.spec.urls = ["web", "other"];
    const path = join(f.root, "serve.json"), calls: Command[] = [];
    if (mode === "file") f.config.tailscale!.serveConfigFile = path;
    let config: any;
    const routes = new TailscaleRoutes(f.config, async command => {
      calls.push(command);
      if (command.args[1] === "clear") delete config.Services[command.args[2]];
      return { code: 0, stdout: JSON.stringify(config), stderr: "" };
    });
    f.manager.routes = routes; web.endpoints = routes.endpoints(web, "sample");
    const endpoints = structuredClone(web.endpoints), second = endpoints[1];
    const base = { Services: Object.fromEntries(endpoints.map(endpoint => [endpoint.serviceName, {
      TCP: { "443": { HTTPS: true } }, Web: { [endpoint.hostname + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:17870" } } } },
    }])), TCP: { "9443": { HTTPS: true } } };
    for (const change of [
      (route: any) => { route.Web[second.hostname + ":443"].Handlers["/unrelated"] = { Proxy: "http://127.0.0.1:54321" }; },
      (route: any) => { route.TCP["8443"] = { HTTPS: true }; },
      (route: any) => { route.Web["unrelated.test.ts.net:443"] = { Handlers: { "/": { Text: "unrelated" } } }; },
      (route: any) => { route.Tun = true; },
    ]) {
      config = structuredClone(base); change(config.Services[second.serviceName]);
      const before = JSON.stringify(config); await writeFile(path, before); await f.manager.save();
      const registryBefore = await readFile(join(f.config.stateDir, "registry.json"), "utf8"); calls.length = 0;
      await assert.rejects(f.manager.unexpose(f.project, "web"), /additional routes/);
      assert.ok(calls.every(command => command.args[1] === "status"), "no alias may be drained or cleared when another has drifted");
      assert.equal(mode === "file" ? await readFile(path, "utf8") : JSON.stringify(config), before);
      assert.deepEqual(web.endpoints, endpoints);
      assert.equal(await readFile(join(f.config.stateDir, "registry.json"), "utf8"), registryBefore);
    }
    config = structuredClone(base); await writeFile(path, JSON.stringify(config)); calls.length = 0;
    await f.manager.unexpose(f.project, "web");
    assert.deepEqual(mode === "file" ? await readJson(path) : config, { Services: {}, TCP: base.TCP });
    assert.deepEqual(web.endpoints, []);
    assert.equal(calls.filter(command => command.args[1] === "clear").length, 2);
    const count = calls.length; await f.manager.unexpose(f.project, "web"); assert.equal(calls.length, count);
  });

  test(mode + " route removal refuses drift introduced during drain", async t => {
    const f = await fixture(); t.after(f.close); await f.manager.register(f.project);
    const web = f.manager.service(await f.manager.context(f.project), "web");
    const path = join(f.root, "serve.json"), calls: Command[] = [];
    if (mode === "file") f.config.tailscale!.serveConfigFile = path;
    let config: any;
    const routes = new TailscaleRoutes(f.config, async command => {
      calls.push(command);
      if (command.args[1] === "drain") {
        config.Services[web.endpoints[0].serviceName].TCP["8443"] = { HTTPS: true };
        await writeFile(path, JSON.stringify(config));
      }
      return { code: 0, stdout: JSON.stringify(config), stderr: "" };
    });
    f.manager.routes = routes; web.endpoints = routes.endpoints(web, "sample");
    config = { Services: { [web.endpoints[0].serviceName]: { TCP: { "443": { HTTPS: true } } } } };
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(f.manager.unexpose(f.project, "web"), /changed concurrently|additional routes/);
    assert.equal(calls.some(command => command.args[1] === "clear"), false);
    assert.deepEqual(await readJson(path), config);
    assert.equal(web.endpoints.length, 1);
  });
}
