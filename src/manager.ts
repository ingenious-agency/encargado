import { realpath, stat, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Problem, emptyRegistry, type Registry, type Settings, type Runner, type Service, type Checkout, type Endpoint } from "./model.ts";
import { atomicJson, canBind, checked, hash, Queue, readJson, redact, sleep } from "./util.ts";
import { loadManifest, contained } from "./manifest.ts";
import { ComposeDriver, SystemdDriver, type Driver, type Observation } from "./drivers.ts";
import { TailscaleRoutes, type Routes } from "./routes.ts";
import { httpStatus, websocketUpgrade } from "./probe.ts";
import { logLineCount } from "./logs.ts";

export class Manager {
  settings: Settings; runner: Runner; state: Registry; drivers: Record<string, Driver>; routes: Routes;
  queue = new Queue(); landingPort: number;
  constructor(settings: Settings, runner: Runner, state = emptyRegistry(), drivers?: Record<string, Driver>, routes?: Routes) {
    this.settings = settings; this.runner = runner; this.state = state; this.landingPort = settings.landingPort;
    this.drivers = drivers ?? { elixir: new SystemdDriver(runner, settings), compose: new ComposeDriver(runner, settings) };
    this.routes = routes ?? new TailscaleRoutes(settings, runner);
  }
  async load() {
    const value = await readJson(join(this.settings.stateDir, "registry.json"), emptyRegistry());
    if (value.version !== 1 || !value.projects || !value.checkouts || !value.services) throw new Problem("Unsupported Encargado registry");
    this.state = value;
  }
  async save() { await atomicJson(join(this.settings.stateDir, "registry.json"), this.state); }
  async context(path: string): Promise<Checkout> {
    const actual = await realpath(path);
    const checkout = Object.values(this.state.checkouts).filter(c => contained(c.path, actual)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!checkout) throw new Problem("This checkout is not registered. Run encargado register from its root.", 404);
    return checkout;
  }
  async register(path: string, manifestFile = "encargado.json") {
    return this.queue.execute(() => this.registerCheckout(path, manifestFile));
  }
  private async registerCheckout(path: string, manifestFile: string) {
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new Problem("Project path is not a directory");
    const git = async (...args: string[]) => (await checked(this.runner, { file: "git", args: ["-C", cwd, ...args] })).trim();
    const root = await realpath(await git("rev-parse", "--show-toplevel"));
    const common = await realpath(await git("rev-parse", "--path-format=absolute", "--git-common-dir"));
    const rawWorktrees = await git("worktree", "list", "--porcelain", "-z");
    const main = rawWorktrees.split("\0").find(line => line.startsWith("worktree "))?.slice(9);
    if (!main) throw new Problem("Cannot resolve the repository's main checkout");
    const projectPath = await realpath(main);
    const { manifest, path: manifestPath } = await loadManifest(root, manifestFile);
    const projectId = "p_" + hash(common), checkoutId = "w_" + hash(root);
    const next = structuredClone(this.state);
    const oldCheckout = next.checkouts[checkoutId];
    const nextNames = new Set(Object.keys(manifest.services));
    if (oldCheckout && Object.keys(oldCheckout.services).some(name => !nextNames.has(name))) throw new Problem("Removing a registered service requires explicit unregister; existing registrations were preserved");
    next.projects[projectId] = { id: projectId, name: manifest.project.name, description: manifest.project.description, path: projectPath, gitCommonDir: common };
    const checkout: Checkout = { id: checkoutId, projectId, path: root, manifestPath, services: {} };
    for (const [name, spec] of Object.entries(manifest.services)) {
      const id = "s_" + hash(projectId + ":" + (spec.scope === "project" ? "shared" : checkoutId) + ":" + name);
      if (oldCheckout?.services[name] && oldCheckout.services[name] !== id) throw new Problem(name + ": changing scope requires explicit unregister");
      const serviceCwd = spec.scope === "project" ? projectPath : root;
      // Shared recipes are authoritative in the main checkout, not whichever branch starts first.
      if (spec.scope === "project" && root !== projectPath) {
        const canonical = (await loadManifest(projectPath, manifestFile)).manifest.services[name];
        if (JSON.stringify(canonical) !== JSON.stringify(spec)) throw new Problem(name + ": shared recipe differs from the main checkout");
      }
      const definition = hash(JSON.stringify(spec));
      const old = next.services[id];
      if (old && old.definition !== definition) {
        const observation = await this.drivers[old.spec.driver].observe(old, this.state);
        if (old.desired === "running" || observation.state !== "stopped") throw new Problem(name + ": stop the service before changing its recipe", 409);
        if (JSON.stringify(old.spec.ports) !== JSON.stringify(spec.ports) || JSON.stringify(old.spec.urls) !== JSON.stringify(spec.urls)) throw new Problem(name + ": changing ports/URL aliases requires explicit unregister");
        if (spec.scope === "project" && old.consumers.some(c => c !== checkoutId)) throw new Problem(name + ": shared recipe is used by other worktrees", 409);
      }
      const ports = old?.ports ?? {};
      if (!old) {
        for (const key of Object.keys(spec.ports)) {
          const taken = new Set(Object.values(next.services).flatMap(s => Object.values(s.ports)));
          Object.values(ports).forEach(p => taken.add(p));
          let selected: number | undefined;
          for (let port = this.settings.portRange[0]; port <= this.settings.portRange[1]; port++) {
            if (!taken.has(port) && port !== this.landingPort && await canBind(port)) { selected = port; break; }
          }
          if (!selected) throw new Problem("No free port in Encargado's configured range");
          ports[key] = selected;
        }
      }
      const scopeId = spec.scope === "project" ? projectId : checkoutId;
      next.services[id] = {
        id, projectId, name, cwd: serviceCwd, spec, definition, dependencies: [],
        consumers: [...new Set([...(old?.consumers ?? []), checkoutId])],
        ports, unit: "encargado-" + id + ".service", composeProject: "encargado-" + scopeId.replaceAll("_", "-"),
        dataDir: join(this.settings.stateDir, "data", scopeId),
        desired: old?.desired ?? "stopped", status: old?.status ?? "stopped",
        error: old?.error, endpoints: old?.endpoints ?? [], routeError: old?.routeError,
      };
      checkout.services[name] = id;
    }
    for (const [name, id] of Object.entries(checkout.services)) next.services[id].dependencies = manifest.services[name].dependsOn.map(dep => checkout.services[dep]);
    next.checkouts[checkoutId] = checkout;
    // Validation uses the newly allocated ports, so hardcoded Compose bindings fail before any start.
    for (const id of Object.values(checkout.services)) await this.drivers[next.services[id].spec.driver].validate(next.services[id], next);
    this.state = next;
    await this.save();
    return this.inventory(checkout);
  }
  // Registry facts are available during startup and while stopped. Never queue
  // this read behind a launch whose project loader may be asking for these values.
  async configuration(path: string) {
    const checkout = await this.context(path), project = this.state.projects[checkout.projectId];
    return {
      version: 1,
      project: { id: project.id, name: project.name, path: project.path },
      checkout: { id: checkout.id, path: checkout.path },
      services: Object.fromEntries(Object.entries(checkout.services).map(([name, id]) => {
        const service = this.state.services[id];
        return [name, {
          id, role: service.spec.role, scope: service.spec.scope, ports: { ...service.ports },
          urls: Object.fromEntries(service.spec.urls.map(alias => [alias,
            service.endpoints.find(endpoint => endpoint.name === alias)?.url ?? `http://${alias}.localhost:${service.ports.http}`,
          ])),
        }];
      })),
    };
  }
  async get(path: string, key: string) {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(key)) throw new Problem("key must be a dotted service configuration path");
    let value: unknown = (await this.configuration(path)).services;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Problem("Unknown configuration key: " + key, 404);
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }
  service(checkout: Checkout, name: string): Service {
    const id = checkout.services[name];
    if (!id) throw new Problem("Unknown service in this checkout: " + name, 404);
    return this.state.services[id];
  }
  async logs(path: string, name: string, lines?: unknown) {
    const count = logLineCount(lines), service = this.service(await this.context(path), name);
    return this.drivers[service.spec.driver].logs(service, this.state, count);
  }
  async followLogs(path: string, name: string, signal: AbortSignal, lines?: unknown) {
    const count = logLineCount(lines), service = this.service(await this.context(path), name);
    return this.drivers[service.spec.driver].followLogs(service, this.state, signal, count);
  }
  async probe(service: Service): Promise<boolean> {
    if (!service.spec.ready) return true;
    try {
      const base = "http://127.0.0.1:" + service.ports.http;
      const origin = service.endpoints[0]?.url ?? base;
      const headers: Record<string, string> = service.endpoints[0] ? { Host: service.endpoints[0].hostname, "X-Forwarded-Proto": "https" } : {};
      const status = await httpStatus(base + service.spec.ready.path, headers);
      if (!service.spec.ready.statuses.includes(status)) return false;
      return !service.spec.ready.websocketPath || await websocketUpgrade(base + service.spec.ready.websocketPath, origin, headers);
    } catch { return false; }
  }
  async verify(path: string, name?: string) {
    const checkout = await this.context(path);
    const services = name ? [this.service(checkout, name)] : Object.values(checkout.services).map(id => this.state.services[id]).filter(s => s.ports.http);
    return Promise.all(services.map(async service => {
      const observed = await this.observe(service);
      const endpoints = await Promise.all(service.endpoints.map(async endpoint => {
        try {
          const status = await httpStatus(endpoint.url + (service.spec.ready?.path ?? "/"), {}, 10000);
          const httpReady = (service.spec.ready?.statuses ?? [200]).includes(status);
          const websocket = service.spec.ready?.websocketPath ? await websocketUpgrade(endpoint.url + service.spec.ready.websocketPath, endpoint.url, {}, 10000) : null;
          return { url: endpoint.url, status, ready: httpReady && websocket !== false, websocket };
        } catch (error) { return { url: endpoint.url, ready: false, error: redact((error as Error).message) }; }
      }));
      return { service: service.id, name: service.name, localReady: observed.ready, websocketConfigured: Boolean(service.spec.ready?.websocketPath), endpoints, ready: observed.ready && endpoints.every(e => e.ready) };
    }));
  }
  async observe(service: Service): Promise<Observation> {
    try {
      const observed = await this.drivers[service.spec.driver].observe(service, this.state);
      if (observed.state === "running" && observed.ready && !await this.probe(service)) return { ...observed, ready: false, reason: "Application readiness probe failed" };
      return observed;
    } catch (error) { return { state: "unknown", ready: false, reason: redact((error as Error).message) }; }
  }
  localUrl(service: Service) { return "http://127.0.0.1:" + this.landingPort + "/s/" + service.id; }
  private exposureEndpoints(service: Service) {
    // URLs belong to the registration, including legacy hashed hostnames.
    return service.endpoints.length ? service.endpoints : this.routes.endpoints(service, this.state.projects[service.projectId].name);
  }
  private async checkExposures(exposures: { service: Service; endpoints: Endpoint[] }[]) {
    const planned = new Map(exposures.map(({ service, endpoints }) => [service.id, endpoints]));
    const owners = new Map<string, Service>();
    for (const service of Object.values(this.state.services)) {
      for (const endpoint of planned.get(service.id) ?? service.endpoints) {
        for (const key of [endpoint.hostname, endpoint.serviceName]) {
          const owner = owners.get(key);
          if (owner) throw new Problem("URL name collision: " + endpoint.hostname + " is already registered to " + owner.name + " in " + owner.cwd + "; choose a different worktree directory, project name, or URL alias", 409);
          owners.set(key, service);
        }
      }
    }
    await this.routes.checkAvailable(exposures.filter(({ service }) => !service.endpoints.length).flatMap(({ endpoints }) => endpoints));
  }
  async route(service: Service, ready: boolean) {
    try {
      await this.routes.apply(service, ready ? "http://127.0.0.1:" + service.ports.http : "http://127.0.0.1:" + this.landingPort);
      service.routeError = undefined;
    } catch (error) { service.routeError = redact((error as Error).message); }
  }
  async startOne(id: string, visited: Set<string>) {
    if (visited.has(id)) return;
    visited.add(id);
    const service = this.state.services[id];
    for (const dep of service.dependencies) await this.startOne(dep, visited);
    const observed = await this.observe(service);
    if (observed.state === "running" && observed.ready) {
      service.desired = "running"; service.status = "running"; service.error = undefined;
      await this.route(service, true); await this.save(); return;
    }
    if (observed.state === "unknown") throw new Problem(service.name + ": cannot establish ownership/state: " + observed.reason, 409);
    service.status = "starting"; service.error = undefined; service.desired = "running"; await this.save();
    let launched = false;
    try {
      await this.drivers[service.spec.driver].validate(service, this.state);
      if (observed.state !== "running") {
        for (const port of Object.values(service.ports)) if (!await canBind(port)) throw new Problem(service.name + ": allocated port " + port + " is occupied; inspect its owner", 409);
        await mkdir(service.dataDir, { recursive: true, mode: 0o700 });
        await this.drivers[service.spec.driver].start(service, this.state);
        launched = true;
      }
      const deadline = Date.now() + (service.spec.ready?.timeout ?? 120) * 1000;
      while (true) {
        const current = await this.observe(service);
        if (current.state === "running" && current.ready) break;
        if (current.state === "stopped" || current.state === "failed") throw new Problem(service.name + ": exited before readiness; inspect encargado logs");
        if (Date.now() >= deadline) throw new Problem(service.name + ": readiness timed out (" + (current.reason ?? current.state) + ")");
        await sleep(300);
      }
      service.status = "running"; service.error = undefined;
      await this.route(service, true);
    } catch (error) {
      service.status = "failed"; service.error = redact((error as Error).message);
      // A failed app start does not leave its newly launched process running in the background.
      if (launched && service.spec.driver === "elixir") await this.drivers.elixir.stop(service, this.state).catch(() => {});
      await this.route(service, false);
      throw error;
    } finally { await this.save(); }
  }
  async up(path: string, options: { depsOnly?: boolean; service?: string } = {}) {
    return this.queue.execute(async () => {
      const checkout = await this.context(path);
      const targets = options.service ? [this.service(checkout, options.service)] : Object.values(checkout.services).map(id => this.state.services[id]).filter(s => s.spec.role === (options.depsOnly ? "dependency" : "workload"));
      if (!targets.length) throw new Problem("No matching services are registered in this checkout");
      const visited = new Set<string>();
      for (const service of targets) await this.startOne(service.id, visited);
      return this.inventory(checkout);
    });
  }
  async dev(path: string, options: { service?: string; manifest?: string; local?: boolean } = {}) {
    return this.queue.execute(async () => {
      await this.registerCheckout(path, options.manifest ?? "encargado.json");
      const checkout = await this.context(path);
      const targets = options.service ? [this.service(checkout, options.service)] : Object.values(checkout.services).map(id => this.state.services[id]).filter(service => service.spec.role === "workload");
      if (!targets.length) throw new Problem("No matching services are registered in this checkout");
      // Compute every requested exposure before making any lifecycle changes.
      const exposures = options.local ? [] : targets.filter(service => service.spec.urls.length).map(service => ({
        service, endpoints: this.exposureEndpoints(service),
      }));
      if (exposures.length) await this.checkExposures(exposures);
      for (const { service, endpoints } of exposures) {
        if (JSON.stringify(service.endpoints) !== JSON.stringify(endpoints)) {
          if ((await this.observe(service)).state !== "stopped") throw new Problem(service.name + ": stop the service before adding/changing its URLs", 409);
          service.endpoints = endpoints; await this.save();
          await this.route(service, false); await this.save();
          if (service.routeError) throw new Problem(service.name + ": " + service.routeError);
        }
      }
      const visited = new Set<string>();
      for (const service of targets) {
        await this.startOne(service.id, visited);
        if (service.routeError) throw new Problem(service.name + ": " + service.routeError);
      }
      const verification = [];
      for (const service of targets.filter(service => service.ports.http)) {
        const deadline = Date.now() + (service.spec.ready?.timeout ?? 90) * 1000;
        while (true) {
          const [result] = await this.verify(checkout.path, service.name);
          if (result.ready) { verification.push(result); break; }
          if (Date.now() >= deadline) throw new Problem(service.name + ": URL verification timed out: " + JSON.stringify(result));
          await sleep(Math.min(1000, deadline - Date.now()));
        }
      }
      return { ...await this.inventory(checkout), verification };
    });
  }
  async stop(path: string, options: { service?: string; depsOnly?: boolean } = {}) {
    return this.queue.execute(async () => {
      const checkout = await this.context(path);
      const targets = options.service ? [this.service(checkout, options.service)] : Object.values(checkout.services).map(id => this.state.services[id]).filter(s => s.spec.role === (options.depsOnly ? "dependency" : "workload"));
      const selected = new Set(targets.map(s => s.id));
      for (const target of targets) {
        if (target.spec.scope === "project" && !options.service) throw new Problem("Stop shared dependencies explicitly by service name: " + target.name, 409);
        for (const candidate of Object.values(this.state.services)) {
          if (!selected.has(candidate.id) && candidate.dependencies.includes(target.id)) {
            const current = await this.observe(candidate);
            if (current.state !== "stopped" && current.state !== "failed") throw new Problem(target.name + " is still needed by " + candidate.name + " in " + candidate.cwd, 409);
          }
        }
      }
      const visited = new Set<string>(), order: Service[] = [];
      const visit = (s: Service) => { if (visited.has(s.id)) return; visited.add(s.id); for (const dep of s.dependencies) if (selected.has(dep)) visit(this.state.services[dep]); order.push(s); };
      targets.forEach(visit);
      for (const service of order.reverse()) {
        await this.route(service, false);
        await this.drivers[service.spec.driver].stop(service, this.state);
        service.desired = "stopped"; service.status = "stopped"; service.error = undefined;
        await this.save();
      }
      return this.inventory(checkout);
    });
  }
  async expose(path: string, name: string) {
    return this.queue.execute(async () => {
      const checkout = await this.context(path), service = this.service(checkout, name);
      if (!service.spec.urls.length) throw new Problem("This service has no HTTP URL aliases");
      if ((await this.observe(service)).state !== "stopped") throw new Problem("Expose URLs before starting the app, so Phoenix receives the correct origins", 409);
      const endpoints = this.exposureEndpoints(service);
      await this.checkExposures([{ service, endpoints }]);
      service.endpoints = endpoints;
      await this.save();
      await this.route(service, false); await this.save();
      return this.inventory(checkout);
    });
  }
  async unregister(path: string) {
    return this.queue.execute(async () => {
      const checkout = await this.context(path);
      for (const id of Object.values(checkout.services)) {
        const service = this.state.services[id];
        if (service.endpoints.length) throw new Problem("This checkout owns persistent Tailscale URLs. Remove those registrations explicitly before unregistering.");
        if (service.consumers.length === 1 && (await this.observe(service)).state !== "stopped") throw new Problem("Stop all checkout-owned services before unregistering", 409);
      }
      for (const id of Object.values(checkout.services)) {
        const service = this.state.services[id];
        service.consumers = service.consumers.filter(c => c !== checkout.id);
        if (!service.consumers.length) delete this.state.services[id];
      }
      delete this.state.checkouts[checkout.id];
      await this.save();
      return { unregistered: checkout.id, dataPreserved: true };
    });
  }
  async unexpose(path: string, name: string) {
    return this.queue.execute(async () => {
      const checkout = await this.context(path), service = this.service(checkout, name);
      if ((await this.observe(service)).state !== "stopped") throw new Problem("Stop the service before retiring its URLs", 409);
      await this.routes.remove(service);
      service.endpoints = []; service.routeError = undefined; await this.save();
      return this.inventory(checkout);
    });
  }
  async reconcile() {
    return this.queue.execute(async () => {
      for (const service of Object.values(this.state.services)) {
        const observed = await this.observe(service);
        service.status = observed.state === "running" && observed.ready ? "running" : observed.state === "stopped" && service.desired === "running" ? "failed" : observed.state;
        service.error = observed.reason ?? (service.status === "failed" ? service.error ?? "Service exited" : undefined);
        await this.route(service, observed.state === "running" && observed.ready);
      }
      await this.save();
    });
  }
  async inventory(checkout?: Checkout) {
    const services = checkout ? Object.values(checkout.services).map(id => this.state.services[id]) : Object.values(this.state.services);
    return {
      version: 1,
      projects: checkout ? [this.state.projects[checkout.projectId]] : Object.values(this.state.projects),
      checkouts: checkout ? [checkout] : Object.values(this.state.checkouts),
      services: await Promise.all(services.map(async service => ({
        id: service.id, projectId: service.projectId, name: service.name, cwd: service.cwd,
        driver: service.spec.driver, role: service.spec.role, scope: service.spec.scope, purpose: service.spec.purpose,
        consumers: service.consumers, dependencies: service.dependencies, ports: service.ports,
        owner: service.spec.driver === "elixir" ? { kind: "systemd", user: true, unit: service.unit } : { kind: "compose", project: service.composeProject, service: service.name },
        desired: service.desired, lastError: service.error, observed: await this.observe(service),
        urls: service.ports.http ? [{ url: this.localUrl(service), scope: "localhost", source: "encargado" }, ...service.endpoints.map(e => ({ url: e.url, scope: "tailnet", source: e.serviceName }))] : [],
        routeError: service.routeError,
      }))),
    };
  }
}
