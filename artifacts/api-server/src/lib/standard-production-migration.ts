import { open } from "node:fs/promises";
import {
  inspectMigrationState, runMigrations, validateExpectedMigrationTransition,
  MigrationTransitionError, type MigrationState, type MigrationOptions,
} from "@workspace/db/migrate";

export const SCHEMA_VERSION = "site-logbook.standard-production-migration/v1";
export const HELP = `standard-production-migration plan|apply [options]
standard-production-migration help
Required: --expected-source-sha <SHA> --expected-current <full-tag>
          --expected-target <full-tag> --expected-role <dedicated-role>
Apply also requires: --backup-reference <verified-reference>
                     --confirm 'APPLY:<current-full-tag>-><target-full-tag>'
Set exactly one: PRODUCTION_MIGRATION_DATABASE_URL or PRODUCTION_MIGRATION_DATABASE_URL_FILE.
No runtime credential fallback. No backup or deploy is performed.`;

export class StandardMigrationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "StandardMigrationError"; }
}
const fail = (code: string): never => { throw new StandardMigrationError(code); };
export interface MigrationRequest {
  mode: "plan" | "apply";
  expectedSourceSha: string;
  expectedCurrent: string;
  expectedTarget: string;
  expectedRole: string;
  backupReference?: string;
  confirm?: string;
}

export function parseMigrationArgs(argv: string[]): MigrationRequest | "help" {
  if (argv.length === 1 && argv[0] === "help") return "help";
  const [mode, ...rest] = argv;
  if (mode !== "plan" && mode !== "apply") return fail("USAGE");
  const names = new Set(["expected-source-sha", "expected-current", "expected-target", "expected-role", "backup-reference", "confirm"]);
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].slice(2);
    const value = rest[i + 1];
    if (!rest[i].startsWith("--") || !names.has(name) || name in args ||
        !value?.trim() || value.startsWith("--") || /[\0\r\n]/.test(value)) return fail("USAGE");
    args[name] = value;
  }
  for (const key of ["expected-source-sha", "expected-current", "expected-target", "expected-role"]) {
    if (!args[key]) return fail("USAGE");
  }
  if (mode === "plan" && (args.confirm || args["backup-reference"])) return fail("USAGE");
  return {
    mode, expectedSourceSha: args["expected-source-sha"], expectedCurrent: args["expected-current"],
    expectedTarget: args["expected-target"], expectedRole: args["expected-role"],
    backupReference: args["backup-reference"], confirm: args.confirm,
  };
}

export async function resolveMigrationCredential(env: NodeJS.ProcessEnv): Promise<string> {
  const direct = env.PRODUCTION_MIGRATION_DATABASE_URL;
  const file = env.PRODUCTION_MIGRATION_DATABASE_URL_FILE;
  if ((direct !== undefined) === (file !== undefined)) return fail("CREDENTIAL_SOURCE_INVALID");
  let raw: string;
  if (file !== undefined) {
    if (!file.trim() || file.includes("\0")) return fail("CREDENTIAL_FILE_INVALID");
    try {
      const handle = await open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16384 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
          return fail("CREDENTIAL_FILE_INVALID");
        }
        raw = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
      } finally { await handle.close(); }
    } catch { return fail("CREDENTIAL_FILE_INVALID"); }
  } else { raw = direct!; }
  const value = raw.replace(/\r?\n$/, "");
  if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) return fail("CREDENTIAL_INVALID");
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) return fail("CREDENTIAL_INVALID");
  } catch { return fail("CREDENTIAL_INVALID"); }
  return value;
}

export function verifySourceSha(request: MigrationRequest, sourceSha: string): void {
  const exact = /^[0-9a-f]{40}$/;
  if (request.mode === "plan" && sourceSha === "dev" && request.expectedSourceSha === "dev") return;
  if (!exact.test(sourceSha) || !exact.test(request.expectedSourceSha)) fail("SOURCE_SHA_INVALID");
  if (sourceSha !== request.expectedSourceSha) fail("SOURCE_SHA_MISMATCH");
}

