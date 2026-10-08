import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/util.ts";

test("an explicit child environment excludes daemon credentials", async t => {
  process.env.ENCARGADO_TEST_DAEMON_SECRET = "fixture-only";
  t.after(() => { delete process.env.ENCARGADO_TEST_DAEMON_SECRET; });
  const result = await run({
    file: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({leaked:!!process.env.ENCARGADO_TEST_DAEMON_SECRET, value:process.env.FIXTURE_VALUE}))"],
    env: { FIXTURE_VALUE: "prepared-environment" },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { leaked: false, value: "prepared-environment" });
});
