const PRODUCTION_HOSTS = new Set(["modvoltapp.cz", "www.modvoltapp.cz"]);
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);
const STAGING_NAME_PATTERN =
  /(^|[._-])(stage|staging|test|qa|sandbox|preview)([._-]|$)/i;
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

class StagingReleaseGuardError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingReleaseGuardError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingReleaseGuardError(code, message);
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) {
    fail("STAGING_ENV_MISSING", `${key} is required.`);
  }
  return value;
}

function requireTrue(env, key, reason) {
  if (env[key] !== "true") {
    fail(
      "STAGING_CONFIRMATION_MISSING",
      `${key}=true is required to ${reason}.`,
    );
  }
}

function parseExternalStagingOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("STAGING_URL_INVALID", "STAGING_BASE_URL must be an absolute URL.");
  }

  if (url.protocol !== "https:") {
    fail("STAGING_URL_NOT_HTTPS", "STAGING_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password) {
    fail(
      "STAGING_URL_HAS_CREDENTIALS",
      "STAGING_BASE_URL must not contain credentials.",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    fail(
      "STAGING_URL_NOT_ORIGIN",
      "STAGING_BASE_URL must be a bare origin without path, query, or fragment.",
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (PRODUCTION_HOSTS.has(hostname) || hostname.endsWith(".modvoltapp.cz")) {
    fail(
      "STAGING_TARGET_IS_PRODUCTION",
      `Refusing production host ${hostname}.`,
    );
  }
  if (LOCAL_HOSTS.has(hostname)) {
    fail(
      "STAGING_TARGET_IS_LOCAL",
      `External staging cannot use local host ${hostname}.`,
    );
  }

  return url.origin;
}

function readStagingReleaseEnvironment(env = process.env) {
  if (env.NODE_ENV === "production") {
    fail(
      "STAGING_RUNNER_IS_PRODUCTION",
      "The staging gate must not run with NODE_ENV=production.",
    );
  }

  requireTrue(
    env,
    "STAGING_RELEASE_CONFIRM_ISOLATED",
    "target an isolated staging environment",
  );
  requireTrue(
    env,
    "STAGING_DEEP_STORAGE_PROBE_CONFIRMED",
    "allow the admin health write/delete storage probe",
  );
  requireTrue(
    env,
    "STAGING_MAIL_SANDBOX_CONFIRMED",
    "confirm outbound mail is trapped by a sandbox",
  );

  const environmentId = required(env, "STAGING_ENVIRONMENT_ID");
  if (!STAGING_NAME_PATTERN.test(environmentId)) {
    fail(
      "STAGING_ENVIRONMENT_ID_UNSAFE",
      "STAGING_ENVIRONMENT_ID must contain a distinct stage, staging, test, qa, sandbox, or preview segment.",
    );
  }

  const baseURL = parseExternalStagingOrigin(required(env, "STAGING_BASE_URL"));
  const expectedBuildSha = required(
    env,
    "STAGING_EXPECTED_BUILD_SHA",
  ).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(expectedBuildSha)) {
    fail(
      "STAGING_SHA_INVALID",
      "STAGING_EXPECTED_BUILD_SHA must be a full 40-character Git SHA.",
    );
  }

  const adminUsername = required(env, "STAGING_ADMIN_USERNAME");
  const adminPassword = required(env, "STAGING_ADMIN_PASSWORD");
  if (adminPassword.length < 16 || adminPassword.toLowerCase() === "admin") {
    fail(
      "STAGING_PASSWORD_UNSAFE",
      "STAGING_ADMIN_PASSWORD must be at least 16 characters and must not be admin.",
    );
  }

  return Object.freeze({
    environmentId,
    baseURL,
    expectedBuildSha,
    adminUsername,
    adminPassword,
  });
}

function safeStagingReleaseSummary(config) {
  return {
    schemaVersion: 1,
    environmentId: config.environmentId,
    baseOrigin: config.baseURL,
    expectedBuildSha: config.expectedBuildSha,
    isolationConfirmed: true,
    deepStorageProbeConfirmed: true,
    mailSandboxConfirmed: true,
    adminUsernameConfigured: Boolean(config.adminUsername),
    adminPasswordConfigured: Boolean(config.adminPassword),
  };
}

exports.StagingReleaseGuardError = StagingReleaseGuardError;
exports.readStagingReleaseEnvironment = readStagingReleaseEnvironment;
exports.safeStagingReleaseSummary = safeStagingReleaseSummary;

if (require.main === module) {
  try {
    const config = readStagingReleaseEnvironment();
    process.stdout.write(
      `${JSON.stringify(safeStagingReleaseSummary(config), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
