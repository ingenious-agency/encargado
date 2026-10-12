import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { checked, run } from "../src/util.ts";
import { Manager } from "../src/manager.ts";
import type { Service, Settings, Registry, Endpoint } from "../src/model.ts";
import type { Driver, Observation } from "../src/drivers.ts";
import type { Routes } from "../src/routes.ts";

export function manifest(shared = false): any {
  return { version: 1, project: { name: "sample", description: "Fixture project" }, services: {
    postgres: { driver: "compose", scope: shared ? "project" : "worktree", ports: { database: 5432 } },
    web: { driver: "elixir", dependsOn: ["postgres"], ready: { path: "/", statuses: [200], timeout: 1 } },
  } };
}
export class FakeDriver implements Driver {
  starts: string[] = []; stops: string[] = []; states = new Map<string, Observation>(); servers = new Map<string, Server>();
  responseStatus = 200; failService?: string;
  async validate(_service: Service, _state: Registry) {}
  async start(service: Service) {
    this.starts.push(service.name);
    if (service.name === this.failService) throw new Error("Fixture launch failed");
    if (service.ports.http) {
      const server = createServer((_req, res) => res.writeHead(this.responseStatus).end("fixture"));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(service.ports.http, "127.0.0.1", resolve); });
      this.servers.set(service.id, server);
    }
    this.states.set(service.id, { state: "running", ready: true });
  }
  async stop(service: Service) {
    this.stops.push(service.name);
    const server = this.servers.get(service.id);
    if (server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); this.servers.delete(service.id); }
    this.states.set(service.id, { state: "stopped", ready: false });
  }
  async observe(service: Service) { return this.states.get(service.id) ?? { state: "stopped" as const, ready: false }; }
  async logs(_service: Service, _state: Registry, _lines = 100) { return "fixture log"; }
  async followLogs(_service: Service, _state: Registry, signal: AbortSignal, _lines = 100): Promise<AsyncIterable<string>> {
    return (async function* () {
      yield "fixture log\n";
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
  }
  async close() { await Promise.all([...this.servers.values()].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); this.servers.clear(); }
}
export class FakeRoutes implements Routes {
  targets = new Map<string, string>(); fail = false;
  endpoints(service: Service) { return service.spec.urls.map(name => ({ name, hostname: name + "-" + service.id + ".test.ts.net", serviceName: "svc:enc-" + service.id + "-" + name, url: "https://" + name + "-" + service.id + ".test.ts.net" })); }
  async checkAvailable(_endpoints: Endpoint[]) {}
  async apply(service: Service, target: string) { if (this.fail) throw new Error("Route unavailable"); if (service.endpoints.length) this.targets.set(service.id, target); }
  async remove(service: Service) { this.targets.delete(service.id); }
  async discover() { return [...this.targets]; }
}
export async function fixture(raw = manifest()) {
  const root = await mkdtemp(join(tmpdir(), "enc-test-"));
  const project = join(root, "project"), stateDir = join(root, "state");
  await mkdir(project); await mkdir(stateDir);
  await writeFile(join(project, "encargado.json"), JSON.stringify(raw));
  await writeFile(join(project, "compose.yaml"), "services: {}\n");
  await checked(run, { file: "git", args: ["init", "-b", "main", project] });
  await checked(run, { file: "git", args: ["-C", project, "add", "."] });
  await checked(run, { file: "git", args: ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"] });
  const config: Settings = { stateDir, socket: join(stateDir, "control.sock"), landingPort: 0, portRange: [41000, 49000], tailscale: { domain: "test.ts.net", command: ["tailscale"], allowedUsers: ["owner@example.test"] } };
  const driver = new FakeDriver(), routes = new FakeRoutes();
  const manager = new Manager(config, run, undefined, { elixir: driver, compose: driver }, routes);
  const worktree = async () => {
    const path = join(root, "feature");
    await checked(run, { file: "git", args: ["-C", project, "worktree", "add", "-b", "feature", path] });
    return path;
  };
  return { root, project, config, driver, routes, manager, worktree, close: async () => { await driver.close(); await rm(root, { recursive: true, force: true }); } };
}
