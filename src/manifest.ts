import { resolve, relative, isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { Problem, type Manifest, type ServiceSpec } from "./model.ts";
import { object, strings, readJson } from "./util.ts";

export function validateManifest(raw: unknown): Manifest {
  object(raw, "Manifest");
  if (raw.version !== 1) throw new Problem("Manifest version must be 1");
  object(raw.project, "project");
  if (typeof raw.project.name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(raw.project.name)) throw new Problem("project.name must be a lowercase slug");
  if (raw.project.description !== undefined && typeof raw.project.description !== "string") throw new Problem("project.description must be a string");
  object(raw.services, "services");
  const services: Record<string, ServiceSpec> = {};
  const environmentNames = new Set<string>();
  for (const [name, value] of Object.entries(raw.services)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Problem("Invalid service name: " + name);
    object(value, name);
    const allowed = new Set(["driver", "role", "scope", "purpose", "dependsOn", "command", "files", "profiles", "environment", "environmentFiles", "ports", "ready", "urls"]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Problem(name + ": unknown field " + key);
    if (!["compose", "elixir"].includes(value.driver)) throw new Problem(name + ": driver must be compose or elixir");
    if (value.role !== undefined && !["workload", "dependency", "tooling"].includes(value.role)) throw new Problem(name + ": invalid role");
    if (value.scope !== undefined && !["worktree", "project"].includes(value.scope)) throw new Problem(name + ": invalid scope");
    if (value.purpose !== undefined && typeof value.purpose !== "string") throw new Problem(name + ": purpose must be a string");
    const ports = value.ports ?? (value.driver === "elixir" ? { http: 4000 } : {});
    object(ports, name + ".ports");
    for (const [key, target] of Object.entries(ports)) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(key) || !Number.isInteger(target) || target < 1 || target > 65535) throw new Problem(name + ": ports map names to container/internal port numbers");
      const variable = (name.replaceAll("-", "_") + "_" + key).toUpperCase();
      if (environmentNames.has(variable)) throw new Problem("Service ports produce duplicate environment variables: " + name + "." + key);
      environmentNames.add(variable);
    }
    const environment = value.environment ?? {};
    object(environment, name + ".environment");
    for (const [key, val] of Object.entries(environment)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof val !== "string" || val.includes("\0")) throw new Problem(name + ": invalid environment");
      if (key.startsWith("ENCARGADO_")) throw new Problem("ENCARGADO_ variables are allocated by the manager");
    }
    const spec: ServiceSpec = {
      driver: value.driver, role: value.role ?? (value.driver === "compose" ? "dependency" : "workload"),
      scope: value.scope ?? "worktree", ...(value.purpose ? { purpose: value.purpose } : {}),
      dependsOn: strings(value.dependsOn ?? [], name + ".dependsOn"),
      environment, environmentFiles: strings(value.environmentFiles ?? [], name + ".environmentFiles"),
      ports, urls: strings(value.urls ?? (value.driver === "elixir" && ports.http ? [name] : []), name + ".urls"),
    };
    if (spec.driver === "elixir") {
      spec.command = strings(value.command ?? ["mise", "exec", "--", "mix", "phx.server"], name + ".command");
      if (!spec.command.length || spec.command[0].startsWith("-")) throw new Problem(name + ": command is empty or invalid");
      if (value.files || value.profiles) throw new Problem(name + ": files/profiles apply to Compose");
    } else {
      spec.files = strings(value.files ?? ["compose.yaml"], name + ".files");
      spec.profiles = strings(value.profiles ?? [], name + ".profiles");
      if (!spec.files.length || value.command) throw new Problem(name + ": Compose needs files and does not accept a command");
    }
    if (new Set(spec.urls).size !== spec.urls.length || spec.urls.some(s => !/^[a-z][a-z0-9-]{0,24}$/.test(s))) throw new Problem(name + ": invalid URL alias");
    if (spec.urls.length && !ports.http) throw new Problem(name + ": URLs require an http port");
    if (value.ready !== undefined || ports.http) {
      const ready = value.ready ?? {};
      object(ready, name + ".ready");
      const path = ready.path ?? "/";
      const statuses = ready.statuses ?? [200];
      const timeout = ready.timeout ?? 90;
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\r\n\0]/.test(path)) throw new Problem(name + ": invalid readiness path");
      if (!Array.isArray(statuses) || !statuses.length || statuses.some(s => !Number.isInteger(s) || s < 200 || s > 499)) throw new Problem(name + ": invalid readiness statuses");
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Problem(name + ": readiness timeout must be 1–600 seconds");
      if (!ports.http) throw new Problem(name + ": HTTP readiness needs an http port");
      spec.ready = { path, statuses, timeout };
      if (ready.websocketPath !== undefined) {
        if (typeof ready.websocketPath !== "string" || !ready.websocketPath.startsWith("/") || ready.websocketPath.startsWith("//") || /[\r\n\0]/.test(ready.websocketPath)) throw new Problem(name + ": invalid WebSocket path");
        spec.ready.websocketPath = ready.websocketPath;
      }
    }
    services[name] = spec;
  }
  const aliases = new Set<string>();
  for (const [name, spec] of Object.entries(services)) {
    for (const dep of spec.dependsOn) {
      if (!Object.hasOwn(services, dep)) throw new Problem(name + ": unknown dependency " + dep);
      if (spec.scope === "project" && services[dep].scope !== "project") throw new Problem("Project-shared services cannot depend on a worktree-local service");
    }
    for (const alias of spec.urls) { if (aliases.has(alias)) throw new Problem("Duplicate URL alias: " + alias); aliases.add(alias); }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Problem("Dependency cycle at " + name);
    if (done.has(name)) return;
    visiting.add(name); for (const dep of services[name].dependsOn) visit(dep);
    visiting.delete(name); done.add(name);
  };
  Object.keys(services).forEach(visit);
  return { version: 1, project: { name: raw.project.name, ...(raw.project.description ? { description: raw.project.description } : {}) }, services };
}
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
export async function projectFile(root: string, file: string, optional = false) {
  if (isAbsolute(file) || !contained(root, resolve(root, file))) throw new Problem("Project file must stay inside its checkout: " + file);
  const path = resolve(root, file);
  try {
    const actual = await realpath(path);
    if (!contained(root, actual) || !(await stat(actual)).isFile()) throw new Problem("Project file is outside its checkout or not a regular file: " + file);
    return actual;
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return path; throw error; }
}
export async function loadManifest(cwd: string, file = "encargado.json") {
  const path = await projectFile(cwd, file);
  return { path, manifest: validateManifest(await readJson(path)) };
}
