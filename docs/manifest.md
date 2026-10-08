# Manifest and environment contract

The file is JSON, named `encargado.json` by default. `register --manifest path/to/file.json` accepts another file inside the checkout.

~~~json
{
  "version": 1,
  "project": {
    "name": "my-app",
    "description": "What this project does"
  },
  "services": {
    "postgres": {
      "driver": "compose",
      "role": "dependency",
      "scope": "worktree",
      "purpose": "Development database",
      "files": ["compose.yaml"],
      "ports": {"database": 5432}
    },
    "web": {
      "driver": "elixir",
      "purpose": "Phoenix application",
      "dependsOn": ["postgres"],
      "command": ["mise", "exec", "--", "mix", "phx.server"],
      "ports": {"http": 4000},
      "ready": {"path": "/", "statuses": [200], "timeout": 90},
      "urls": ["web"]
    }
  }
}
~~~

Project/service names are lowercase slugs. URL aliases are lowercase slugs up to 25 characters and are unique within a manifest. A URL alias is a logical name; Encargado derives its actual hostname.

| Service field | Contract |
| --- | --- |
| `driver` | `elixir` or `compose`, required |
| `role` | `workload`, `dependency`, or `tooling`; defaults to workload for Elixir, dependency for Compose |
| `scope` | `worktree` (default) or `project` |
| `purpose` | Human-readable description for agents and Sereno |
| `dependsOn` | Other service names in this manifest; cycles are rejected |
| `command` | Elixir foreground command as an argv array; default `mise exec -- mix phx.server` |
| `files` | Compose files inside the checkout; defaults to `["compose.yaml"]` |
| `profiles` | Compose profiles to enable |
| `environmentFiles` | Ordered dotenv files inside the checkout, relative paths; not shell scripts |
| `environment` | String values, with `${VARIABLE}` references resolved from the prepared environment |
| `ports` | Logical names mapped to internal/container ports; host ports are allocated separately |
| `ready` | HTTP path, accepted statuses (default 200), timeout in seconds (default 90, maximum 600), optional `websocketPath` |
| `urls` | Aliases; defaults to the service name for Elixir HTTP services |

An Elixir service defaults to `ports: {"http":4000}`. A background Elixir worker can set `ports: {}` and `urls: []`; its readiness is systemd process state. Compose services require a healthcheck even if they publish no ports. A Compose service's manifest name must equal its name in the Compose file.

Commands use an argv array and are executed without a shell. If startup needs several steps, register a project-owned task such as `mise run serve` with sequential commands, or an executable script that `exec`s the final foreground server. Dependency installation and migrations are project decisions; do not hide destructive reset commands in startup.

## Generated environment

| Variable | Meaning |
| --- | --- |
| `ENCARGADO_PROJECT` | Registry project ID |
| `ENCARGADO_WORKTREE` | Recipe working directory; main checkout for shared services |
| `ENCARGADO_SERVICE` | Registry service ID |
| `ENCARGADO_SOCKET` | Control socket for lookups against the launching daemon |
| `ENCARGADO_DATA_DIR` | Private data directory for this scope |
| `ENCARGADO_<SERVICE>_<PORT>_PORT` | Allocated host port, e.g. `ENCARGADO_POSTGRES_DATABASE_PORT` |
| `PORT`, `HOST`, `PHOENIX_BIND` | Allocated HTTP port and `127.0.0.1` bind address |
| `PHX_HOST`, `PHX_SCHEME`, `PHX_PUBLIC_PORT` | Primary public URL components |
| `ENCARGADO_URL` | Primary public origin, or direct localhost origin |
| `ENCARGADO_ORIGINS` | Comma-separated public aliases plus the direct localhost origin |
| `MIX_ENV` | Defaults to `dev`; can be overridden in the service environment |

Service hyphens become underscores in environment-variable names; choose names without collisions after this normalization. Logical port names may use underscores.

Only a small toolchain/session environment is inherited from the daemon. Put application secrets in private dotenv files, load them in the project toolchain or reference them with `environmentFiles`, and add them to the application's `.gitignore`. Later files override earlier ones. The explicit `environment` map can reference those values and allocated peer ports. Values are interpolated in declaration order. The manager sets runtime bind/origin variables after user values, so they cannot be overridden.

Shared services read files from the main checkout and can reference only the shared dependency graph. Secret files for a new worktree must be provisioned separately; Git will not copy ignored files.

## Compose isolation

Use generated host-port variables in Compose and bind published ports to `127.0.0.1`. Use ordinary named volumes without an explicit global name, or bind within the checkout/`ENCARGADO_DATA_DIR`.

The manager rejects fixed/global container names, host networking, privileged/host process namespaces, external volumes/networks, and published ports that do not match the registration. Each service is started by name with `--no-deps`; any Compose `depends_on` entries must also appear in the manifest and use the same scope. Encargado controls dependency ordering.

The selected Compose service is validated at registration and before starting. Do not run the same managed recipe with a plain `docker compose up`: that uses a different project name and lacks Encargado's allocated environment.

## Project-owned dynamic settings

Encargado need not know the project's dotenv filenames. A Mise recipe can read
allocated values through the generic API and then load private dotenv settings:

~~~toml
[env]
ENCARGADO_POSTGRES_DATABASE_PORT = "{{ exec(command='encargado get postgres.ports.database') | trim }}"
_.file = { path = ".env.local", expand = true, redact = true }

[tasks.serve]
run = ["mix local.setup", "mix phx.server"]
~~~

Register the checkout before Mise resolves these lookups, including before
`mise install` in a fresh checkout. A dotenv value can use
`${ENCARGADO_POSTGRES_DATABASE_PORT}`. Keep private files ignored; version the
mapping in Mise or a dotenv template. An optional shared private file outside Git
can be loaded by the project before a checkout-specific override, avoiding secret
copies between worktrees. This is the project's choice and is not an Encargado
secret store. The manager still supplies the service identity and runtime bindings.
