import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, manifest } from "../helpers.ts";
import { Manager } from "../../src/manager.ts";
import { Daemon, client } from "../../src/server.ts";
import { checked, run } from "../../src/util.ts";

test("real Compose + systemd + Elixir: worktree isolation, ready URLs, daemon recovery, and data-preserving stop", { timeout: 180000 }, async t => {
  const raw = manifest();
  raw.services.postgres.environment = { POSTGRES_PASSWORD: "fixture-only" };
  raw.services.web.command = ["mise", "exec", "--", "elixir", "server.exs"];
  raw.services.web.ready.timeout = 30;
  const f = await fixture(raw);
  await writeFile(join(f.project, "compose.yaml"), [
    "services:", "  postgres:", "    image: postgres:17-alpine",
    "    environment:", "      POSTGRES_PASSWORD: fixture-only",
    '    ports: ["127.0.0.1:' + "$" + '{ENCARGADO_POSTGRES_DATABASE_PORT}:5432"]',
    "    volumes: [data:/var/lib/postgresql/data]",
    "    healthcheck:", '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
    "      interval: 1s", "      timeout: 3s", "      retries: 30",
    "volumes:", "  data:", "",
  ].join("\n"));
  await writeFile(join(f.project, "server.exs"), [
    "defmodule FixtureServer do",
    "  def accept(socket) do",
    "    {:ok, client} = :gen_tcp.accept(socket)",
    "    Task.start(fn ->",
    "      :gen_tcp.recv(client, 0, 5000)",
    '      body = "encargado-elixir-fixture"',
    '      :gen_tcp.send(client, "HTTP/1.1 200 OK\\r\\nContent-Length: #{byte_size(body)}\\r\\nConnection: close\\r\\n\\r\\n" <> body)',
    "      :gen_tcp.close(client)",
    "    end)",
    "    accept(socket)",
    "  end",
    "end",
    'port = System.fetch_env!("PORT") |> String.to_integer()',
    "{:ok, socket} = :gen_tcp.listen(port, [:binary, active: false, reuseaddr: true, ip: {127,0,0,1}])",
    "FixtureServer.accept(socket)", "",
  ].join("\n"));
  await checked(run, { file: "git", args: ["-C", f.project, "add", "."] });
  await checked(run, { file: "git", args: ["-C", f.project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "live fixture"] });
  const manager = new Manager(f.config, run);
  let daemon = new Daemon(manager);
  const namespaces = new Set<string>(), units = new Set<string>();
  t.after(async () => {
    await daemon.close();
    for (const unit of units) await run({ file: "systemctl", args: ["--user", "stop", unit] });
    for (const namespace of namespaces) {
      const ids = (await checked(run, { file: "docker", args: ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + namespace] })).trim().split(/\s+/).filter(Boolean);
      if (ids.length) await run({ file: "docker", args: ["rm", "-f", ...ids] });
      const volumes = (await checked(run, { file: "docker", args: ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + namespace] })).trim().split(/\s+/).filter(Boolean);
      if (volumes.length) await run({ file: "docker", args: ["volume", "rm", ...volumes] });
      const networks = (await checked(run, { file: "docker", args: ["network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + namespace] })).trim().split(/\s+/).filter(Boolean);
      if (networks.length) await run({ file: "docker", args: ["network", "rm", ...networks] });
    }
    await f.close();
  });
  await daemon.start();
  await client(f.config.socket, "POST", "/v1/register", { path: f.project });
  const wt = await f.worktree();
  await client(f.config.socket, "POST", "/v1/register", { path: wt });
  for (const s of Object.values(manager.state.services)) { namespaces.add(s.composeProject); units.add(s.unit); }
  await client(f.config.socket, "POST", "/v1/up", { path: f.project, depsOnly: true });
  let inventory = await manager.inventory(await manager.context(f.project));
  assert.equal(inventory.services.find(s => s.name === "postgres")!.observed.ready, true);
  assert.equal(inventory.services.find(s => s.name === "web")!.observed.state, "stopped");
  const started = await client(f.config.socket, "POST", "/v1/up", { path: f.project });
  assert.equal(started.services.find((s: any) => s.name === "web").observed.ready, true);
  const url = started.services.find((s: any) => s.name === "web").urls[0].url;
  assert.equal(await (await fetch(url)).text(), "encargado-elixir-fixture");
  await client(f.config.socket, "POST", "/v1/up", { path: wt });
  const mainDb = manager.service(await manager.context(f.project), "postgres"), wtDb = manager.service(await manager.context(wt), "postgres");
  assert.notEqual(mainDb.composeProject, wtDb.composeProject);
  assert.notEqual(mainDb.ports.database, wtDb.ports.database);
  const before = (await run({ file: "docker", args: ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + mainDb.composeProject] })).stdout;
  await daemon.close();
  const recovered = new Manager(f.config, run); daemon = new Daemon(recovered); await daemon.start();
  inventory = await recovered.inventory(await recovered.context(f.project));
  assert.ok(inventory.services.every(s => s.observed.ready));
  await recovered.stop(f.project);
  await recovered.stop(f.project, { depsOnly: true });
  assert.equal((await recovered.inventory(await recovered.context(wt))).services.find(s => s.name === "web")!.observed.ready, true);
  const after = (await run({ file: "docker", args: ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + mainDb.composeProject] })).stdout;
  assert.equal(after, before);
  await recovered.stop(wt); await recovered.stop(wt, { depsOnly: true });
  assert.equal((await readFile(join(f.config.stateDir, "registry.json"), "utf8")).includes('"version": 1'), true);
});
