# Control API for Sereno and agents

Encargado owns registration, port allocation, process/container ownership, dependency ordering, and routing. Sereno displays that state and invokes the same operations as the CLI.

The API is HTTP/JSON over a mode-0600 Unix socket. Default: `$XDG_RUNTIME_DIR/encargado/control.sock`. With `ENCARGADO_HOME`, the socket is `$ENCARGADO_HOME/control.sock`. A browser frontend should call its trusted native/backend layer; it cannot access this socket directly. The browser-facing landing server does not expose the control API.

~~~sh
curl --unix-socket "$XDG_RUNTIME_DIR/encargado/control.sock" \
  http://localhost/v1/status
~~~

## Operations

| Method | Path | Input |
| --- | --- | --- |
| GET | `/v1/context` | `path`, optional dotted service `key`; registered facts without runtime probes |
| GET | `/v1/status` | Optional `path` query: checkout or a directory within it |
| GET | `/v1/verify` | `path`, optional `service` |
| GET | `/v1/logs` | `path`, `service`, optional `lines` (0–10000, default 100), `follow=true` |
| GET | `/v1/routes` | None; inspect existing Tailscale routes |
| POST | `/v1/dev` | `path`, optional `service`, relative `manifest`, `local: true` |
| POST | `/v1/register` | `path`, optional relative `manifest` |
| POST | `/v1/up` | `path`, optional `service` or `depsOnly: true` |
| POST | `/v1/stop` | `path`, optional `service` or `depsOnly: true` |
| POST | `/v1/expose` | `path`, `service` |
| POST | `/v1/unexpose` | `path`, `service` |
| POST | `/v1/unregister` | `path` |
| POST | `/v1/reconcile` | Empty object; refresh all registrations |

POST bodies are JSON objects. Paths must be absolute. Registration resolves the Git checkout root, while other operations find the closest registered checkout containing the supplied path.

Mutations are serialized. Startup waits for dependencies and readiness; use a suitably long client timeout. A failed startup returns an error and leaves diagnostics in the registry. Refresh status after an error because dependencies may already be running. Repeating register/up/stop is safe; there are no operation IDs or lifecycle event streams.

General API calls with a browser `Origin` header are rejected. The socket grants the same authority as the local user, so expose it only through a trusted client. Log snapshots are bounded to recent output but may include application-generated secrets.

## Service logs

`GET /v1/logs?path=...&service=web` returns `{ "logs": "..." }` with recent
output from that checkout's registered systemd unit or exact owned Compose
containers. `lines` controls the initial history per reader, including zero.
Log reads and subscriptions are independent of the lifecycle mutation queue.

With `follow=true`, the response is HTTP 200 with
`Content-Type: application/x-ndjson`. Each newline-terminated JSON frame contains
one complete log line (or a final partial line when a reader exits):

~~~json
{"logs":"application started\n"}
{"logs":"request completed\n"}
~~~

The initial history is followed by new stdout/stderr output. Multiple owned
containers are followed concurrently; their combined output has no global
ordering guarantee. Output uses backpressure and line-based redaction, with a
64 KiB limit per source line. A reader failure after headers have been sent emits
an `{ "error": "...", "status": 500 }` frame and closes the stream. Input and
ownership lookup errors before streaming use the usual JSON error response.

Disconnecting cancels the subscription and terminates its log-reader processes.
It never stops the application or dependency. Systemd follows the same unit
across application restarts; Docker follows the containers selected when the
subscription opens. All readers finishing, or daemon shutdown, closes the
stream. Clients reconnect explicitly after shutdown or container replacement.

~~~sh
curl --no-buffer --unix-socket "$XDG_RUNTIME_DIR/encargado/control.sock" \
  --get --data-urlencode "path=$PWD" --data-urlencode "service=web" \
  --data-urlencode "follow=true" --data-urlencode "lines=50" \
  http://localhost/v1/logs
~~~

## Project configuration lookups

`encargado context` (GET `/v1/context?path=...`) returns `version`, `project`
(`id`, `name`, `path`), `checkout` (`id`, `path`), and `services` keyed by manifest
name. Each service contains `id`, `role`, `scope`, allocated `ports`, and `urls`
keyed by alias. URLs use the registered tailnet origin when exposed; otherwise
an alias such as `office` resolves to `http://office.localhost:<allocated-port>`.
These are configuration facts, not a readiness claim.

`encargado get postgres.ports.database` selects a value beneath `services`.
The API equivalent is GET `/v1/context?path=...&key=postgres.ports.database`.
The CLI prints scalar values without JSON quotes; `--json` preserves JSON types.
Objects are JSON. Unknown keys and unregistered checkouts return 404. Object
prototype properties cannot be selected.

