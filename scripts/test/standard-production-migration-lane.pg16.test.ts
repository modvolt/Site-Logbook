import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectMigrationState, runMigrations, validateExpectedMigrationTransition } from "../../lib/db/src/migrate";
import { executeStandardMigration, type MigrationRequest } from "../../artifacts/api-server/src/lib/standard-production-migration";

const require = createRequire(new URL("../../lib/db/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");

test("standard migration lane on an explicitly confirmed disposable local PG16", { timeout: 60_000 }, async () => {
  assert.equal(process.env.STANDARD_PRODUCTION_MIGRATION_PG16_CONFIRM,
    "I_CONFIRM_THIS_IS_A_DISPOSABLE_LOCAL_PG16_MIGRATION_FIXTURE", "Disposable fixture confirmation required");
  const raw = process.env.STANDARD_PRODUCTION_MIGRATION_PG16_URL;
  assert.ok(raw, "Disposable fixture URL required");
  const base = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Fixture must be loopback");
  assert.equal(base.search, "", "Fixture URL overrides are forbidden");
  const admin = new Client({ connectionString: raw });
  const databaseName = `standard_lane_${randomUUID().replaceAll("-", "")}`;
  const folder = await mkdtemp(path.join(os.tmpdir(), "standard-lane-pg16-"));
  let created = false;
  let db: InstanceType<typeof Client> | undefined;
  let locker: InstanceType<typeof Client> | undefined;
  try {
    await admin.connect();
    const version = await admin.query("SHOW server_version_num");
    assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), 16);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const fixture = new URL(base); fixture.pathname = `/${databaseName}`;
    const url = fixture.toString();
    db = new Client({ connectionString: url }); await db.connect();
    await mkdir(path.join(folder, "meta"));
    // Lower target timestamp deliberately exercises the existing recovery path.
    const baseline = { idx: 0, version: "7", when: 200, tag: "fixture_baseline", breakpoints: true };
    const target = { idx: 1, version: "7", when: 100, tag: "fixture_target", breakpoints: true };
    const journal = (entries: typeof baseline[]) => writeFile(path.join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
    await journal([baseline]);
    await writeFile(path.join(folder, `${baseline.tag}.sql`), "CREATE TABLE baseline_object (id integer PRIMARY KEY);");
    const options = { migrationsFolder: folder };
    const empty = await inspectMigrationState(url, options);
    assert.equal(empty.appliedCount, 0); assert.equal(empty.currentAppliedTag, null);
    assert.deepEqual(empty.pendingTags, [baseline.tag]);
    assert.equal((await db.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS tracking")).rows[0].tracking, null);
    assert.equal((await runMigrations(url, options)).newlyApplied, 1);
    await journal([baseline, target]);
    await writeFile(path.join(folder, `${target.tag}.sql`), "CREATE TABLE target_object (id integer PRIMARY KEY);");
    const sha = "0".repeat(40);
    const ready = await inspectMigrationState(url, options);
    const request: MigrationRequest = {
      mode: "plan", expectedSourceSha: sha, expectedCurrent: baseline.tag,
      expectedTarget: target.tag, expectedRole: ready.sessionUser,
    };
    const env = { PRODUCTION_MIGRATION_DATABASE_URL: url };
    const plan = await executeStandardMigration(request, sha, env, undefined, options);
    assert.equal(plan.status, "READY"); assert.equal(plan.pendingCount, 1);
    assert.deepEqual(await inspectMigrationState(url, options), ready, "Plan changes no tracking state");
    assert.equal((await db.query("SELECT to_regclass('public.target_object') AS target")).rows[0].target, null);
    const apply = { ...request, mode: "apply" as const, backupReference: "verified-disposable-fixture" };
    await assert.rejects(executeStandardMigration(apply, sha, env, undefined, options), /CONFIRMATION_REQUIRED/);
    assert.deepEqual(await inspectMigrationState(url, options), ready);
    const confirmed = { ...apply, confirm: `APPLY:${baseline.tag}->${target.tag}` };
    await assert.rejects(executeStandardMigration({ ...confirmed, expectedRole: "wrong_role" }, sha, env, undefined, options), /ROLE_MISMATCH/);

    // The live guarded executor must fail immediately, not wait on the holder.
    locker = new Client({ connectionString: url }); await locker.connect();
    await locker.query("SELECT pg_advisory_lock($1)", [911072468]);
    const started = Date.now();
    try {
      await assert.rejects(executeStandardMigration(confirmed, sha, env, undefined, options), /MIGRATION_LOCK_BUSY/);
      assert.ok(Date.now() - started < 5000, "Busy advisory lock must fail fast");
    } finally { await locker.query("SELECT pg_advisory_unlock($1)", [911072468]); }
    assert.deepEqual(await inspectMigrationState(url, options), ready);
    const result = await executeStandardMigration(confirmed, sha, env, undefined, options);
    assert.equal(result.status, "APPLIED"); assert.equal(result.newlyApplied, 1); assert.equal(result.pendingCount, 0);
    const after = await inspectMigrationState(url, options);
    assert.equal(after.currentAppliedTag, target.tag); assert.equal(after.appliedCount, 2);
    assert.equal((await db.query("SELECT to_regclass('public.target_object') AS target")).rows[0].target, "target_object");
    await assert.rejects(executeStandardMigration(confirmed, sha, env, undefined, options), /ALREADY_APPLIED/);
    // A stale READY plan cannot bypass live validation under the migration lock.
    await assert.rejects(executeStandardMigration(confirmed, sha, env, {
      inspect: async () => ready, migrate: runMigrations,
    }, options), /ALREADY_APPLIED/);
    assert.deepEqual(await inspectMigrationState(url, options), after);

    await db.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('fixture-unknown', 999)");
    const unknown = await inspectMigrationState(url, options);
    assert.deepEqual(unknown.unknownAppliedMarkers, ["999"]);
    await assert.rejects(executeStandardMigration(confirmed, sha, env, undefined, options), /DATABASE_AHEAD/);
    await db.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 999");
    await db.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 200");
    const gap = await inspectMigrationState(url, options);
    assert.equal(gap.nonContiguousHistory, true);
    assert.throws(() => validateExpectedMigrationTransition(gap, {
      expectedCurrentTag: baseline.tag, expectedTargetTag: target.tag,
    }), /NON_CONTIGUOUS_HISTORY/);
  } finally {
    // Only this test's generated database and mkdtemp folder are removed.
    try {
      await locker?.end(); await db?.end();
      if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end(); await rm(folder, { recursive: true, force: true });
    }
  }
});
