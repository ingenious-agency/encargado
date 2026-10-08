import { parseArgs } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { settings } from "./settings.ts";
import { Manager } from "./manager.ts";
import { Daemon, client } from "./server.ts";
import { run, checked, slug, redact } from "./util.ts";
import { Problem } from "./model.ts";

const help = [
  "Encargado — project and worktree development environments",
  "",
  "encargado daemon                  Run the manager (Unix API + local start page)",
  "encargado install                 Install and start a systemd user service",
  "encargado init                    Write a Phoenix encargado.json in this checkout",
  "encargado register                Register the project, worktree, and its services",
  "encargado dev [service]          Register, expose, start and verify development URLs",
  "encargado context               Read this checkout's configuration facts as JSON",
  "encargado get <key>             Read a fact, e.g. postgres.ports.database",
  "encargado up [service]            Start workloads and their dependencies",
  "encargado deps up                 Start dependencies only",
  "encargado stop [service]          Stop this checkout's workloads",
  "encargado deps stop               Stop private dependencies, preserving data",
  "encargado status                  Inspect declared and observed state",
  "encargado urls                    List this checkout's local and tailnet URLs",
  "encargado verify [service]        Check local/public HTTP and configured WebSockets",
  "encargado expose <service>        Register named Tailscale URLs before app startup",
  "encargado unexpose <service>      Retire stopped-service routes; retain tailnet DNS definition",
  "encargado logs <service>          Read recent logs",
  "encargado discover               Read existing Tailscale routes",
  "encargado reconcile              Refresh runtime state and routes",
  "encargado unregister              Remove a stopped checkout registration; retain data",
  "",
  "--path <directory>               Checkout (default: current directory)",
  "--manifest <file>                Manifest relative to checkout (default: encargado.json)",
  "--json                           Machine-readable output",
  "--local                          dev: skip creating tailnet URLs; retain existing ones",
  "--all                            All registered projects (status/urls only)",
  "ENCARGADO_HOME                    Alternate private state/runtime directory",
  "ENCARGADO_SOCKET                  Control socket; injected into managed recipes",
  "ENCARGADO_PORT                    Local start-page port (default 17870)",
].join("\n");
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, json: { type: "boolean" }, all: { type: "boolean" },
    path: { type: "string" }, manifest: { type: "string" }, local: { type: "boolean" },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const config = await settings(), path = resolve(values.path ?? process.cwd());
  const [command, arg, extra] = positionals;
  if (extra) throw new Problem("Unexpected argument: " + extra);
  if (values.local && command !== "dev") throw new Problem("--local applies only to dev");
  if (command === "daemon") {
    const daemon = new Daemon(new Manager(config, run));
    const listening = await daemon.start();
    console.log(JSON.stringify({ event: "listening", ...listening }));
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void daemon.close().then(() => process.exit(0)); });
    return;
  }
  if (command === "install") {
    const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/encargado.service");
    const quote = (text: string) => '"' + text.replaceAll("%", "%%").replaceAll("$", "$$").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    await mkdir(resolve(file, ".."), { recursive: true });
    const lines = ["[Unit]", "Description=Encargado development environment manager", "After=default.target", "", "[Service]", "Type=simple",
      "ExecStart=" + quote(process.execPath) + " " + quote(fileURLToPath(import.meta.url)) + " daemon",
      "Restart=on-failure", "RestartSec=3", "UMask=0077",
      "Environment=" + quote("PATH=" + process.env.PATH),
      ...(process.env.ENCARGADO_HOME ? ["Environment=" + quote("ENCARGADO_HOME=" + config.stateDir)] : []),
      ...(process.env.ENCARGADO_PORT ? ["Environment=" + quote("ENCARGADO_PORT=" + config.landingPort)] : []),
      "", "[Install]", "WantedBy=default.target", ""];
    await writeFile(file, lines.join("\n"), { mode: 0o600 });
    await checked(run, { file: "systemctl", args: ["--user", "daemon-reload"] });
    await checked(run, { file: "systemctl", args: ["--user", "enable", "--now", "encargado.service"] });
    console.log("Installed " + file); return;
  }
  if (command === "init") {
    const manifestPath = join(path, "encargado.json");
    const value = { version: 1, project: { name: slug(basename(path)) }, services: { web: {
      driver: "elixir", purpose: "Phoenix development server", command: ["mise", "exec", "--", "mix", "phx.server"],
      ports: { http: 4000 }, ready: { path: "/", statuses: [200], timeout: 90 },
    } } };
    await writeFile(manifestPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    console.log("Created " + manifestPath + ". Configure its services and Phoenix environment contract before registering."); return;
  }
  let result: any;
  const query = values.all ? "" : "?path=" + encodeURIComponent(path);
  const post = (operation: string, data = {}) => client(config.socket, "POST", "/v1/" + operation, { path, ...data });
  if (command === "register") result = await post("register", { manifest: values.manifest ?? "encargado.json" });
  else if (command === "dev") result = await post("dev", { service: arg, manifest: values.manifest ?? "encargado.json", local: values.local === true });
  else if (command === "context") result = await client(config.socket, "GET", "/v1/context?path=" + encodeURIComponent(path));
  else if (command === "get" && arg) result = await client(config.socket, "GET", "/v1/context?path=" + encodeURIComponent(path) + "&key=" + encodeURIComponent(arg));
  else if (command === "up") result = await post("up", { service: arg });
  else if (command === "stop") result = await post("stop", { service: arg });
  else if (command === "verify") result = await client(config.socket, "GET", "/v1/verify?path=" + encodeURIComponent(path) + (arg ? "&service=" + encodeURIComponent(arg) : ""));
  else if (command === "deps" && ["up", "stop"].includes(arg)) result = await post(arg, { depsOnly: true });
  else if (["status", "urls"].includes(command)) {
    result = await client(config.socket, "GET", "/v1/status" + query);
    if (command === "urls") result = result.services.flatMap((s: any) => s.urls.map((u: any) => ({ service: s.id, name: s.name, ...u, ready: s.observed.ready, routeError: s.routeError })));
  } else if (["expose", "unexpose"].includes(command) && arg) result = await post(command, { service: arg });
  else if (command === "logs" && arg) result = await client(config.socket, "GET", "/v1/logs?path=" + encodeURIComponent(path) + "&service=" + encodeURIComponent(arg));
  else if (command === "discover") result = await client(config.socket, "GET", "/v1/routes");
  else if (["unregister", "reconcile"].includes(command)) result = await post(command);
  else throw new Problem("Unknown command. Run encargado --help.");
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (command === "get" && (typeof result === "string" || typeof result === "number" || typeof result === "boolean")) console.log(result);
  else if (result.logs !== undefined) console.log(result.logs);
  else if (Array.isArray(result.services)) {
    for (const checkout of result.checkouts) console.log("Checkout: " + checkout.path);
    for (const service of result.services) {
      console.log(service.name + "  " + service.observed.state + (service.observed.ready ? " (ready)" : "") + "  " + service.scope + " " + service.role);
      for (const endpoint of service.urls) console.log("  " + endpoint.url);
      if (service.lastError || service.routeError) console.log("  " + (service.lastError ?? service.routeError));
    }
  } else console.log(JSON.stringify(result, null, 2));
  if (["up", "expose", "dev"].includes(command) && result.services?.some((s: any) => s.routeError || (s.desired === "running" && !s.observed.ready))) process.exitCode = 1;
  if (command === "verify" && result.some((s: any) => !s.ready)) process.exitCode = 1;
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
