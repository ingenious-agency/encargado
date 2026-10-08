# Encargado

Encargado is a host service that registers projects, Git worktrees, services, dependencies, and development URLs. It starts Compose dependencies and Elixir/Phoenix applications, waits for readiness, and maintains private Tailscale routes. Sereno and coding agents are clients of the same manager.

This initial implementation runs on Linux, uses systemd user units to own application processes, and has no runtime npm dependencies. The registry and control API are implemented in TypeScript; Elixir/Phoenix is the supported application launcher.

## What it owns

- **Project:** one Git repository, identified by its common Git directory.
- **Checkout:** the main checkout or a worktree, identified by its real path.
- **Service:** a declared purpose, role, launch recipe, dependencies, ports, state, and URLs.
- **Dependency:** a service with the dependency role, usually backed by Compose.

Services default to worktree scope. A project-scoped service is shared by all registered worktrees and uses the recipe and files from the main checkout. Worktrees must declare an identical shared recipe. A shared service cannot depend on a worktree-scoped service.

A checked-in `encargado.json` declares intent. A private host registry stores registrations, port allocations, URL ownership, and desired state. Lifecycle and status commands observe systemd/Docker state; configuration lookups read registered facts. A saved PID or a port returning HTTP 200 is insufficient proof of ownership.

## Requirements

- Linux with an active systemd user manager, Git, and `ss` from iproute2.
- Node.js 24.12 or later; npm for development dependencies.
- Docker Engine with Compose v2 or later for Compose services, accessible by your user.
- Elixir/Erlang and the project's toolchain, normally through mise.
- Tailscale Services support on a host with access to this machine's loopback network, for remote URLs.

## Run it

~~~sh
cd ~/Work/Projects/encargado
npm ci
npm run check
npm test
./bin/encargado daemon
~~~

The daemon prints its Unix socket and local start-page port. In another terminal, use `~/Work/Projects/encargado/bin/encargado`, or optionally run `npm link` once to make `encargado` available on PATH.

With Mise, a global npm link belongs to one Node installation. To keep the CLI
available when projects switch Node versions, link it from your user bin directory
instead (that directory must be on PATH, and projects still need Node 24.12+):

~~~sh
mkdir -p ~/.local/bin
ln -s ~/Work/Projects/encargado/bin/encargado ~/.local/bin/encargado
~~~

For a persistent user service:

~~~sh
encargado install
systemctl --user status encargado
journalctl --user -u encargado
~~~

Stop a foreground daemon before installing the user service. Installation writes `~/.config/systemd/user/encargado.service`, using this checkout and the current Node executable/PATH. Keep the checkout at the same location; rerun installation after moving it or replacing Node. User lingering is a separate host choice if it must run without a login session.

## Register and run an application

Use [the Phoenix/PostgreSQL example](examples/phoenix) when adding Encargado to an existing project. Merge its Compose and Phoenix configuration into the application; do not replace existing project configuration wholesale.

~~~sh
cd ~/Work/Projects/my-app
encargado init
# Edit encargado.json; configure dependency ports and Phoenix as documented.
encargado register
encargado deps up
# Prepare application dependencies/database using the project's documented workflow.
encargado dev web
encargado urls
~~~

`init` writes a minimal web-service manifest and refuses to overwrite a file. It does not configure Phoenix or add PostgreSQL automatically. After editing an existing manifest, run `register` again. Registration is idempotent, and a failed validation preserves the previous registry.

Each new worktree runs `register` from its own checkout. Worktree-scoped services get distinct host ports, Compose project names, and named volumes. Ports remain stable while a service remains registered.

`dev` registers the checkout, ensures its declared private HTTPS aliases, starts
its dependency graph and verifies HTTP/WebSockets, retrying URL readiness within
the declared timeout. Use `dev --local` before configuring the gateway; existing
exposure is retained. Stop a running service before changing its recipe or adding
its first remote URLs.

`context` returns this checkout's public configuration facts as JSON.
`get postgres.ports.database` and `get web.urls.web` print individual facts for
project loaders such as Mise. They work while stopped and during startup, without
creating registrations or exporting secrets. See [the API](docs/api.md).

`up` starts workload services and their dependencies in dependency order. `deps up` starts only services with the dependency role and their dependencies. `up <name>` also supports explicitly starting tooling services. Applications must stay in the foreground.

~~~sh
encargado status --json
encargado status --all --json
encargado logs web
encargado stop
encargado deps stop
~~~

Stopping workloads leaves dependencies running. Stopping dependencies retains containers and data. Shared services require an explicit `stop <name>` and cannot be stopped while a running registered service depends on them.

