import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  redactBackupDatabaseUrl,
  resolveBackupDatabaseUrl,
} from "../src/lib/backup-database-url";

const root = resolve(import.meta.dirname, "..", "..", "..");
const backupSource = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/backup.ts"),
  "utf8",
).replace(/\r\n/g, "\n");
const appSource = readFileSync(
  resolve(root, "artifacts/api-server/src/app.ts"),
  "utf8",
);
const healthSource = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/health.ts"),
  "utf8",
);
const runtimePreflightSource = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/production-runtime-preflight.ts"),
  "utf8",
);

describe("isolated backup database connection", () => {
  it("selects BACKUP_DATABASE_URL without falling back to DATABASE_URL", () => {
    const backupUrl = "postgres://backup:backup-secret@postgres:5432/admin";
    expect(resolveBackupDatabaseUrl({ BACKUP_DATABASE_URL: backupUrl })).toBe(
      backupUrl,
    );
    expect(() => resolveBackupDatabaseUrl({})).toThrow(
      "BACKUP_DATABASE_URL is required for database backup creation.",
    );
    expect(backupSource).toContain("resolveBackupDatabaseUrl()");
    expect(backupSource).not.toMatch(
      /BACKUP_DATABASE_URL\s*\?\?\s*process\.env\.DATABASE_URL/,
    );
  });

  it("keeps API runtime database clients on DATABASE_URL", () => {
    expect(appSource).toContain("conString: process.env.DATABASE_URL");
    expect(appSource).not.toContain("BACKUP_DATABASE_URL");
    expect(backupSource).toContain(
      "const runtimeDatabaseUrl = process.env.DATABASE_URL",
    );
    expect(backupSource).toContain("databaseUrl: runtimeDatabaseUrl");
  });

  it("does not disclose the backup connection or password in failures", () => {
    const secret = "postgres://backup:p%40ssword@postgres:5432/admin";
    const message = redactBackupDatabaseUrl(
      `pg_dump failed for ${secret}; password p@ssword`,
      secret,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("p%40ssword");
    expect(message).not.toContain("p@ssword");
    expect(message).toContain("[REDACTED_BACKUP_DATABASE_URL]");
  });

  it("keeps backup failures non-blocking for API readiness", () => {
    expect(healthSource).not.toContain("BACKUP_DATABASE_URL");
    expect(runtimePreflightSource).toContain(
      "backup: Object.freeze({ status: backupStatus, blocking: false as const })",
    );
  });

  it("uses the backup URL only for dump reads and runtime URL for outcome writes", () => {
    expect(backupSource).toContain("runPgDump(backupDatabaseUrl");
    expect(backupSource).toContain(
      "withExportedBackupSnapshot(\n        backupDatabaseUrl",
    );
    expect(backupSource).not.toContain("runPgDump(runtimeDatabaseUrl");
    expect(backupSource).toContain("databaseUrl: runtimeDatabaseUrl");
  });
});
