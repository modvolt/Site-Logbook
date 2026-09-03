import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeStandardMigration, parseMigrationArgs, resolveMigrationCredential,
  runStandardMigrationCli, verifyApplyConfirmation, verifySourceSha,
  type MigrationRequest,
} from "../src/lib/standard-production-migration";
import {
  MigrationTransitionError, validateExpectedMigrationTransition,
  validateMigrationJournal, type MigrationState,
} from "@workspace/db/migrate";

const sha = "a".repeat(40);
const secret = "unique-private-password";
const url = `postgresql://lane:${secret}@127.0.0.1/fixture`;
const env = { PRODUCTION_MIGRATION_DATABASE_URL: url };
const request: MigrationRequest = {
  mode: "plan", expectedSourceSha: sha, expectedCurrent: "baseline", expectedTarget: "target", expectedRole: "lane",
};
const ready: MigrationState = {
  migrationsFolder: "/fixture", expectedCount: 2, appliedCount: 1, expectedTags: ["baseline", "target"],
  latestExpectedTag: "target", currentAppliedTag: "baseline", pendingTags: ["target"],
  unknownAppliedMarkers: [], nonContiguousHistory: false, databaseName: "fixture", sessionUser: "lane", currentUser: "lane",
};
const guard = { expectedCurrentTag: "baseline", expectedTargetTag: "target", requireExactlyOnePending: true as const };
const applied: MigrationState = { ...ready, appliedCount: 2, currentAppliedTag: "target", pendingTags: [] };
const applyRequest: MigrationRequest = { ...request, mode: "apply", backupReference: "verified-fixture", confirm: "APPLY:baseline->target" };
const argv = ["plan", "--expected-source-sha", sha, "--expected-current", "baseline", "--expected-target", "target", "--expected-role", "lane"];
function deps() {
  return {
    inspect: vi.fn().mockResolvedValue(ready),
    migrate: vi.fn().mockResolvedValue({ newlyApplied: 1 }),
  };
}
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe("standard migration lane", () => {
  it("help and no command never touch credentials or DB, and apply is not default", async () => {
    const d = deps(); const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await runStandardMigrationCli(["help"], "", {}, io, d)).toBe(0);
    expect(await runStandardMigrationCli([], "", {}, io, d)).toBe(2);
    expect(d.inspect).not.toHaveBeenCalled(); expect(d.migrate).not.toHaveBeenCalled();
  });
  it.each([["unknown"], ["apply"], ["plan", "--wat", "x"], [...argv, "--expected-role", "lane"], argv.slice(0, -1)])("rejects invalid CLI %j", (args) => {
    expect(() => parseMigrationArgs(args)).toThrow("USAGE");
  });
  it("parses complete explicit arguments", () => expect(parseMigrationArgs(argv)).toMatchObject(request));
  it.each([
    {}, { DATABASE_URL: url }, { BACKUP_DATABASE_URL: url }, { TEST_DATABASE_URL: url },
    { ...env, PRODUCTION_MIGRATION_DATABASE_URL_FILE: "/secret" }, { PRODUCTION_MIGRATION_DATABASE_URL: "" },
    { PRODUCTION_MIGRATION_DATABASE_URL: `${url}\0` }, { PRODUCTION_MIGRATION_DATABASE_URL: `${url}\nextra` },
  ])("fails closed for credential sources", async (environment) => {
    await expect(resolveMigrationCredential(environment)).rejects.toThrow();
  });
  it("reads one private UTF-8 secret line, rejects multiline, NUL and invalid UTF-8", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "standard-lane-unit-")); folders.push(folder);
    const file = path.join(folder, "url");
    const fileEnv = { PRODUCTION_MIGRATION_DATABASE_URL_FILE: file };
    await writeFile(file, `${url}\n`, { mode: 0o600 });
    expect(await resolveMigrationCredential(fileEnv)).toBe(url);
    for (const content of [`${url}\n${url}`, `${url}\0`, "", Buffer.from([0xff])]) {
      await writeFile(file, content);
      await expect(resolveMigrationCredential(fileEnv)).rejects.toThrow();
    }
    if (process.platform !== "win32") {
      // Windows has ACLs, not POSIX mode enforcement; all content checks run there.
      await writeFile(file, url); await chmod(file, 0o640);
      await expect(resolveMigrationCredential(fileEnv)).rejects.toThrow("CREDENTIAL_FILE_INVALID");
    }
  });
  it.each(["dev", "", "a".repeat(39), "A".repeat(40)])("apply rejects non-exact build %s", (build) => {
    expect(() => verifySourceSha(applyRequest, build)).toThrow("SOURCE_SHA_INVALID");
  });
  it("rejects SHA mismatch and permits explicit dev plan only", () => {
    expect(() => verifySourceSha(request, "b".repeat(40))).toThrow("SOURCE_SHA_MISMATCH");
    expect(() => verifySourceSha({ ...request, expectedSourceSha: "dev" }, "dev")).not.toThrow();
  });
  it("plan is read-only and returns only the public result", async () => {
    const d = deps(); const result = await executeStandardMigration(request, sha, env, d);
    expect(result).toMatchObject({ status: "READY", pendingCount: 1 });
    expect(d.migrate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret); expect(result).not.toHaveProperty("migrationsFolder");
  });
  it.each([
    [{ currentAppliedTag: "wrong" }, "CURRENT_MISMATCH"],
    [{ pendingTags: [] }, "TRANSITION_NOT_READY"],
    [{ pendingTags: ["target", "extra"] }, "TRANSITION_NOT_READY"],
    [{ pendingTags: ["other"] }, "TRANSITION_NOT_READY"],
    [{ unknownAppliedMarkers: ["999"] }, "UNKNOWN_APPLIED_MARKERS"],
    [{ nonContiguousHistory: true }, "NON_CONTIGUOUS_HISTORY"],
    [{ appliedCount: 3 }, "DATABASE_AHEAD"],
    [{ expectedTags: ["baseline", "middle", "target"] }, "TARGET_NOT_NEXT"],
  ] as const)("rejects unsafe state %j", (change, code) => {
    expect(() => validateExpectedMigrationTransition({ ...ready, ...change } as MigrationState, guard)).toThrow(code);
  });
  it("rejects already-applied target", () => expect(() => validateExpectedMigrationTransition(applied, guard)).toThrow("ALREADY_APPLIED"));
  it("accepts exact one-pending transition", () => expect(() => validateExpectedMigrationTransition(ready, guard)).not.toThrow());
  it.each(["YES", "APPLY", "APPLY:wrong->target", undefined])("rejects confirmation %s before DB", async (confirm) => {
    const d = deps(); await expect(executeStandardMigration({ ...applyRequest, confirm }, sha, env, d)).rejects.toThrow("CONFIRMATION_REQUIRED");
    expect(d.inspect).not.toHaveBeenCalled();
  });
  it("requires a backup reference and accepts exact confirmation", () => {
    expect(() => verifyApplyConfirmation({ ...applyRequest, backupReference: " " })).toThrow("BACKUP_REFERENCE_REQUIRED");
    expect(() => verifyApplyConfirmation(applyRequest)).not.toThrow();
  });
  it.each(["other", "site_logbook_runtime", "site_logbook_backup"])("rejects role %s", async (role) => {
    const d = deps(); await expect(executeStandardMigration({ ...request, expectedRole: role }, sha, env, d)).rejects.toThrow("ROLE_MISMATCH");
    expect(d.migrate).not.toHaveBeenCalled();
  });
  it("also checks current_user and rechecks role in the locked guard", async () => {
    const d = deps(); d.inspect.mockResolvedValue({ ...ready, currentUser: "other" });
    await expect(executeStandardMigration(request, sha, env, d)).rejects.toThrow("ROLE_MISMATCH");
    expect(() => validateExpectedMigrationTransition({ ...ready, sessionUser: "other" }, { ...guard, expectedRole: "lane" })).toThrow("ROLE_MISMATCH");
  });
  it("applies once with the locked guard and validates post-state", async () => {
    const d = deps(); d.inspect.mockResolvedValueOnce(ready).mockResolvedValueOnce(applied);
    expect(await executeStandardMigration(applyRequest, sha, env, d)).toMatchObject({ status: "APPLIED", newlyApplied: 1, pendingCount: 0 });
    expect(d.migrate).toHaveBeenCalledWith(url, { failIfLockBusy: true, guard: { ...guard, expectedRole: "lane" } });
  });
  it("reports busy lock failure without a retry", async () => {
    const d = deps(); d.migrate.mockRejectedValue(new MigrationTransitionError("MIGRATION_LOCK_BUSY"));
    await expect(executeStandardMigration(applyRequest, sha, env, d)).rejects.toThrow("MIGRATION_LOCK_BUSY");
    expect(d.migrate).toHaveBeenCalledTimes(1);
  });
  it.each([ready, { ...applied, unknownAppliedMarkers: ["999"] }, { ...applied, nonContiguousHistory: true }])("rejects invalid post-state", async (after) => {
    const d = deps(); d.inspect.mockResolvedValueOnce(ready).mockResolvedValueOnce(after);
    await expect(executeStandardMigration(applyRequest, sha, env, d)).rejects.toThrow("POST_APPLY_STATE_MISMATCH");
  });
  it("rejects an incorrect applied count", async () => {
    const d = deps(); d.migrate.mockResolvedValue({ newlyApplied: 0 });
    await expect(executeStandardMigration(applyRequest, sha, env, d)).rejects.toThrow("APPLY_COUNT_MISMATCH");
  });
  it("never leaks raw errors, credentials, file paths or environment to stdout/stderr", async () => {
    const d = deps(); d.inspect.mockRejectedValue(new Error(`${url} ${secret} /private/secret-file`));
    const out: string[] = []; const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    expect(await runStandardMigrationCli(argv, sha, env, io, d)).toBe(1);
    expect(out).toHaveLength(1); expect(out[0]).toContain("MIGRATION_FAILED");
    for (const text of [url, secret, "/private/secret-file", "PRODUCTION_MIGRATION_DATABASE_URL"]) expect(out.join("")).not.toContain(text);
  });
  it("validates strict journal structure while preserving historical idx gaps/timestamp order", () => {
    const entries = [{ idx: 0, when: 200, tag: "a" }, { idx: 2, when: 100, tag: "b" }];
    expect(() => validateMigrationJournal({ entries })).not.toThrow();
    for (const value of [null, {}, { entries: {} }, { entries: [{ idx: 0, when: 1, tag: " " }] },
      ...["idx", "when", "tag"].map((key) => ({ entries: [entries[0], { ...entries[1], [key]: entries[0][key as keyof typeof entries[0]] }] })),
      { entries: [...entries].reverse() }, { entries: [{ ...entries[0], idx: 0.5 }] }]) {
      expect(() => validateMigrationJournal(value)).toThrow("INVALID_JOURNAL");
    }
  });
});
