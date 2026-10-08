import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.ts";
import { Daemon } from "../src/server.ts";
import { checked, run } from "../src/util.ts";

test("the launcher registers a fresh worktree through a Mise Node shim without loading project environment", async t => {
  const f = await fixture(), daemon = new Daemon(f.manager);
  t.after(async () => { await daemon.close(); await f.close(); });
  await daemon.start();
  await f.manager.register(f.project);
  const original = await f.manager.configuration(f.project), worktree = await f.worktree();
  const shims = join(f.root, "shims"), bin = join(f.root, "bin");
  await mkdir(shims); await mkdir(bin);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  // Model Mise resolving [env] lookups before dispatching a Node shim. Only
  // --no-env which node can resolve the interpreter before registration exists.
  await writeFile(join(shims, "mise"), [
    "#!/bin/sh",
    'if [ "$1" = --no-env ] && [ "$2" = which ] && [ "$3" = node ]; then',
    "  printf '%s\\n' " + quote(process.execPath),
    "  exit 0",
    "fi",
    quote(process.execPath) + " " + quote(cli) + " get postgres.ports.database >/dev/null || exit $?",
    "exec " + quote(process.execPath) + ' "$@"',
    "",
  ].join("\n"), { mode: 0o700 });
  await symlink("mise", join(shims, "node"));
  await symlink(fileURLToPath(new URL("../bin/encargado", import.meta.url)), join(bin, "encargado"));
  const env = { ...process.env, PATH: [bin, shims, process.env.PATH].join(":"), ENCARGADO_HOME: f.config.stateDir, ENCARGADO_SOCKET: f.config.socket };
  const command = (...args: string[]) => ({ file: join(bin, "encargado"), args, cwd: worktree, env });
  const missing = await run(command("get", "postgres.ports.database"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /This checkout is not registered/);
  await assert.rejects(f.manager.configuration(worktree), /not registered/);
  const first = JSON.parse(await checked(run, command("register", "--json")));
  assert.deepEqual(JSON.parse(await checked(run, command("register", "--json"))), first);
  const facts = await f.manager.configuration(worktree);
  assert.equal(await checked(run, command("get", "postgres.ports.database")), facts.services.postgres.ports.database + "\n");
  assert.notEqual(facts.services.postgres.ports.database, original.services.postgres.ports.database);
  assert.deepEqual(await f.manager.configuration(f.project), original);
  assert.equal(f.driver.starts.length, 0);
});
