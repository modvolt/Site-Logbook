import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertSafeLocalTestDatabase,
  SENSITIVE_TEST_ENV_PATTERNS,
} from "./assert-safe-test-env.mjs";

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(root, "artifacts", "api-server");
const testDirectory = join(apiDirectory, "test");
const vitestCli = join(apiDirectory, "node_modules", "vitest", "vitest.mjs");
const tsxCli = join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const migrateCli = join(root, "lib", "db", "src", "migrate-cli.ts");
const isolatedBackupRestore = process.argv.includes("--backup-restore-isolated");

const testDatabaseUrl = new URL(assertSafeLocalTestDatabase(process.env));
const adminUrl = new URL(testDatabaseUrl);
adminUrl.pathname = "/postgres";

const childEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!SENSITIVE_TEST_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
    childEnv[key] = value;
  }
}
Object.assign(childEnv, {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MIGRATIONS_DIR: join(root, "lib", "db", "migrations"),
  SESSION_SECRET: "isolated-test-session-secret-not-for-production",
  BACKUP_TRIGGER_SECRET: "isolated-backup-trigger-secret-not-for-production",
  AUTH_DB_TEST_ENABLED: "true",
  AUTHORIZATION_DB_TEST_ENABLED: "true",
  ATOMIC_JOB_DB_TEST_ENABLED: "true",
  JOB_STATUS_DB_TEST_ENABLED: "true",
  SECRET_PERSISTENCE_DB_TEST_ENABLED: "true",
});

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function configureIsolatedBackupRestoreEnvironment() {
  if (!isolatedBackupRestore) return;
  const endpoint = new URL(process.env.S3_ENDPOINT ?? "");
  const bucket = process.env.S3_BUCKET ?? "";
  if (
    process.env.BACKUP_RESTORE_TEST_ENABLED !== "true" ||
    process.env.BACKUP_RESTORE_TEST_CONFIRM_ISOLATED !== "true" ||
    endpoint.protocol !== "http:" ||
    endpoint.search !== "" ||
    !isLoopbackHostname(endpoint.hostname) ||
    !bucket.toLowerCase().includes("test") ||
    process.env.S3_FORCE_PATH_STYLE !== "true"
  ) {
    throw new Error(
      "Isolated backup restore runner requires explicit opt-in, a loopback HTTP S3 endpoint, " +
        "a bucket containing 'test', and S3_FORCE_PATH_STYLE=true.",
    );
  }

  const allowed = [
    "BACKUP_RESTORE_TEST_ENABLED",
    "BACKUP_RESTORE_TEST_CONFIRM_ISOLATED",
    "BACKUP_RESTORE_TEST_TIMEOUT_MS",
    "FULL_OBJECT_RESTORE_TEST_ENABLED",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
    "BACKUP_ENCRYPTION_KEYRING",
    "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
  ];
  for (const key of allowed) {
    const value = process.env[key];
    if (value) childEnv[key] = value;
  }
}

configureIsolatedBackupRestoreEnvironment();

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlFor(name) {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function databaseName(prefix, discriminator) {
  const digest = createHash("sha256").update(discriminator).digest("hex").slice(0, 10);
  const suffix = `_p10_${digest}`;
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 63 - suffix.length);
  return `${safePrefix}${suffix}`;
}

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function selectedTestFiles() {
  const selectors = process.argv
    .slice(2)
    .filter((arg) => arg !== "--all" && arg !== "--backup-restore-isolated");
  const files = readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
  if (selectors.length === 0) return files;
  const selected = files.filter((file) => selectors.some((selector) => file.includes(selector)));
  if (selected.length === 0) {
    throw new Error(`No API test file matched: ${selectors.join(", ")}`);
  }
  return selected;
}

async function createDatabase(pool, name, template = "template0") {
  await pool.query(
    `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(template)}`,
  );
}

async function dropDatabase(pool, name) {
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
}

async function main() {
  const testFiles = selectedTestFiles();
  const baseName = decodeURIComponent(testDatabaseUrl.pathname.replace(/^\//, ""));
  const runId = `${process.pid}-${Date.now()}`;
  const templateName = databaseName(baseName, `template-${runId}`);
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const failures = [];
  let templateCreated = false;

  try {
    await createDatabase(adminPool, templateName);
    templateCreated = true;

    const templateUrl = databaseUrlFor(templateName);
    const migrationStatus = runNode([tsxCli, migrateCli], {
      cwd: root,
      env: { ...childEnv, DATABASE_URL: templateUrl },
    });
    if (migrationStatus !== 0) {
      throw new Error(`Failed to migrate isolated template database ${templateName}.`);
    }

    console.log(
      `[test:db] Running ${testFiles.length} API test files, one disposable database per file.`,
    );

    for (const [index, file] of testFiles.entries()) {
      const suiteName = databaseName(baseName, `${runId}-${index}-${file}`);
      const suiteUrl = databaseUrlFor(suiteName);
      console.log(`[test:db] ${index + 1}/${testFiles.length} ${file}`);
      try {
        await createDatabase(adminPool, suiteName, templateName);
        const suiteEnv = {
          ...childEnv,
          DATABASE_URL: suiteUrl,
        };
        if (isolatedBackupRestore) {
          suiteEnv.BACKUP_DATABASE_URL = suiteUrl;
        }
        const status = runNode(
          [
            vitestCli,
            "run",
            "--config",
            "vitest.db.config.ts",
            join("test", file),
            "--maxWorkers=1",
            "--reporter=dot",
          ],
          {
            cwd: apiDirectory,
            env: suiteEnv,
          },
        );
        if (status !== 0) failures.push(file);
      } finally {
        await dropDatabase(adminPool, suiteName);
      }
    }
  } finally {
    if (templateCreated) await dropDatabase(adminPool, templateName);
    await adminPool.end();
  }

  if (failures.length > 0) {
    console.error(
      `[test:db] ${failures.length}/${testFiles.length} files failed:\n${failures
        .map((file) => `  - ${relative(apiDirectory, join(testDirectory, file))}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[test:db] PASS: ${testFiles.length}/${testFiles.length} isolated files.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
