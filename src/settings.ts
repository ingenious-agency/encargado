import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { Problem, type Settings } from "./model.ts";
import { readJson, strings } from "./util.ts";

export async function settings(): Promise<Settings> {
  const home = process.env.ENCARGADO_HOME;
  const stateDir = home ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "encargado");
  const runtime = home ?? join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), "encargado-" + process.getuid!()), "encargado");
  const raw = await readJson(join(stateDir, "settings.json"), {});
  const port = Number(process.env.ENCARGADO_PORT ?? raw.landingPort ?? 17870);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Problem("Invalid landingPort");
  const range: [number, number] = raw.portRange ?? [20000, 39999];
  if (range.length !== 2 || range.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || range[0] > range[1]) throw new Problem("Invalid portRange");
  const config: Settings = { stateDir, socket: process.env.ENCARGADO_SOCKET ?? join(runtime, "control.sock"), landingPort: port, portRange: range };
  if (!isAbsolute(stateDir) || !isAbsolute(config.socket) || Buffer.byteLength(config.socket) > 100) throw new Problem("Encargado state/socket paths must be absolute and the socket path must fit a Unix socket");
  if (raw.tailscale) {
    const ts = raw.tailscale;
    if (typeof ts.domain !== "string" || !/^[a-z0-9-]+\.ts\.net$/.test(ts.domain)) throw new Problem("tailscale.domain must be your tailnet's *.ts.net domain");
    const command = strings(ts.command ?? ["tailscale"], "tailscale.command");
    if (!command.length) throw new Problem("tailscale.command cannot be empty");
    if (ts.apiTokenEnv && (typeof ts.apiTokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(ts.apiTokenEnv))) throw new Problem("tailscale.apiTokenEnv must name an environment variable");
    if (ts.tags && strings(ts.tags, "tailscale.tags").some(tag => !/^tag:[a-z0-9-]+$/.test(tag))) throw new Problem("Invalid Tailscale service tag");
    if (ts.serveConfigFile && !isAbsolute(ts.serveConfigFile)) throw new Problem("tailscale.serveConfigFile must be absolute");
    config.tailscale = { domain: ts.domain, command, allowedUsers: strings(ts.allowedUsers ?? [], "tailscale.allowedUsers"),
      ...(ts.serveConfigFile ? { serveConfigFile: ts.serveConfigFile } : {}),
      ...(ts.apiTokenEnv ? { apiTokenEnv: ts.apiTokenEnv } : {}),
      tags: strings(ts.tags ?? [], "tailscale.tags") };
  }
  return config;
}
