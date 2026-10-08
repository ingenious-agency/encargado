import test from "node:test";
import assert from "node:assert/strict";
import { redact, run } from "../src/util.ts";

test("redaction removes complete authorization credentials and quoted secrets", () => {
  const cases = [
    ["Authorization: Bearer fixture-credential status=401", "Authorization: [redacted] status=401"],
    ["proxy-authorization: bAsIc\tfixture-credential\r\n", "proxy-authorization: [redacted]\r\n"],
    ['{"Authorization":"Bearer fixture-credential","status":401}', '{"Authorization":"[redacted]","status":401}'],
    ['password="two words, fixture-credential" status=401', 'password="[redacted]" status=401'],
    ["SECRET='two words; fixture-credential'", "SECRET='[redacted]'"],
    ['{"api_key":"escaped \\"quote\\" fixture-credential","ok":true}', '{"api_key":"[redacted]","ok":true}'],
    ['password="unfinished fixture-credential\r\nnext line', 'password="[redacted]"\r\nnext line'],
    ['password="unfinished fixture-credential\\', 'password="[redacted]"'],
    ["token=fixture-credential; status=401", "token=[redacted]; status=401"],
    ["postgres://user:fixture-credential@localhost/db", "postgres://[redacted]@localhost/db"],
    ["ordinary application output", "ordinary application output"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact(input), expected);
    assert.equal(redact(redact(input)), expected, "redaction must be safe to apply again at the API boundary");
  }
});

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
