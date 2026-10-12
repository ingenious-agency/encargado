# Tailscale routing

Encargado uses the existing Tailscale gateway as the reverse proxy. It programs a named Service per registered URL and switches its loopback upstream between the app and the stopped-service page. It does not install Caddy or open an application listener to the LAN.

## Configure the gateway

The gateway must support Tailscale Services, share the host's loopback network, and be allowed to advertise Services. The tailnet must have the relevant Service definitions, access rules, HTTPS support, and host approvals. See the official [Services setup](https://tailscale.com/kb/1552/tailscale-services) and [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Write settings to `~/.local/state/encargado/settings.json` (or `$ENCARGADO_HOME/settings.json`):

~~~json
{
  "landingPort": 17870,
  "portRange": [20000, 39999],
  "tailscale": {
    "domain": "example-tailnet.ts.net",
    "command": ["tailscale"],
    "allowedUsers": ["you@example.com"]
  }
}
~~~

Use the real tailnet DNS suffix and exact allowed user logins. The command runs as the daemon's user, without interactive sudo. Settings are read at daemon startup; restart after changing them.

If the host's established gateway runs inside Docker with host networking, the command can be:

~~~json
"command": ["docker", "exec", "home-ingress", "tailscale"]
~~~

Use the actual container name. A gateway on a separate container bridge cannot reach host services through its own `127.0.0.1`.

## File-managed gateway

When the gateway uses `TS_SERVE_CONFIG`, add the absolute **host** path to the same legacy Serve JSON file:

~~~json
"serveConfigFile": "/absolute/path/to/gateway/serve.json"
~~~

This format has top-level `TCP`, `Web`, and `Services` keys. It differs from the newer `tailscale serve set-config` input format. Encargado reads and preserves unrelated entries and changes only its registered `svc:enc-...` entries. Mount the file's containing directory into the gateway so atomic file replacement remains visible.

Treat Encargado as the sole active writer of that file while running. An optimistic change check reduces accidental overwrites, but is not a cross-process file lock. Keep persistent production entries under their existing source-control workflow; coordinate changes with the daemon stopped. In CLI mode, coordinate other writers to the same Service names as well.

Encargado never invokes `serve reset` or a global `set-config --all`. A managed Service with extra paths, ports, hostnames, or L3 forwarding is rejected before its routes are changed or removed. `unexpose` checks every alias before draining any of them and retains the registration if removal fails. Restore the intended configuration or move unrelated routes to their own Service before retrying. Discovery reads the gateway's Serve status; it does not adopt existing services or discover every port on the machine.

## Register Service definitions

With no API credential configured, create the deterministic named Services through your existing tailnet administration workflow:

1. Register the checkout and run `encargado expose web` while stopped.
2. Inspect `encargado urls --json`. Each tailnet entry includes its `svc:enc-...` name in `source`, even if routing reported a setup error.
3. Create those Services accepting `tcp:443`, with the intended tags/access policy, and approve the gateway's advertisements.
4. Run `encargado reconcile`, start the app, then `encargado verify web`.

New Service names use `svc:enc-<project>-<alias>-<worktree>`, with the worktree directory name as the final component. Names are lowercased, non-DNS characters become hyphens, and project/alias/worktree components are limited to 15/15/24 characters with leading/trailing hyphens removed. Directory names without usable characters become `project`. For example, project `my-app`, alias `web`, and directory `feature` produce `svc:enc-my-app-web-feature`. Project-scoped services use the main checkout's directory name even when exposed from a linked worktree.

The URL belongs to the registered checkout and stays stable across commits, branch switches, detached HEAD, and daemon restarts. A directory name, normalization, or truncation collision is rejected; choose a different worktree directory, project name, or alias. Before claiming a new URL, Encargado also checks for existing gateway Services and hostnames and refuses to adopt them without the registration. DNS provisioning and approval may take time; a registration is not a connectivity test.

Older hashed URLs remain registered until explicitly retired. That suffix hashes Encargado's service identity, which comes from repository/checkout paths and service name; it is not a Git commit SHA. To adopt the new naming, stop the app and run `unexpose`, then `expose` again. Create and approve the new Service as above before restarting the app, or use automatic definition creation. The old control-plane definition remains for explicit retirement by the tailnet administrator.

Optional automatic definition creation uses:

~~~json
"apiTokenEnv": "ENCARGADO_TAILSCALE_API_TOKEN",
"tags": ["tag:development"]
~~~

These are additional fields inside `tailscale`. Supply a Tailscale API access token or OAuth **access token** in the daemon environment. API keys use Basic authentication; OAuth access tokens use Bearer authentication. An OAuth client secret or device auth key is not an API access token. Automatic OAuth token refresh is not implemented.

The adapter reads `/api/v2/tailnet/-/vip-services/<service>` and creates a missing definition with port `tcp:443`. Existing definitions must already accept that port; Encargado does not rewrite their tags, ports, grants, or approval policy. Successful provisioning lookups are cached for one minute. Credentials need the permissions and tag access documented by [Tailscale's API](https://tailscale.com/docs/reference/tailscale-api).

For a systemd installation, put the token in a private environment file and reference that file from an `encargado.service` drop-in, using an absolute path:

~~~ini
[Service]
EnvironmentFile=/home/YOUR_USER/.config/encargado/private.env
~~~

Keep the environment file mode 0600. Reload the user manager and restart Encargado after creating the drop-in. Do not put credentials in the project manifest or a command argument. App launch environments do not inherit the Tailscale credential automatically.

## Start-page access

Only the landing page listens on TCP, at `127.0.0.1:17870`; the general control API is a mode-0600 Unix socket.

A request through a registered tailnet hostname offers Start only when Tailscale supplies a `Tailscale-User-Login` in `allowedUsers`. The action requires a same-origin POST and a short-lived service-specific signed token. It can only run the stored recipe; the browser cannot submit a command, working directory, or arbitrary service.

These identity headers are trusted because the intended upstream is the local Tailscale gateway. This is a single-user host trust boundary: another local process can call loopback and forge headers. Encargado is not a sandbox against the local user, malicious project code, or other users with access to the host. Tailnet policy controls application access; the Start allowlist separately controls launch access. Tagged devices may lack a human login header and can use the CLI through an authorized local session instead.

Registered development Services must not enable Funnel. Do not expose the landing listener through a generic public proxy. Review the actual tailnet grants as part of connecting the gateway.

## Retire a URL

~~~sh
encargado stop web
encargado unexpose web
~~~

This drains and clears only the registered gateway Services. Their control-plane definitions remain for explicit retirement by the tailnet administrator. The application must be stopped so it cannot keep serving with stale public-origin settings.
