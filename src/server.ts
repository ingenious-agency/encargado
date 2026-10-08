import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { Problem } from "./model.ts";
import { Manager } from "./manager.ts";
import { redact } from "./util.ts";

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Problem("Request too large", 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString();
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
export function client(socket: string, method: string, path: string, data?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: { "Content-Type": "application/json" }, timeout: 15 * 60 * 1000 }, async res => {
      try {
        const value = JSON.parse(await body(res));
        if ((res.statusCode ?? 500) >= 400) reject(new Problem(value.error ?? "Encargado request failed", res.statusCode));
        else resolve(value);
      } catch (error) { reject(error); }
    });
    req.on("timeout", () => req.destroy(new Error("Encargado request timed out")));
    req.on("error", error => reject(new Problem("Cannot contact Encargado at " + socket + ": " + error.message + ". Start encargado daemon.")));
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
export class Daemon {
  manager: Manager; control: Server; web: Server;
  secret = randomBytes(32); timer?: NodeJS.Timeout; closing = false; reconciling = false;
  lockToken = process.pid + ":" + randomBytes(8).toString("hex"); ownsLock = false;
  constructor(manager: Manager) {
    this.manager = manager;
    this.control = createServer((req, res) => { void this.api(req, res).catch(error => json(res, error instanceof Problem ? error.status : 500, { error: redact(error.message) })); });
    this.web = createServer((req, res) => { void this.landing(req, res).catch(error => { res.writeHead(error instanceof Problem ? error.status : 500, { "Content-Type": "text/plain" }).end(redact(error.message)); }); });
    for (const server of [this.control, this.web]) { server.requestTimeout = 15000; server.headersTimeout = 10000; }
  }
  async api(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin) throw new Problem("Browser origins are not accepted on the control API", 403);
    const url = new URL(req.url!, "http://localhost");
    let data: any = {};
    if (req.method === "POST") {
      try { data = JSON.parse(await body(req) || "{}"); }
      catch (error) { if (error instanceof SyntaxError) throw new Problem("Invalid JSON body"); throw error; }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Problem("Request body must be an object");
      if (data.manifest !== undefined && typeof data.manifest !== "string") throw new Problem("manifest must be a relative filename");
      if (data.depsOnly !== undefined && typeof data.depsOnly !== "boolean") throw new Problem("depsOnly must be a boolean");
      if (data.local !== undefined && typeof data.local !== "boolean") throw new Problem("local must be a boolean");
    }
    const path = data.path ?? url.searchParams.get("path");
    if (path !== null && path !== undefined && (typeof path !== "string" || !isAbsolute(path))) throw new Problem("path must be absolute");
    const needPath = () => { if (!path) throw new Problem("An absolute checkout path is required"); return path as string; };
    const name = data.service ?? url.searchParams.get("service");
    if (name !== undefined && name !== null && typeof name !== "string") throw new Problem("service must be a string");
    const named = () => { if (!name) throw new Problem("service is required"); return name as string; };
    let result: unknown;
    if (req.method === "GET" && url.pathname === "/v1/status") result = await this.manager.inventory(path ? await this.manager.context(path) : undefined);
    else if (req.method === "GET" && url.pathname === "/v1/context") result = url.searchParams.has("key") ? await this.manager.get(needPath(), url.searchParams.get("key")!) : await this.manager.configuration(needPath());
    else if (req.method === "GET" && url.pathname === "/v1/verify") result = await this.manager.verify(needPath(), name ?? undefined);
    else if (req.method === "GET" && url.pathname === "/v1/routes") result = await this.manager.routes.discover();
    else if (req.method === "GET" && url.pathname === "/v1/logs") result = { logs: await this.manager.drivers[this.manager.service(await this.manager.context(needPath()), named()).spec.driver].logs(this.manager.service(await this.manager.context(needPath()), named()), this.manager.state) };
    else if (req.method === "POST" && url.pathname === "/v1/register") result = await this.manager.register(needPath(), data.manifest);
    else if (req.method === "POST" && url.pathname === "/v1/dev") result = await this.manager.dev(needPath(), { service: name ?? undefined, manifest: data.manifest, local: data.local });
    else if (req.method === "POST" && url.pathname === "/v1/up") result = await this.manager.up(needPath(), { service: name ?? undefined, depsOnly: data.depsOnly === true });
    else if (req.method === "POST" && url.pathname === "/v1/stop") result = await this.manager.stop(needPath(), { service: name ?? undefined, depsOnly: data.depsOnly === true });
    else if (req.method === "POST" && url.pathname === "/v1/expose") result = await this.manager.expose(needPath(), named());
    else if (req.method === "POST" && url.pathname === "/v1/unexpose") result = await this.manager.unexpose(needPath(), named());
    else if (req.method === "POST" && url.pathname === "/v1/unregister") result = await this.manager.unregister(needPath());
    else if (req.method === "POST" && url.pathname === "/v1/reconcile") { await this.manager.reconcile(); result = await this.manager.inventory(); }
    else throw new Problem("Unknown API operation", 404);
    json(res, 200, result);
  }
  token(service: string, origin: string) {
    const payload = Buffer.from(JSON.stringify({ service, origin, expires: Date.now() + 10 * 60 * 1000 })).toString("base64url");
    return payload + "." + createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
  validToken(token: string, service: string, origin: string) {
    try {
      const [payload, signature] = token.split(".");
      const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", this.secret).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
      return decoded.service === service && decoded.origin === origin && decoded.expires > Date.now();
    } catch { return false; }
  }
  async landing(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host?.toLowerCase() ?? "";
    const forwarded = ["x-forwarded-for", "x-forwarded-proto", "forwarded", "tailscale-user-login", "tailscale-user-name", "tailscale-headers-info", "tailscale-app-capabilities"].some(key => req.headers[key] !== undefined);
    const localHost = !forwarded && (host === "127.0.0.1:" + this.manager.landingPort || host === "localhost:" + this.manager.landingPort);
    const url = new URL(req.url!, "http://localhost");
    const localId = /^\/s\/(s_[a-f0-9]{12})(?:\/start)?$/.exec(url.pathname)?.[1];
    const service = localHost && localId ? this.manager.state.services[localId] : Object.values(this.manager.state.services).find(s => s.endpoints.some(e => e.hostname === host.replace(/:443$/, "")));
    if (!service) throw new Problem("No registered service for this URL", 404);
    const origin = localHost ? "http://" + host : "https://" + host;
    const login = req.headers["tailscale-user-login"];
    const mayStart = localHost || (typeof login === "string" && this.manager.settings.tailscale?.allowedUsers.includes(login));
    const startPath = localHost ? "/s/" + service.id + "/start" : "/__encargado/start";
    const returnPath = localHost ? "/s/" + service.id : "/";
    if (req.method === "POST") {
      if (url.pathname !== startPath || !mayStart || req.headers.origin !== origin) throw new Problem("Start is not authorized", 403);
      const form = new URLSearchParams(await body(req));
      if (!this.validToken(form.get("token") ?? "", service.id, origin)) throw new Problem("Invalid or expired start token", 403);
      const checkout = this.manager.state.checkouts[service.consumers[0]];
      if (!checkout) throw new Problem("Service checkout is unavailable", 409);
      void this.manager.up(checkout.path, { service: service.name }).catch(error => console.error("Start failed for " + service.id + ": " + redact(error.message)));
      // Keep polling even if the redirect arrives before the queued start runs.
      res.writeHead(303, { Location: returnPath + "?starting=1", "Cache-Control": "no-store" }).end(); return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new Problem("Method not allowed", 405);
    const observed = await this.manager.observe(service);
    if (observed.state === "running" && observed.ready && localHost) {
      res.writeHead(302, { Location: "http://127.0.0.1:" + service.ports.http + "/", "Cache-Control": "no-store" }).end(); return;
    }
    const starting = service.status === "starting";
    const ready = observed.state === "running" && observed.ready;
    const refresh = starting || ready || (url.searchParams.get("starting") === "1" && service.status !== "failed");
    const heading = ready ? "Connecting to " + service.name : starting ? "Starting " + service.name : service.name + " is stopped";
    const project = this.manager.state.projects[service.projectId];
    const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      (refresh ? '<meta http-equiv="refresh" content="2">' : "") +
      '<title>' + escape(heading) + '</title><style>body{font:16px system-ui;color:#e8e8e8;background:#141719;max-width:640px;margin:12vh auto;padding:24px}small,p{color:#a8b1b8;line-height:1.6}h1{font-size:30px}button{font:inherit;background:#9adaae;color:#102719;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}</style>' +
      '<small>ENCARGADO · ' + escape(project.name) + '</small><h1>' + escape(heading) + '</h1><p>' +
      (starting ? "Starting its dependencies and waiting for the application to become ready." : ready ? "The application is ready. Its route is being updated." : "This address is registered. Start its development environment to continue.") +
      '</p>' + (!starting && !ready && mayStart ? '<form method="post" action="' + startPath + '"><input type="hidden" name="token" value="' + this.token(service.id, origin) + '"><button>Start development environment</button></form>' :
        !mayStart ? '<p>Start access is limited to configured Tailscale users. You can also start this environment through Encargado or Sereno.</p>' : "") + '</html>';
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "2",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      // Browsers suppress the POST Origin under no-referrer, breaking the Start
      // form's same-origin check. Keep it for local forms without cross-site referrers.
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    res.end(req.method === "HEAD" ? undefined : html);
  }
  async lock(): Promise<void> {
    const path = join(this.manager.settings.stateDir, "daemon.lock");
    await mkdir(this.manager.settings.stateDir, { recursive: true, mode: 0o700 });
    try { const file = await open(path, "wx", 0o600); await file.writeFile(this.lockToken); await file.close(); this.ownsLock = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8");
      const pid = Number(owner.split(":")[0]);
      if (!Number.isInteger(pid) || pid < 1) throw new Problem("Invalid daemon lock; inspect " + path);
      try { process.kill(pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") { await rm(path); return this.lock(); }
        throw err;
      }
      throw new Problem("Encargado is already running (PID " + pid + ")");
    }
  }
  async start() {
    await this.lock();
    try {
      await this.manager.load();
      await mkdir(dirname(this.manager.settings.socket), { recursive: true, mode: 0o700 });
      try { if (!(await stat(this.manager.settings.socket)).isSocket()) throw new Problem("Control socket path is occupied by a regular file"); await rm(this.manager.settings.socket); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise<void>((resolve, reject) => { this.web.once("error", reject); this.web.listen(this.manager.settings.landingPort, "127.0.0.1", resolve); });
      this.manager.landingPort = (this.web.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => { this.control.once("error", reject); this.control.listen(this.manager.settings.socket, resolve); });
      await chmod(this.manager.settings.socket, 0o600);
      await this.manager.reconcile();
      this.timer = setInterval(() => {
        if (this.reconciling || this.closing) return;
        this.reconciling = true;
        void this.manager.reconcile().catch(error => console.error("Reconcile: " + redact(error.message))).finally(() => { this.reconciling = false; });
      }, 5000);
      this.timer.unref();
      return { socket: this.manager.settings.socket, landingPort: this.manager.landingPort };
    } catch (error) { await this.close(); throw error; }
  }
  async close() {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    await Promise.all([this.web, this.control].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })));
    if (this.ownsLock) {
      await this.manager.queue.execute(async () => {});
      await rm(this.manager.settings.socket, { force: true });
      const path = join(this.manager.settings.stateDir, "daemon.lock");
      if (await readFile(path, "utf8").catch(() => "") === this.lockToken) await rm(path, { force: true });
      this.ownsLock = false;
    }
  }
}
