import { describe, expect, it } from "vitest";

import {
  measureProductionExact0096AuditSchemaFingerprint,
  productionExact0096PgRestoreArguments,
  productionExact0096PgRestoreEnvironment,
  summarizeProductionExact0096WriterWindow,
} from "../src/production-exact-0096-backup-host-worker";

describe("production exact-0096 host worker process boundary", () => {
  it("passes only PATH and the three non-secret disposable restore PG bindings", () => {
    const environment = productionExact0096PgRestoreEnvironment(
      {
        host: "restore-postgres",
        database: "site_logbook_restore",
        user: "site_logbook_restore",
      },
      {
        PATH: "/reviewed/bin",
        DATABASE_URL: "postgresql://secret:secret@production/site_logbook",
        S3_SECRET_ACCESS_KEY: "must-not-cross-process-boundary",
        BACKUP_ENCRYPTION_KEYRING: "must-not-cross-process-boundary",
      },
    );

    expect(environment).toEqual({
      PATH: "/reviewed/bin",
      PGHOST: "restore-postgres",
      PGDATABASE: "site_logbook_restore",
      PGUSER: "site_logbook_restore",
    });
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("BACKUP_ENCRYPTION_KEYRING");
  });

  it("binds pg_restore to the exact disposable host, database, and role", () => {
    expect(
      productionExact0096PgRestoreArguments({
        host: "restore-postgres",
        database: "site_logbook_restore",
        user: "site_logbook_restore",
      }),
    ).toEqual([
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--host",
      "restore-postgres",
      "--dbname",
      "site_logbook_restore",
      "--username",
      "site_logbook_restore",
    ]);
  });

  it("measures the fingerprint through only authoritative read-only catalog projections", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    };

    const fingerprint = await measureProductionExact0096AuditSchemaFingerprint(
      client as never,
    );

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(queries).toHaveLength(7);
    expect(
      queries.every((sql) =>
        sql.trimStart().toUpperCase().startsWith("SELECT"),
      ),
    ).toBe(true);
    expect(queries.join("\n")).toContain("pg_get_functiondef");
    expect(queries.join("\n")).toContain("pg_get_triggerdef");
  });

  it("does not classify read-only health-check transactions as database writes", () => {
    expect(
      summarizeProductionExact0096WriterWindow(
        {
          activeApplicationSessions: 0,
          activeWriteTransactions: 0,
          databaseWriteTuples: 148_260,
          completedTransactions: 4_809_428,
        },
        {
          activeApplicationSessions: 0,
          activeWriteTransactions: 0,
          databaseWriteTuples: 148_260,
          completedTransactions: 4_809_436,
        },
      ),
    ).toEqual({
      activeApplicationSessions: 0,
      activeWriteTransactions: 0,
      databaseWritesObserved: 0,
    });

    expect(
      summarizeProductionExact0096WriterWindow(
        {
          activeApplicationSessions: 0,
          activeWriteTransactions: 0,
          databaseWriteTuples: 148_260,
          completedTransactions: 4_809_436,
        },
        {
          activeApplicationSessions: 0,
          activeWriteTransactions: 0,
          databaseWriteTuples: 148_261,
          completedTransactions: 4_809_437,
        },
      ).databaseWritesObserved,
    ).toBe(1);
  });
});
