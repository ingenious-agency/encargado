defmodule EncargadoFixture.Application do
  use Application

  def start(_type, _args) do
    Supervisor.start_link(
      [
        {Phoenix.PubSub, name: EncargadoFixture.PubSub},
        EncargadoFixture.Endpoint
      ],
      strategy: :one_for_one
    )
  end
end

defmodule EncargadoFixture.Socket do
  use Phoenix.Socket
  def connect(_params, socket, _info), do: {:ok, socket}
  def id(_socket), do: nil
end

defmodule EncargadoFixture.Endpoint do
  use Phoenix.Endpoint, otp_app: :encargado_fixture
  socket "/socket", EncargadoFixture.Socket, websocket: true, longpoll: false
  plug :respond
  defp respond(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "encargado-phoenix-fixture")
end
