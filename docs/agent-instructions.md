# Encargado instructions for coding agents

Use Encargado for the lifecycle and inventory of development environments on this host. It maps projects, worktrees, services, dependencies, ports, and URLs so agents and Sereno see the same state.

## Always-loaded reference

Add this short reference to the persistent instructions your agent runner loads for every session:

> This host uses Encargado for project/worktree registration, Compose dependencies, Elixir/Phoenix servers, and development URLs. Before starting or changing a development environment, read `~/Work/Projects/encargado/docs/agent-instructions.md`. Use the Encargado CLI and registered recipes, and verify the resulting service/URL.

This repository does not edit provider-wide instruction files automatically. Keep the detailed contract here and the always-loaded reference short.

## Workflow

1. Determine the current Git checkout/worktree. Read its instructions, `encargado.json`, Compose configuration, and Phoenix development config.
2. If it has no manifest, use `encargado init` or the Phoenix example. Register the whole project inventory: project purpose, service purposes/roles, scope, dependencies, ports, startup command, readiness, and URL aliases. Include databases and workers even when they do not have URLs.
3. Default dependencies to worktree scope. Use project scope only when the project intentionally shares the service/data; the main checkout owns its canonical recipe.
4. Configure Phoenix to read the allocated loopback port and exact public origins. Configure Compose to use the generated port variables and namespaced storage. Read `docs/phoenix.md` and `docs/manifest.md`.
5. Run `encargado register --json` from this checkout. After manifest changes, register again. Do not edit the host registry file directly.
6. Use `encargado context --json` or `encargado get <service>.ports.<name>` / `get <service>.urls.<alias>` for project environment loaders. These are read-only, secret-free facts available during startup; register before invoking a loader in a new checkout. Inspect `encargado status --json`. For dependencies alone, use `encargado deps up --json`. For normal development, use `encargado dev web --json` (substitute the registered name); this registers, exposes declared private URLs, starts the dependency graph, and verifies HTTP/WebSockets. Use `--local` to skip new exposure. `up web` remains the lower-level start operation.
7. For a remote URL, configure the gateway once as documented, then run `encargado expose web --json` while the app is stopped, followed by `up`. Retrieve the assigned URL with `encargado urls --json`; never invent the hostname.
8. Run `encargado verify web --json`. Check the public HTTP response and configured WebSocket probe. If none is configured, report that fact and test LiveView/hot reload in the browser when relevant.
9. Report the registered project/checkout, services started, and working URLs. If local startup succeeded but routing failed, report both states and the concrete route error.

Commands default to the current directory; `--path /absolute/checkout` is available from elsewhere. `status --all --json` maps every registered project. If the daemon is unavailable, follow the README's foreground/service setup rather than spawning duplicate daemons.

## Ownership and cleanup

Use `encargado logs <service>` and observed state to diagnose failures. Do not kill a process because it occupies an expected port, reset the shared gateway, or run an unscoped `docker compose down`.

Stop workloads with `encargado stop`, private dependencies with `encargado deps stop`, and a shared dependency explicitly by name once no running consumer needs it. Data is retained. Do not delete volumes or application data as part of routine cleanup.

Credentials belong in ignored, private environment files. Do not paste their values into a manifest, API response, command argument, or report. Compose environment-file changes do not update existing containers automatically; read the README's explicit recreation procedure.

Registered recipes are executable project code and need the same review as any code you run. Tailnet access and launch access are configured separately. Do not disable origin checking or expose a service publicly to work around a configuration error.
