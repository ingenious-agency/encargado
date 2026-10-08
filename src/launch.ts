import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// The systemd command line contains only this private recipe's path, never its environment.
const recipe = JSON.parse(await readFile(process.argv[2], "utf8"));
const child = spawn(recipe.command[0], recipe.command.slice(1), { cwd: recipe.cwd, env: recipe.env, stdio: "inherit" });
child.on("error", error => { console.error("Encargado launch failed: " + error.message); process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
