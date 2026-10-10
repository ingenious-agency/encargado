import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers.ts";
import { checked, run } from "../src/util.ts";
import type { Command } from "../src/model.ts";

test("release package installs under node_modules and runs the CLI and application launcher", { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "enc-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await checked(run, { file: "npm", args: ["pack", "--pack-destination", temporary], cwd: root, timeout: 60000 });
  const prefix = join(temporary, "install");
  await checked(run, { file: "npm", args: ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", join(temporary, `encargado-${version}.tgz`)], timeout: 30000 });

  const help = await checked(run, { file: join(prefix, "bin", "encargado"), args: ["--help"] });
  assert.match(help, /encargado daemon/);
  const installed = join(prefix, "lib", "node_modules", "encargado");
  const { SystemdDriver } = await import(pathToFileURL(join(installed, "dist", "drivers.js")).href);
  const f = await fixture(); t.after(f.close);
  await f.manager.register(f.project);
  const web = Object.values(f.manager.state.services).find(s => s.name === "web")!;
  web.spec.environment = { ENCARGADO_PACKAGE_FIXTURE: "package-launch-ok" };
  web.spec.command = [process.execPath, "-e", "process.stdout.write(process.env.ENCARGADO_PACKAGE_FIXTURE)"];
  let launched = false;
  const driver = new SystemdDriver(async (command: Command) => {
    // Execute the exact packaged launcher selected for systemd, without creating
    // a host unit or touching any application outside this disposable fixture.
    assert.equal(command.file, "systemd-run");
    const [file, ...args] = command.args.slice(command.args.indexOf("--") + 1);
    assert.equal(args[0], join(installed, "dist", "launch.js"));
    const result = await run({ file, args, timeout: 10000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "package-launch-ok");
    launched = true;
    return result;
  }, f.config);
  await driver.start(web, f.manager.state);
  assert.equal(launched, true);
});