## Phoenix and loopback

The gateway proxies to `127.0.0.1`, so applications bind to loopback and do not need `0.0.0.0`. Encargado supplies allocated ports, public URL settings, dependency port references, and exact origin allowlists. Phoenix must read those values; environment variables alone do not change endpoint configuration.

See [the Phoenix setup](docs/phoenix.md). Encargado refuses to consider an application ready when its listener binds beyond loopback or belongs to another process.

Readiness checks the actual HTTP status and, when `ready.websocketPath` is supplied, a WebSocket upgrade with the configured origin. `verify` repeats these checks through every registered tailnet URL. Without a WebSocket probe, `websocketConfigured` is false; HTTP success does not establish LiveView or hot-reload behavior.

## Persistent URLs and the Start page

Configure [Tailscale routing](docs/tailscale.md), then expose the stopped application before starting it so Phoenix receives the right public origins:

~~~sh
encargado expose web
encargado up web
encargado verify web
encargado urls --json
~~~

Each alias gets a deterministic, worktree-specific Tailscale Service hostname. Healthy services route directly to their allocated loopback port. Stopped or unhealthy services route to Encargado's landing page. Unknown addresses return 404; a known unavailable application returns 503 with a Start action for allowed users. Starting it launches the registered dependency graph and redirects once ready.

There is also a stable localhost landing URL for each HTTP service. It works without Tailscale and redirects to the application's loopback port when ready. A localhost URL cannot be opened from another machine.

Encargado reconciles runtime state and routes every five seconds. A crash can briefly leave the old upstream visible before reconciliation. URLs remain registered while an application is stopped. `unexpose <name>` retires a stopped application's gateway routes but retains its Tailscale control-plane definition.

## State and lifecycle

Default locations:

| Item | Location |
| --- | --- |
| Registry and settings | `$XDG_STATE_HOME/encargado`, default `~/.local/state/encargado` |
| Control socket | `$XDG_RUNTIME_DIR/encargado/control.sock` |
| Local landing page | `127.0.0.1:17870` |
| Port range | 20000–39999 |

If XDG_RUNTIME_DIR is unavailable, a UID-specific directory under the system temporary directory is used. `ENCARGADO_HOME=/absolute/path` overrides both state and runtime directories. `ENCARGADO_PORT` overrides the landing port. Keep that port fixed for persistent local URLs.

The daemon serializes mutations and uses atomic registry writes plus a single-instance lock. Its socket and launch recipes are private to the local user. Resolved launch recipes may contain environment-file secrets; protect the state directory and its backups. API inventory omits environment values and command arguments; application logs can still contain application-generated secrets.

Applications and containers survive an Encargado daemon restart. On restart, Encargado observes their owners and restores routing. It does not automatically restart crashed applications or replay all starts after a host reboot. Compose restart policy remains a property of the project's Compose file.

`unregister` removes a stopped checkout registration after its persistent routes have been retired. It leaves data and stopped containers in place. Port, scope, alias, and service-removal changes currently require explicit unregister/re-registration; a stopped service's other recipe fields can be updated by registration.

Compose starts use `--no-recreate`. Existing containers retain their original image/environment configuration. To change a container recipe, first stop its dependents and the dependency, inspect the exact owner IDs, and explicitly remove/recreate only that owned container while retaining its named volumes. Encargado does not run database migrations or delete data automatically.

## Clients and development

- [Manifest and environment contract](docs/manifest.md)
- [Sereno/control API](docs/api.md)
- [Shared agent instructions](docs/agent-instructions.md)
- [Tailscale setup and trust boundary](docs/tailscale.md)

Agent instructions are provided as a portable document and an always-loaded reference snippet. Installing this project does not alter provider-wide instructions or Sereno. The current agent interface is the CLI with `--json`; no MCP server is included yet.

~~~sh
npm run check
npm test
npm run test:live
npm run test:phoenix
~~~

The default tests use isolated registries and fake runtime drivers. The live test requires a working systemd user manager and the locally available `postgres:17-alpine` image; it creates two temporary Git worktrees, starts real PostgreSQL/Elixir services, verifies isolation and daemon recovery, then removes its own resources. The Phoenix test downloads Mix dependencies into a temporary fixture and checks a real HTTP/WebSocket endpoint with origin validation.

Real tailnet DNS, certificate issuance, service approval, and remote Start access require configuring and verifying an actual gateway. Fixture tests cover route preservation, command construction, and the Start-page authorization flow.

Tests use isolated fixtures in a shared port range; test files run sequentially,
while lifecycle concurrency is exercised explicitly within their tests.
