import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Problem, type Service, type Registry, type Runner, type Settings, type Command } from "./model.ts";
import { checked, atomicJson, redact } from "./util.ts";
import { projectFile, contained } from "./manifest.ts";

export interface Observation { state: "running" | "stopped" | "failed" | "unknown"; ready: boolean; reason?: string }
export interface Driver {
  validate(service: Service, state: Registry): Promise<void>;
  start(service: Service, state: Registry): Promise<void>;
  stop(service: Service, state: Registry): Promise<void>;
  observe(service: Service, state: Registry): Promise<Observation>;
  logs(service: Service, state: Registry): Promise<string>;
}
export const portVariable = (service: string, port: string) => "ENCARGADO_" + service.replaceAll("-", "_").toUpperCase() + "_" + port.toUpperCase() + "_PORT";
export async function environment(service: Service, state: Registry, settings: Settings): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "MISE_DATA_DIR", "MISE_CONFIG_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.MIX_ENV = "dev";
  for (const file of service.spec.environmentFiles) Object.assign(env, parseEnv(await readFile(await projectFile(service.cwd, file), "utf8")));
  const checkout = Object.values(state.checkouts).find(c => c.path === service.cwd && Object.values(c.services).includes(service.id));
  const peers = checkout ? Object.values(checkout.services).map(id => state.services[id]) : Object.values(state.services).filter(s => s.projectId === service.projectId && s.spec.scope === "project");
  for (const peer of peers) for (const [name, port] of Object.entries(peer.ports)) env[portVariable(peer.name, name)] = String(port);
  env.ENCARGADO_PROJECT = service.projectId;
  env.ENCARGADO_WORKTREE = service.cwd;
  env.ENCARGADO_DATA_DIR = service.dataDir;
  env.ENCARGADO_SERVICE = service.id;
  env.ENCARGADO_SOCKET = settings.socket;
  for (const [key, value] of Object.entries(service.spec.environment)) {
    env[key] = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name) => {
      if (env[name] === undefined) throw new Problem(service.name + ": unknown environment reference " + name);
      return env[name]!;
    });
  }
  if (service.ports.http) {
    const url = new URL(service.endpoints[0]?.url ?? "http://127.0.0.1:" + service.ports.http);
    env.PORT = String(service.ports.http);
    env.HOST = "127.0.0.1";
    env.PHOENIX_BIND = "127.0.0.1";
    env.PHX_HOST = url.hostname;
    env.PHX_SCHEME = url.protocol.slice(0, -1);
    env.PHX_PUBLIC_PORT = url.port || (url.protocol === "https:" ? "443" : "80");
    env.ENCARGADO_URL = url.origin;
    env.ENCARGADO_ORIGINS = [url.origin, ...service.endpoints.map(e => e.url), "http://127.0.0.1:" + service.ports.http].filter((x, i, xs) => xs.indexOf(x) === i).join(",");
  }
  return env;
}
export class SystemdDriver implements Driver {
  runner: Runner; settings: Settings;
  constructor(runner: Runner, settings: Settings) { this.runner = runner; this.settings = settings; }
  async validate(service: Service, state: Registry) { await environment(service, state, this.settings); }
  async start(service: Service, state: Registry) {
    const launchFile = join(this.settings.stateDir, "launch", service.id + ".json");
    await atomicJson(launchFile, { command: service.spec.command, cwd: service.cwd, env: await environment(service, state, this.settings) });
    await checked(this.runner, {
      file: "systemd-run", args: ["--user", "--quiet", "--collect", "--service-type=exec", "--expand-environment=no",
        "--unit=" + service.unit, "--property=KillMode=control-group", "--property=TimeoutStopSec=20",
        "--property=Restart=no", "--", process.execPath, fileURLToPath(new URL("./launch.ts", import.meta.url)), launchFile],
    });
  }
  async stop(service: Service) {
    const observation = await this.observe(service);
    if (observation.state === "stopped") return;
    await checked(this.runner, { file: "systemctl", args: ["--user", "--no-ask-password", "stop", "--", service.unit] });
  }
  async observe(service: Service): Promise<Observation> {
    const result = await this.runner({ file: "systemctl", args: ["--user", "show", "--property=LoadState,ActiveState,SubState,ControlGroup", "--", service.unit] });
    if (result.code && !result.stdout.includes("LoadState=not-found")) return { state: "unknown", ready: false, reason: "systemd status unavailable" };
    const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => line.split("=")));
    if (fields.LoadState === "not-found" || fields.ActiveState === "inactive") return { state: "stopped", ready: false };
    if (fields.ActiveState === "failed") return { state: "failed", ready: false, reason: "systemd unit failed" };
    if (fields.ActiveState === "active") {
      if (!service.ports.http) return { state: "running", ready: true };
      const listeners = await this.runner({ file: "ss", args: ["-H", "-ltnp", "sport", "=", ":" + service.ports.http] });
      if (listeners.code || !fields.ControlGroup) return { state: "unknown", ready: false, reason: "Cannot verify application listener ownership" };
      const rows = listeners.stdout.trim().split("\n").filter(Boolean);
      if (!rows.length) return { state: "running", ready: false, reason: "Waiting for application listener" };
      for (const row of rows) {
        if (row.trim().split(/\s+/)[3] !== "127.0.0.1:" + service.ports.http) return { state: "running", ready: false, reason: "Application must bind to 127.0.0.1" };
        const pids = [...row.matchAll(/pid=(\d+)/g)].map(match => match[1]);
        if (!pids.length) return { state: "unknown", ready: false, reason: "Listener owner is unavailable" };
        for (const pid of pids) {
          const cgroups = await readFile("/proc/" + pid + "/cgroup", "utf8").catch(() => "");
          if (!cgroups.split("\n").some(line => line.endsWith(":" + fields.ControlGroup))) return { state: "unknown", ready: false, reason: "Allocated port belongs to another process" };
        }
      }
      return { state: "running", ready: true };
    }
    return { state: "unknown", ready: false, reason: fields.ActiveState ?? "No systemd state" };
  }
  async logs(service: Service) {
    return redact(await checked(this.runner, { file: "journalctl", args: ["--user", "--unit", service.unit, "--lines", "100", "--no-pager", "--output=short-iso"] }));
  }
}
export class ComposeDriver implements Driver {
  runner: Runner; settings: Settings;
  constructor(runner: Runner, settings: Settings) { this.runner = runner; this.settings = settings; }
  async command(service: Service, state: Registry, args: string[]): Promise<Command> {
    const files = await Promise.all(service.spec.files!.map(file => projectFile(service.cwd, file)));
    return { file: "docker", cwd: service.cwd, env: { ...await environment(service, state, this.settings), COMPOSE_IGNORE_ORPHANS: "true" },
      args: ["compose", "--project-name", service.composeProject, "--project-directory", service.cwd,
        ...files.flatMap(file => ["--file", file]), ...service.spec.profiles!.flatMap(profile => ["--profile", profile]), ...args],
      timeout: 180000 };
  }
  async validate(service: Service, state: Registry) {
    const raw = await checked(this.runner, await this.command(service, state, ["config", "--format", "json"]));
    let config: any; try { config = JSON.parse(raw); } catch { throw new Problem("Compose did not return a valid resolved configuration"); }
    const selected = config.services?.[service.name];
    if (!selected) throw new Problem("Compose service does not exist: " + service.name);
    if (selected.container_name || selected.network_mode === "host") throw new Problem(service.name + ": remove container_name/host networking so Encargado can isolate it");
    if (selected.privileged || selected.pid === "host" || selected.ipc === "host") throw new Problem(service.name + ": dependency recipe cannot use privileged/host process namespaces");
    const expected = new Map(Object.entries(service.ports).map(([name, host]) => [service.spec.ports[name], host]));
    const actual = selected.ports ?? [];
    if (actual.length !== expected.size || actual.some((p: any) => p.host_ip !== "127.0.0.1" || p.protocol !== "tcp" || Number(p.published) !== expected.get(Number(p.target)))) {
      throw new Problem(service.name + ": Compose ports must bind 127.0.0.1 and use the allocated ENCARGADO_<SERVICE>_<PORT>_PORT variables");
    }
    for (const mount of selected.volumes ?? []) {
      if (mount.type === "bind" && !contained(service.cwd, mount.source) && !contained(service.dataDir, mount.source)) throw new Problem(service.name + ": bind mount is outside its checkout/data directory: " + mount.target);
      if (mount.type === "volume") {
        const volume = config.volumes?.[mount.source];
        if (volume?.external || (volume?.name && !volume.name.startsWith(service.composeProject + "_"))) throw new Problem(service.name + ": volume must be namespaced by its Compose project");
      }
    }
    for (const network of Object.keys(selected.networks ?? {})) {
      const spec = config.networks?.[network];
      if (spec?.external || (spec?.name && !spec.name.startsWith(service.composeProject + "_"))) throw new Problem(service.name + ": network must be namespaced by its Compose project");
    }
    for (const dep of Object.keys(selected.depends_on ?? {})) {
      const match = service.dependencies.map(id => state.services[id]).find(s => s.name === dep);
      if (!match || match.composeProject !== service.composeProject) throw new Problem(service.name + ": Compose dependency " + dep + " needs a matching declared dependency in the same scope");
    }
    if (!selected.healthcheck || selected.healthcheck.disable || selected.healthcheck.test?.[0] === "NONE") throw new Problem(service.name + ": add a Compose healthcheck so dependency readiness can be verified");
  }
  async start(service: Service, state: Registry) {
    await mkdir(service.dataDir, { recursive: true, mode: 0o700 });
    await checked(this.runner, await this.command(service, state, ["up", "--detach", "--wait", "--wait-timeout", "120", "--no-deps", "--no-recreate", service.name]));
  }
  async containers(service: Service): Promise<any[]> {
    const ids = (await checked(this.runner, { file: "docker", args: ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + service.composeProject, "--filter", "label=com.docker.compose.service=" + service.name] })).trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    const raw = await checked(this.runner, { file: "docker", args: ["inspect", "--format", '{"id":{{json .Id}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"ports":{{json .HostConfig.PortBindings}}}', ...ids] });
    return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  async stop(service: Service) {
    const containers = await this.containers(service);
    const ids = containers.filter(c => c.status === "running" || c.status === "restarting").map(c => c.id);
    if (ids.length) await checked(this.runner, { file: "docker", args: ["stop", "--time", "20", ...ids] });
  }
  async observe(service: Service): Promise<Observation> {
    try {
      const containers = await this.containers(service);
      for (const container of containers) {
        const expected = Object.entries(service.ports);
        const actual = Object.entries(container.ports ?? {}) as [string, { HostIp: string; HostPort: string }[]][];
        if (actual.length !== expected.length || actual.some(([target, bindings]) => bindings.length !== 1 || bindings[0].HostIp !== "127.0.0.1" ||
          !expected.some(([name, port]) => target === service.spec.ports[name] + "/tcp" && bindings[0].HostPort === String(port)))) {
          return { state: "unknown", ready: false, reason: "Existing container ports differ from registered allocations; recreate the owned Compose service explicitly" };
        }
      }
      if (!containers.length || containers.every(c => c.status === "exited" || c.status === "created")) return { state: "stopped", ready: false };
      if (containers.every(c => c.status === "running")) return { state: "running", ready: containers.every(c => c.health === "healthy"), reason: containers.some(c => c.health !== "healthy") ? "Compose healthcheck has not passed" : undefined };
      return { state: "failed", ready: false, reason: "Compose containers are not all running" };
    } catch { return { state: "unknown", ready: false, reason: "Docker status unavailable" }; }
  }
  async logs(service: Service) {
    const containers = await this.containers(service);
    const logs = await Promise.all(containers.map(c => this.runner({ file: "docker", args: ["logs", "--tail", "100", c.id] })));
    return redact(logs.map(r => r.stdout + r.stderr).join("\n"));
  }
}
