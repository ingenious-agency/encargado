import { Problem, type Service, type Endpoint, type Settings, type Runner } from "./model.ts";
import { atomicJson, checked, hash, readJson, slug } from "./util.ts";

export interface Routes {
  endpoints(service: Service, projectName: string): Endpoint[];
  apply(service: Service, target: string): Promise<void>;
  remove(service: Service): Promise<void>;
  discover(): Promise<unknown>;
}
export class TailscaleRoutes implements Routes {
  settings: Settings; runner: Runner;
  provisioned = new Map<string, number>();
  constructor(settings: Settings, runner: Runner) { this.settings = settings; this.runner = runner; }
  endpoints(service: Service, projectName: string): Endpoint[] {
    const ts = this.settings.tailscale;
    if (!ts) throw new Problem("Configure tailscale.domain in Encargado settings before exposing URLs");
    return service.spec.urls.map(name => {
      const label = "enc-" + slug(projectName).slice(0, 15) + "-" + slug(name).slice(0, 15) + "-" + hash(service.id + name).slice(0, 10);
      const hostname = label + "." + ts.domain;
      return { name, serviceName: "svc:" + label, hostname, url: "https://" + hostname };
    });
  }
  async command(args: string[]) {
    const prefix = this.settings.tailscale?.command ?? ["tailscale"];
    return checked(this.runner, { file: prefix[0], args: [...prefix.slice(1), ...args], timeout: 30000 });
  }
  async provision(endpoint: Endpoint) {
    const ts = this.settings.tailscale!;
    const token = ts.apiTokenEnv ? process.env[ts.apiTokenEnv] : undefined;
    if (ts.apiTokenEnv && !token) throw new Problem("The daemon is missing " + ts.apiTokenEnv);
    if (!token) return; // Pre-created, approved Services work without an API credential.
    if ((this.provisioned.get(endpoint.serviceName) ?? 0) > Date.now()) return;
    const authorization = token.startsWith("tskey-api-") ? "Basic " + Buffer.from(token + ":").toString("base64") : "Bearer " + token;
    const url = "https://api.tailscale.com/api/v2/tailnet/-/vip-services/" + encodeURIComponent(endpoint.serviceName);
    const get = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(10000) });
    if (get.ok) {
      const definition = await get.json() as { ports?: string[] };
      if (!definition.ports?.includes("tcp:443")) throw new Problem("Existing Tailscale Service must accept tcp:443: " + endpoint.serviceName);
      this.provisioned.set(endpoint.serviceName, Date.now() + 60000); return;
    }
    await get.arrayBuffer();
    if (get.status !== 404) throw new Problem("Tailscale service lookup failed (HTTP " + get.status + ")");
    const put = await fetch(url, {
      method: "PUT", headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ name: endpoint.serviceName, ports: ["tcp:443"], tags: ts.tags ?? [], comment: "Managed by Encargado" }),
      signal: AbortSignal.timeout(10000),
    });
    await put.arrayBuffer();
    if (!put.ok) throw new Problem("Tailscale service creation failed (HTTP " + put.status + ")");
    this.provisioned.set(endpoint.serviceName, Date.now() + 60000);
  }
  async apply(service: Service, target: string) {
    if (!service.endpoints.length) return;
    const ts = this.settings.tailscale;
    if (!ts) throw new Problem("Tailscale settings are unavailable");
    const upstream = new URL(target);
    if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new Problem("Route upstream must use HTTP on host loopback");
    for (const endpoint of service.endpoints) {
      if (!endpoint.serviceName.startsWith("svc:enc-")) throw new Problem("Refusing to manage a Service outside Encargado's namespace");
      await this.provision(endpoint);
    }
    const existing = ts.serveConfigFile ? await readJson(ts.serveConfigFile) : JSON.parse(await this.command(["serve", "status", "--json"]));
    const before = JSON.stringify(existing);
    for (const endpoint of service.endpoints) {
      if (!endpoint.serviceName.startsWith("svc:enc-")) throw new Problem("Refusing to manage a Service outside Encargado's namespace");
      const current = existing.Services?.[endpoint.serviceName];
      if (current?.AllowFunnel && Object.values(current.AllowFunnel).some(Boolean)) throw new Problem("Managed development Services cannot enable Funnel");
      // Reconcile only the exact registered service. Never reset or replace all Serve configuration.
      const config = { TCP: { "443": { HTTPS: true } }, Web: { [endpoint.hostname + ":443"]: { Handlers: { "/": { Proxy: target } } } } };
      if (current && JSON.stringify(current) !== JSON.stringify(config)) {
        const hosts = Object.keys(current.Web ?? {});
        if (hosts.some(host => host !== endpoint.hostname + ":443") || Object.keys(current.TCP ?? {}).some(port => port !== "443") ||
          hosts.some(host => Object.keys(current.Web[host].Handlers ?? {}).some(path => path !== "/"))) throw new Problem("Existing Tailscale Service has additional routes; inspect it before changing ownership");
      }
      if (ts.serveConfigFile) {
        existing.Services ??= {};
        existing.Services[endpoint.serviceName] = config;
      } else if (JSON.stringify(current) !== JSON.stringify(config)) {
        await this.command(["serve", "--service=" + endpoint.serviceName, "--https=443", "--yes", target]);
      }
    }
    if (ts.serveConfigFile && JSON.stringify(existing) !== before) {
      if (JSON.stringify(await readJson(ts.serveConfigFile)) !== before) throw new Problem("Gateway configuration changed concurrently; retry reconciliation");
      await atomicJson(ts.serveConfigFile, existing);
    }
    for (const endpoint of service.endpoints) await this.command(["serve", "advertise", endpoint.serviceName]);
  }
  async remove(service: Service) {
    const ts = this.settings.tailscale;
    if (!ts) throw new Problem("Tailscale settings are unavailable");
    for (const endpoint of service.endpoints) {
      if (!endpoint.serviceName.startsWith("svc:enc-")) throw new Problem("Refusing to remove an unrelated route");
      await this.command(["serve", "drain", endpoint.serviceName]);
      if (ts.serveConfigFile) {
        const config = await readJson(ts.serveConfigFile);
        delete config.Services?.[endpoint.serviceName];
        await atomicJson(ts.serveConfigFile, config);
      }
      await this.command(["serve", "clear", endpoint.serviceName]);
    }
  }
  async discover() {
    const config = JSON.parse(await this.command(["serve", "status", "--json"]));
    const routes: { hostname: string; path: string; backend: string | null; service: string | null; scope: string }[] = [];
    const collect = (value: any, service: string | null) => {
      for (const [host, web] of Object.entries(value.Web ?? {}) as [string, any][]) {
        for (const [path, handler] of Object.entries(web.Handlers ?? {}) as [string, any][]) {
          routes.push({ hostname: host, path, backend: handler.Proxy ?? null, service, scope: value.AllowFunnel?.[host] || config.AllowFunnel?.[host] ? "public" : "tailnet" });
        }
      }
    };
    collect(config, null);
    for (const [name, value] of Object.entries(config.Services ?? {})) collect(value, name);
    return routes;
  }
}
