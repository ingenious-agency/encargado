# Working in Encargado

Encargado owns the project/worktree registry and development lifecycle. Sereno is a client.
Keep the CLI and Unix-socket API on the same manager operations.

- Support Compose dependencies and Elixir/Phoenix launch recipes. Use systemd user units for application ownership.
- Preserve unrelated infrastructure, shared dependencies, stored data, and existing Tailscale routes.
- Registration is idempotent. Match runtime resources by explicit ownership, never by a name resemblance alone.
- Keep secrets out of API responses, logs, examples, and source control. Refer to environment files.
- Test lifecycle behavior, worktree isolation, concurrency, restart recovery, and failed readiness using isolated resources.
- Run `npm run check` and `npm test`. Live tests must create and clean up only their own disposable resources.
- Keep documentation focused on the current contract and operating instructions.
