defmodule EncargadoFixture.MixProject do
  use Mix.Project

  def project do
    [
      app: :encargado_fixture,
      version: "0.1.0",
      elixir: "~> 1.17",
      deps: [
        {:phoenix, "~> 1.8.0"},
        {:bandit, "~> 1.8"},
        {:jason, "~> 1.4"}
      ]
    ]
  end

  def application do
    [extra_applications: [:logger], mod: {EncargadoFixture.Application, []}]
  end
end
