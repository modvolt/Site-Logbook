import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHermeticUnitEnvironment,
  assertSafeLocalTestDatabase,
} from "../assert-safe-test-env.mjs";

test("hermetic unit mode accepts an environment without provider secrets", () => {
  assert.doesNotThrow(() => assertHermeticUnitEnvironment({ NODE_ENV: "test", PATH: "unused" }));
});

test("hermetic unit mode rejects database and provider secrets", () => {
  assert.throws(
    () => assertHermeticUnitEnvironment({ NODE_ENV: "test", DATABASE_URL: "postgres://localhost/app" }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => assertHermeticUnitEnvironment({ NODE_ENV: "test", OPENAI_API_KEY: "secret" }),
    /OPENAI_API_KEY/,
  );
  assert.throws(
    () => assertHermeticUnitEnvironment({ NODE_ENV: "test", SESSION_SECRET: "secret" }),
    /SESSION_SECRET/,
  );
});

test("database mode requires the dedicated variable and rejects ambient DATABASE_URL", () => {
  assert.throws(() => assertSafeLocalTestDatabase({ NODE_ENV: "test" }), /TEST_DATABASE_URL/);
  assert.throws(
    () => assertSafeLocalTestDatabase({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/app",
      TEST_DATABASE_URL: "postgres://localhost/modvolt_test",
    }),
    /ambient DATABASE_URL/,
  );
});

test("database mode rejects production and remote targets", () => {
  assert.throws(
    () => assertSafeLocalTestDatabase({ NODE_ENV: "production", TEST_DATABASE_URL: "postgres://localhost/modvolt_test" }),
    /NODE_ENV=production/,
  );
  assert.throws(
    () => assertSafeLocalTestDatabase({ NODE_ENV: "test", TEST_DATABASE_URL: "postgres://db.example.com/modvolt_test" }),
    /only a local isolated host/,
  );
  assert.throws(
    () => assertSafeLocalTestDatabase({ NODE_ENV: "test", TEST_DATABASE_URL: "postgres://localhost/modvolt" }),
    /test or ci segment/,
  );
});

test("database mode accepts a clearly named local isolated database", () => {
  const value = "postgres://tester:secret@127.0.0.1:5432/modvolt_test_run";
  assert.equal(assertSafeLocalTestDatabase({ NODE_ENV: "test", TEST_DATABASE_URL: value }), value);
});
