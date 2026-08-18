import test from "node:test";
import assert from "node:assert/strict";
import {
  readStagingReleaseEnvironment,
  safeStagingReleaseSummary,
} from "../staging-release-guard.cjs";

const VALID_ENV = Object.freeze({
  NODE_ENV: "test",
  STAGING_RELEASE_CONFIRM_ISOLATED: "true",
  STAGING_DEEP_STORAGE_PROBE_CONFIRMED: "true",
  STAGING_MAIL_SANDBOX_CONFIRMED: "true",
  STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
  STAGING_ENVIRONMENT_ID: "site-logbook-staging",
  STAGING_BASE_URL: "https://stage-173.example.test",
  STAGING_EXPECTED_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
  STAGING_ADMIN_USERNAME: "staging-release-admin",
  STAGING_ADMIN_PASSWORD: "phase13-only-password",
});

test("accepts an explicitly isolated external staging target", () => {
  const config = readStagingReleaseEnvironment({ ...VALID_ENV });
  assert.equal(config.baseURL, "https://stage-173.example.test");
  assert.equal(config.expectedBuildSha, VALID_ENV.STAGING_EXPECTED_BUILD_SHA);
  assert.equal(config.externalAccountsEnabled, false);
});

test("safe summary never exposes staging credentials", () => {
  const config = readStagingReleaseEnvironment({ ...VALID_ENV });
  const serialized = JSON.stringify(safeStagingReleaseSummary(config));
  assert.doesNotMatch(serialized, /staging-release-admin/);
  assert.doesNotMatch(serialized, /phase13-only-password/);
  assert.match(serialized, /adminPasswordConfigured/);
  assert.equal(
    safeStagingReleaseSummary(config).externalAccountsEnabled,
    false,
  );
});

test("requires the external accounts dark-rollout flag to equal exactly false", () => {
  for (const value of [undefined, "", "true", "False", "0", " false "]) {
    assert.throws(
      () =>
        readStagingReleaseEnvironment({
          ...VALID_ENV,
          STAGING_EXTERNAL_ACCOUNTS_ENABLED: value,
        }),
      /STAGING_EXTERNAL_ACCOUNTS_FLAG_UNSAFE/,
    );
  }
});

test("requires all explicit safety confirmations", () => {
  for (const key of [
    "STAGING_RELEASE_CONFIRM_ISOLATED",
    "STAGING_DEEP_STORAGE_PROBE_CONFIRMED",
    "STAGING_MAIL_SANDBOX_CONFIRMED",
  ]) {
    const env = { ...VALID_ENV, [key]: "false" };
    assert.throws(() => readStagingReleaseEnvironment(env), new RegExp(key));
  }
});

test("rejects production, local, insecure, and non-origin URLs", () => {
  for (const value of [
    "https://modvoltapp.cz",
    "https://preview.modvoltapp.cz",
    "http://stage.example.test",
    "https://localhost",
    "https://[::1]",
    "https://stage.example.test/path",
    "https://user:pass@stage.example.test",
  ]) {
    assert.throws(() =>
      readStagingReleaseEnvironment({ ...VALID_ENV, STAGING_BASE_URL: value }),
    );
  }
});

test("rejects ambiguous environment IDs and non-full commit identifiers", () => {
  assert.throws(
    () =>
      readStagingReleaseEnvironment({
        ...VALID_ENV,
        STAGING_ENVIRONMENT_ID: "modvolt-staging-eu1",
      }),
    /STAGING_ENVIRONMENT_ID_UNSAFE/,
  );
  assert.throws(
    () =>
      readStagingReleaseEnvironment({
        ...VALID_ENV,
        STAGING_ENVIRONMENT_ID: "modvolt",
      }),
    /STAGING_ENVIRONMENT_ID_UNSAFE/,
  );
  assert.throws(
    () =>
      readStagingReleaseEnvironment({
        ...VALID_ENV,
        STAGING_EXPECTED_BUILD_SHA: "0123456",
      }),
    /STAGING_SHA_INVALID/,
  );
});

test("rejects production runner mode and weak staging passwords", () => {
  assert.throws(
    () =>
      readStagingReleaseEnvironment({ ...VALID_ENV, NODE_ENV: "production" }),
    /STAGING_RUNNER_IS_PRODUCTION/,
  );
  assert.throws(
    () =>
      readStagingReleaseEnvironment({
        ...VALID_ENV,
        STAGING_ADMIN_PASSWORD: "admin",
      }),
    /STAGING_PASSWORD_UNSAFE/,
  );
});