export function verifyMigrationRole(state: MigrationState, role: string): void {
  if (!role.trim() || ["site_logbook_runtime", "site_logbook_backup"].includes(role) ||
      state.sessionUser !== role || state.currentUser !== role) fail("ROLE_MISMATCH");
}

export function verifyApplyConfirmation(request: MigrationRequest): void {
  if (request.confirm !== `APPLY:${request.expectedCurrent}->${request.expectedTarget}`) fail("CONFIRMATION_REQUIRED");
  if (!request.backupReference?.trim()) fail("BACKUP_REFERENCE_REQUIRED");
}

export interface LaneDependencies {
  inspect: typeof inspectMigrationState;
  migrate: typeof runMigrations;
}

export async function executeStandardMigration(
  request: MigrationRequest, sourceSha: string, env: NodeJS.ProcessEnv,
  dependencies: LaneDependencies = { inspect: inspectMigrationState, migrate: runMigrations },
  options: Pick<MigrationOptions, "migrationsFolder"> = {},
) {
  verifySourceSha(request, sourceSha);
  if (request.mode === "apply") verifyApplyConfirmation(request);
  const databaseUrl = await resolveMigrationCredential(env);
  const before = await dependencies.inspect(databaseUrl, options);
  verifyMigrationRole(before, request.expectedRole);
  const guard = {
    expectedCurrentTag: request.expectedCurrent, expectedTargetTag: request.expectedTarget,
    requireExactlyOnePending: true as const, expectedRole: request.expectedRole,
  };
  validateExpectedMigrationTransition(before, guard);
  let state = before;
  if (request.mode === "apply") {
    const summary = await dependencies.migrate(databaseUrl, { ...options, guard, failIfLockBusy: true });
    if (summary.newlyApplied !== 1) fail("APPLY_COUNT_MISMATCH");
    state = await dependencies.inspect(databaseUrl, options);
    verifyMigrationRole(state, request.expectedRole);
    if (state.currentAppliedTag !== request.expectedTarget || state.pendingTags.length ||
        state.unknownAppliedMarkers.length || state.nonContiguousHistory ||
        state.appliedCount !== before.appliedCount + 1 || state.appliedCount !== state.expectedCount) {
      fail("POST_APPLY_STATE_MISMATCH");
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION, mode: request.mode, status: request.mode === "plan" ? "READY" : "APPLIED",
    sourceSha, databaseName: state.databaseName, sessionUser: state.sessionUser, currentUser: state.currentUser,
    currentTag: state.currentAppliedTag, targetTag: request.expectedTarget,
    pendingTags: state.pendingTags, pendingCount: state.pendingTags.length,
    ...(request.mode === "apply" ? { newlyApplied: 1 } : {}),
  };
}

/** Deliberately discard raw errors, causes, SQL, paths and environment material. */
export function safeMigrationError(error: unknown) {
  const code = error instanceof StandardMigrationError || error instanceof MigrationTransitionError
    ? error.code : "MIGRATION_FAILED";
  return { schemaVersion: SCHEMA_VERSION, status: "ERROR", code, message: "Migration command refused or failed; no deployment was performed." };
}

export async function runStandardMigrationCli(
  argv: string[], sourceSha: string, env: NodeJS.ProcessEnv,
  io = { stdout: (text: string) => console.log(text), stderr: (text: string) => console.error(text) },
  dependencies?: LaneDependencies,
): Promise<number> {
  try {
    if (!argv.length) { io.stdout(HELP); return 2; }
    const request = parseMigrationArgs(argv);
    if (request === "help") { io.stdout(HELP); return 0; }
    io.stdout(JSON.stringify(await executeStandardMigration(request, sourceSha, env, dependencies)));
    return 0;
  } catch (error) {
    io.stderr(JSON.stringify(safeMigrationError(error)));
    return 1;
  }
}
