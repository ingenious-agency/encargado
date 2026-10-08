# Configure a Phoenix project

Copy or merge the files in [examples/phoenix](../examples/phoenix). Replace the project name and adapt the database configuration to your app. Create an ignored `.env.local` from `.env.example`, then run `encargado register`.

Add the following **after existing development endpoint settings**, normally in `config/runtime.exs`. Replace `:my_app`, `MyAppWeb.Endpoint`, and `MyApp.Repo` with the project's modules:

~~~elixir
if config_env() == :dev and System.get_env("ENCARGADO_SERVICE") do
  port = System.fetch_env!("PORT") |> String.to_integer()

  config :my_app, MyAppWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: port],
    url: [
      host: System.fetch_env!("PHX_HOST"),
      scheme: System.fetch_env!("PHX_SCHEME"),
      port: System.fetch_env!("PHX_PUBLIC_PORT") |> String.to_integer()
    ],
    check_origin: System.fetch_env!("ENCARGADO_ORIGINS") |> String.split(",")

  config :my_app, MyApp.Repo,
    url: System.fetch_env!("DATABASE_URL")
end
~~~

Keep the existing endpoint secret, adapter, watchers, live-reload configuration, and other application settings. Check for conflicting database connection fields in existing config. If the project uses HTTPS redirects or relies on the request scheme, configure its existing proxy-header handling for the trusted loopback gateway.

Encargado launches `mix phx.server` inside the checkout and injects this contract for every managed start. The registered startup command can instead be `mise run serve`, with a project task running `mix local.setup` followed by `mix phx.server` as separate processes. A project-owned script that prepares the database and finally uses `exec mise exec -- mix phx.server` is also supported. A migration failure should terminate that script; Encargado will report a failed start.

## Readiness and WebSockets

Choose an HTTP readiness path that returns a reliable status after the application can serve. Prefer a health endpoint if the home page requires a seeded database or login. Expected redirects can be listed explicitly, but a redirect alone provides less evidence of application health.

For an existing Phoenix socket that accepts an unauthenticated handshake, configure:

~~~json
"ready": {
  "path": "/health",
  "statuses": [200],
  "timeout": 90,
  "websocketPath": "/socket/websocket?vsn=2.0.0"
}
~~~

Use the socket your application actually exposes. Do not assume `/live/websocket` accepts a handshake without LiveView session parameters. Encargado checks the HTTP upgrade and origin, not application channel messages. Test LiveView and live reload in the browser through the resulting tailnet URL as part of onboarding.

Register/expose before launching so every public alias is in `check_origin`. Stop and restart the server after changing its public origins. Do not globally set `check_origin: false`.

The integration fixture in `test/fixtures/phoenix` demonstrates a real Phoenix/Bandit server with a socket, allocated port, and strict origins. Run `npm run test:phoenix` to exercise it under a systemd user unit.
