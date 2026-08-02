import { fileURLToPath } from "node:url";

export const SENSITIVE_TEST_ENV_PATTERNS = [
  /^DATABASE_URL$/i,
  /^TEST_DATABASE_URL$/i,
  /(_SECRET|_TOKEN|_PASSWORD|_KEY)$/i,
  /^(AWS|S3|HETZNER)_/i,
  /^(OBJECT_STORAGE|STORAGE_BUCKET)/i,
  /^(OPENAI|ANTHROPIC|GEMINI)_/i,
  /^(SMTP|IMAP|GMAIL)_/i,
  /^(BACKUP_RESTORE_TEST|FULL_OBJECT_RESTORE_TEST)_/i,
];

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function sensitiveEnvironmentKeys(env) {
  return Object.entries(env)
    .filter(([key, value]) => value && SENSITIVE_TEST_ENV_PATTERNS.some((pattern) => pattern.test(key)))
    .map(([key]) => key)
    .sort();
}

export function assertHermeticUnitEnvironment(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to run hermetic tests with NODE_ENV=production.");
  }
  const leakedKeys = sensitiveEnvironmentKeys(env);
  if (leakedKeys.length > 0) {
    throw new Error(`Hermetic tests refuse database/provider secrets: ${leakedKeys.join(", ")}`);
  }
}

export function assertSafeLocalTestDatabase(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to run database tests with NODE_ENV=production.");
  }
  if (env.DATABASE_URL) {
    throw new Error("Do not pass ambient DATABASE_URL to tests; use TEST_DATABASE_URL.");
  }
  const raw = env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error("TEST_DATABASE_URL is required for database tests.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!LOCAL_DATABASE_HOSTS.has(url.hostname)) {
    throw new Error(`Database tests accept only a local isolated host, got ${url.hostname}.`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error("The local database name must contain a distinct test or ci segment.");
  }
  return raw;
}

function main() {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "unit";
  if (mode === "unit") {
    assertHermeticUnitEnvironment();
    return;
  }
  if (mode === "db") {
    assertSafeLocalTestDatabase();
    return;
  }
  throw new Error(`Unknown test environment mode: ${mode}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