Lookups do not register, start, expose, read secret files, or run runtime probes.
They work while services are stopped and during a queued startup, so an application
loader can request its own settings without waiting behind its launch operation.
Only the declared public shape is returned; manifests and launch environments are
excluded. Managed commands receive `ENCARGADO_SOCKET` so their CLI lookups contact
the same daemon, including one using an alternate state directory.

## Development startup

`encargado dev [service]` (POST `/v1/dev`) serializes registration, provisioning
of the selected workloads' declared tailnet aliases, dependency/application
startup, and local/public verification. It returns the inventory plus
`verification`, using the same shape as `/v1/verify`. Public verification retries
within each service's readiness timeout to allow DNS/certificate propagation.
A healthy existing process is reused. A verification timeout leaves that process
available for diagnosis; a failed new application launch is cleaned up as for `up`.
Route failures are errors, rather than successful development startup.

`--local` / `local: true` skips creating remote aliases and retains existing
exposure. Adding URLs to a running local service or changing a running recipe
requires an explicit stop first, preserving its launch environment and origins.
Registration completes before project environment lookups and startup commands.
Bootstrap tools first as documented by the project; merely reading environment
values never creates a new checkout registration.

## Inventory

Status and successful lifecycle operations return:

~~~json
{
  "version": 1,
  "projects": [
    {
      "id": "p_...",
      "name": "my-app",
      "description": "Phoenix application",
      "path": "/home/user/Work/Projects/my-app",
      "gitCommonDir": "/home/user/Work/Projects/my-app/.git"
    }
  ],
  "checkouts": [
    {
      "id": "w_...",
      "projectId": "p_...",
      "path": "/home/user/Work/Projects/my-app",
      "manifestPath": "/home/user/Work/Projects/my-app/encargado.json",
      "services": {"postgres": "s_db...", "web": "s_web..."}
    }
  ],
  "services": [
    {
      "id": "s_web...",
      "projectId": "p_...",
      "name": "web",
      "cwd": "/home/user/Work/Projects/my-app",
      "driver": "elixir",
      "role": "workload",
      "scope": "worktree",
      "purpose": "Phoenix application",
      "consumers": ["w_..."],
      "dependencies": ["s_db..."],
      "ports": {"http": 20001},
      "owner": {"kind": "systemd", "user": true, "unit": "encargado-s_web....service"},
      "desired": "running",
      "observed": {"state": "running", "ready": true},
      "urls": [
        {
          "url": "http://127.0.0.1:17870/s/s_web...",
          "scope": "localhost",
          "source": "encargado"
        }
      ]
    }
  ]
}
~~~

IDs above are schematic; real IDs have 12 hexadecimal characters after their prefix. Treat them as opaque. Project identity uses the Git common directory, checkout identity uses its real path, and service identity includes its scope. Moving a repository/worktree changes the corresponding identity; automatic move reconciliation is not implemented.

Compose owners contain `{"kind":"compose","project":"encargado-...","service":"postgres"}`. Project-scoped services may appear in several filtered checkout inventories with the same service ID and multiple consumers. Sereno should deduplicate by ID, not display name.

`observed.state` is `running`, `stopped`, `failed`, or `unknown`. `observed.ready` is separate from process existence. Optional `observed.reason`, `lastError`, and `routeError` explain failures. `desired: running` with an observed stopped process signals a crash or incomplete start, not a healthy environment.

A lifecycle response can have HTTP 200 with a `routeError`: local startup may have succeeded while gateway programming failed. Render that distinction. `urls` lists registrations; use `verify` before claiming a tailnet URL is serving.

## Verification

`GET /v1/verify?path=...&service=web` returns an array:

~~~json
[
  {
    "service": "s_...",
    "name": "web",
    "localReady": true,
    "websocketConfigured": true,
    "endpoints": [
      {
        "url": "https://enc-my-app-web-HASH.example-tailnet.ts.net",
        "status": 200,
        "ready": true,
        "websocket": true
      }
    ],
    "ready": true
  }
]
~~~

A missing WebSocket probe yields `websocketConfigured: false` and endpoint `websocket: null`. Without tailnet endpoints, overall readiness reflects the local service. This endpoint performs real network requests; it is more expensive than status polling.

## Errors and UI behavior

Errors use `{"error":"message"}` with 400 for invalid requests, 404 for unknown registrations/operations, 409 for ownership or lifecycle conflicts, and 500 for unexpected failures.

Sereno can poll status, group project → checkout → services, display dependency edges and shared consumers, and offer Start, Start dependencies, Stop, Logs, and Open URL actions. Registration should show what the manifest declares before invoking the operation. Keep public route management and data retirement explicit.

Use the CLI immediately from an agent:

~~~sh
encargado register --path /absolute/checkout --json
encargado up web --path /absolute/checkout --json
encargado verify web --path /absolute/checkout --json
~~~

No Sereno code or MCP server is part of this repository's initial implementation.
