import Config

port = System.get_env("PORT", "4000") |> String.to_integer()
host = System.get_env("PHX_HOST", "127.0.0.1")
scheme = System.get_env("PHX_SCHEME", "http")
public_port = System.get_env("PHX_PUBLIC_PORT", Integer.to_string(port)) |> String.to_integer()
origins = System.get_env("ENCARGADO_ORIGINS", "http://127.0.0.1:#{port}") |> String.split(",")

config :encargado_fixture, EncargadoFixture.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  server: true,
  http: [ip: {127, 0, 0, 1}, port: port],
  url: [host: host, scheme: scheme, port: public_port],
  check_origin: origins,
  secret_key_base: String.duplicate("encargado-fixture-", 5),
  pubsub_server: EncargadoFixture.PubSub
