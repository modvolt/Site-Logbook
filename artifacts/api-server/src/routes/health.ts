import { Router, type IRouter } from "express";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  HealthCheckResponse,
  GetAdminHealthResponse,
  GetAdminOperationalSnapshotResponse,
  GetWatchdogStatusResponse,
  ListOperationalAlertDeadLettersResponse,
  RequeueOperationalAlertDeadLetterBody,
  RequeueOperationalAlertDeadLetterParams,
  RequeueOperationalAlertDeadLetterResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import {
  db,
  backupLogTable,
  emailImportAccountsTable,
  emailImportLogTable,
  clientErrorsTable,
  healthLogTable,
} from "@workspace/db";
import { desc, eq, sql, and, gte, or } from "drizzle-orm";
import { getWatchdogState } from "../lib/health-watchdog";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { diagnoseS3 } from "../lib/objectStorage";
import { resolveEmailConfig } from "../lib/email";
import { resolveOpenAiConfig } from "../lib/openai-extraction";
import { resolveImapConfig } from "../lib/email-import";
import { countServerErrors, getRecentServerErrors } from "../lib/server-errors";
import { probeDatabaseReadiness } from "../lib/db-health-probe";
import {
  collectOperationalSnapshot,
  unavailableOperationalSnapshot,
} from "../lib/operational-signals";
import {
  getOperationalAlertDeliverySummary,
  listOperationalAlertDeadLetters,
  requeueOperationalAlertDeadLetter,
} from "../lib/operational-incident-store";
import {
  classifyMigrationInventory,
  productionRuntimeBindingMatches,
} from "../lib/migration-health";
import { resolveApiBuildVersion } from "../lib/build-provenance";
import {
  readProductionRuntimeBinding,
  readProductionRuntimeHealthProjection,
  readProductionRuntimeReadinessState,
} from "../lib/production-runtime-state";

const WINDOW_24H = 24 * 60 * 60 * 1000;
const DEAD_LETTER_REQUEUE_BODY_KEYS = new Set([
  "expectedAttemptCount",
  "expectedDeadLetteredAt",
  "reason",
]);

function productionRuntimeLatchAllowsReadiness(): boolean {
  const state = readProductionRuntimeReadinessState();
  if (state === "failed") return false;
  return (
    process.env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT !== "production" ||
    state === "ready"
  );
}

function unavailableProductionControlParity(): false | null {
  const runtimeEnvironment = process.env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT;
  if (runtimeEnvironment === "production") return false;
  if (runtimeEnvironment === "staging") return null;
  return process.env.NODE_ENV === "production" ? false : null;
}

function hasExactRequeueBodyKeys(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === DEAD_LETTER_REQUEUE_BODY_KEYS.size &&
    keys.every((key) => DEAD_LETTER_REQUEUE_BODY_KEYS.has(key))
  );
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // The bundled entry point is at artifacts/api-server/dist/index.mjs.
  // From dist/ → up 3 → workspace root → lib/db/migrations.
  // (In source the file is deeper, but esbuild bundles everything into dist/index.mjs.)
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "lib",
    "db",
    "migrations",
  );
}

async function checkMigrationParity(): Promise<{
  parity: boolean;
  controlParity: boolean | null;
  expectedCount: number;
  knownAppliedCount: number;
  knownRowsSha256: string;
  opaqueAppliedCount: number;
  appliedCount: number;
  opaqueRowsSha256: string;
  latestExpectedTag: string | null;
  missingTags: string[];
}> {
  let expected: JournalEntry[] = [];
  try {
    const folder = resolveMigrationsFolder();
    const journalPath = path.join(folder, "meta", "_journal.json");
    const j: Journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expected = j.entries;
  } catch {
    return {
      parity: false,
      controlParity: unavailableProductionControlParity(),
      expectedCount: 0,
      knownAppliedCount: 0,
      knownRowsSha256: "sha256:unknown",
      opaqueAppliedCount: 0,
      appliedCount: 0,
      opaqueRowsSha256: "sha256:unknown",
      latestExpectedTag: null,
      missingTags: ["(journal unreadable)"],
    };
  }

  const latestExpectedTag = expected.at(-1)?.tag ?? null;
  let appliedCount = 0;
  let knownAppliedCount = 0;
  let knownRowsSha256 = "sha256:unknown";
  let opaqueAppliedCount = 0;
  let opaqueRowsSha256 = "sha256:unknown";
  let missingTags: string[] = [];

  try {
    const migrationFiles = readMigrationFiles({
      migrationsFolder: resolveMigrationsFolder(),
    });
    const filesByWhen = new Map(
      migrationFiles.map((file) => [file.folderMillis, file]),
    );
    const expectedIdentities = expected.map((entry) => {
      const file = filesByWhen.get(entry.when);
      if (!file) {
        throw new Error(`Migration file missing for ${entry.tag}.`);
      }
      return {
        when: entry.when,
        tag: entry.tag,
        hash: file.hash.toLowerCase(),
      };
    });
    const result = await db.execute<{
      created_at: string | number | null;
      hash: string | null;
    }>(
      sql`SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
    );
    // db.execute with node-postgres returns a QueryResult object; rows are in .rows
    const rows: Array<{
      created_at: string | number | null;
      hash: string | null;
    }> = Array.isArray(result) ? result : ((result as any).rows ?? []);
    const inventory = classifyMigrationInventory(expectedIdentities, rows);
    knownAppliedCount = inventory.knownAppliedMigrations;
    knownRowsSha256 = inventory.knownAppliedRowsSha256;
    opaqueAppliedCount = inventory.opaqueAppliedMigrations;
    appliedCount = knownAppliedCount + opaqueAppliedCount;
    opaqueRowsSha256 = inventory.opaqueLegacyRowsSha256;
    missingTags = inventory.missingKnownMigrationTags;

    const runtimeEnvironment = process.env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT;
    const controlParity =
      runtimeEnvironment === "production"
        ? productionRuntimeBindingMatches(
            readProductionRuntimeBinding(),
            resolveApiBuildVersion(),
            latestExpectedTag,
            inventory,
          ) && readProductionRuntimeReadinessState() === "ready"
        : runtimeEnvironment === "staging" ||
            process.env.NODE_ENV !== "production"
          ? null
          : false;
    return {
      parity: missingTags.length === 0 && controlParity !== false,
      controlParity,
      expectedCount: expected.length,
      knownAppliedCount,
      knownRowsSha256,
      opaqueAppliedCount,
      appliedCount,
      opaqueRowsSha256,
      latestExpectedTag,
      missingTags,
    };
  } catch {
    missingTags = expected.map((e) => e.tag);
  }

  return {
    parity: false,
    controlParity: unavailableProductionControlParity(),
    expectedCount: expected.length,
    knownAppliedCount,
    knownRowsSha256,
    opaqueAppliedCount,
    appliedCount,
    opaqueRowsSha256,
    latestExpectedTag,
    missingTags,
  };
}

// ---------------------------------------------------------------------------
// Cached migration parity â€” re-checked at most once per minute.
// Production migrations are applied by an approved one-shot control plane.
// This cache prevents a DB query on every liveness probe while still surfacing
// live journal drift quickly after a release.
// ---------------------------------------------------------------------------

interface ParityCache {
  parity: boolean;
  controlParity: boolean | null;
  expectedCount: number;
  knownAppliedCount: number;
  knownRowsSha256: string;
  opaqueAppliedCount: number;
  appliedCount: number;
  opaqueRowsSha256: string;
  latestExpectedTag: string | null;
  missingTags: string[];
  checkedAt: number;
}

let parityCache: ParityCache | null = null;
const PARITY_CACHE_TTL_MS = 60_000;

async function getCachedMigrationParity(): Promise<ParityCache> {
  const now = Date.now();
  if (parityCache && now - parityCache.checkedAt < PARITY_CACHE_TTL_MS) {
    return parityCache;
  }
  const result = await checkMigrationParity();
  parityCache = { ...result, checkedAt: now };
  return parityCache;
}

async function checkDbLatency(): Promise<{
  status: "ok" | "error";
  latencyMs: number | null;
}> {
  try {
    const latencyMs = await probeDatabaseReadiness();
    return { status: "ok", latencyMs };
  } catch {
    return { status: "error", latencyMs: null };
  }
}

/** S3 is considered configured when the essential env vars are all present. */
function s3IsConfigured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY,
  );
}

async function checkStorage(): Promise<{
  status: "ok" | "error" | "not_configured";
  isDevFallback: boolean;
  details: string | null;
}> {
  if (!s3IsConfigured()) {
    // No S3 configured: GCS/Replit object storage is active (dev environment).
    // Storage still functions — report it as OK with a dev-fallback flag.
    return { status: "ok", isDevFallback: true, details: null };
  }
  try {
    const result = await diagnoseS3();
    const verdict =
      typeof result["verdict"] === "string" ? result["verdict"] : null;
    const ok =
      result["ok"] === true ||
      (typeof verdict === "string" && verdict.startsWith("OK"));
    return {
      status: ok ? "ok" : "error",
      isDevFallback: false,
      details: verdict,
    };
  } catch (e: unknown) {
    return {
      status: "error",
      isDevFallback: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkSmtp(): Promise<{
  status: "configured" | "not_configured";
  host: string | null;
}> {
  try {
    const cfg = await resolveEmailConfig();
    return { status: "configured", host: cfg.host };
  } catch {
    return { status: "not_configured", host: null };
  }
}

async function checkAi(): Promise<{
  status: "ready" | "configured_disabled" | "not_configured";
  model: string | null;
}> {
  try {
    const cfg = await resolveOpenAiConfig();
    if (cfg.ready) return { status: "ready", model: cfg.model };
    if (cfg.configured)
      return { status: "configured_disabled", model: cfg.model };
    return { status: "not_configured", model: null };
  } catch {
    return { status: "not_configured", model: null };
  }
}

async function checkGmail(): Promise<{
  status: "connected" | "disconnected" | "not_configured";
  email: string | null;
}> {
  const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
  if (!googleConfigured) return { status: "not_configured", email: null };
  try {
    const [account] = await db
      .select({
        status: emailImportAccountsTable.status,
        emailAddress: emailImportAccountsTable.emailAddress,
      })
      .from(emailImportAccountsTable)
      .where(eq(emailImportAccountsTable.provider, "gmail"))
      .limit(1);
    if (!account) return { status: "not_configured", email: null };
    return {
      status: account.status === "connected" ? "connected" : "disconnected",
      email: account.emailAddress ?? null,
    };
  } catch {
    return { status: "not_configured", email: null };
  }
}

async function checkImap(): Promise<{
  status: "configured" | "not_configured";
}> {
  try {
    const cfg = await resolveImapConfig();
    return { status: cfg ? "configured" : "not_configured" };
  } catch {
    return { status: "not_configured" };
  }
}

type BackupSummary = {
  createdAt: string;
  status: string;
  sizeBytes: number | null;
  trigger: string;
  error: string | null;
  sha256: string | null;
  restoredAt: string | null;
};

async function getBackupSummaries(): Promise<{
  lastSuccessful: BackupSummary | null;
  lastError: BackupSummary | null;
}> {
  try {
    const rows = await db
      .select({
        createdAt: backupLogTable.createdAt,
        status: backupLogTable.status,
        sizeBytes: backupLogTable.sizeBytes,
        trigger: backupLogTable.trigger,
        error: backupLogTable.error,
        sha256: backupLogTable.sha256,
        restoredAt: backupLogTable.restoredAt,
      })
      .from(backupLogTable)
      .where(
        or(
          eq(backupLogTable.status, "success"),
          eq(backupLogTable.status, "failed"),
        ),
      )
      .orderBy(desc(backupLogTable.createdAt))
      .limit(20);

    const toSummary = (r: (typeof rows)[number]): BackupSummary => ({
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      sizeBytes: r.sizeBytes ?? null,
      trigger: r.trigger,
      error: r.error ?? null,
      sha256: r.sha256 ?? null,
      restoredAt: r.restoredAt ? r.restoredAt.toISOString() : null,
    });

    const lastSuccessful = rows.find((r) => r.status === "success");
    const lastError = rows.find((r) => r.status === "failed");

    return {
      lastSuccessful: lastSuccessful ? toSummary(lastSuccessful) : null,
      lastError: lastError ? toSummary(lastError) : null,
    };
  } catch {
    return { lastSuccessful: null, lastError: null };
  }
}

async function getErrorCounts(): Promise<{
  frontendErrors: number;
  backendErrors: number;
}> {
  const since = new Date(Date.now() - WINDOW_24H);
  try {
    // Frontend JS errors logged by the PageErrorBoundary / global handler
    const [feRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(clientErrorsTable)
      .where(gte(clientErrorsTable.createdAt, since));
    const frontendErrors = feRow?.count ?? 0;

    // Backend processing failures: backup failures + email import failures in last 24 h
    const [backupFails] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(backupLogTable)
      .where(
        and(
          eq(backupLogTable.status, "failed"),
          gte(backupLogTable.createdAt, since),
        ),
      );
    const [emailFails] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailImportLogTable)
      .where(
        and(
          or(
            eq(emailImportLogTable.status, "failed"),
            eq(emailImportLogTable.status, "failed_permanent"),
          ),
          gte(emailImportLogTable.createdAt, since),
        ),
      );

    const backendErrors = (backupFails?.count ?? 0) + (emailFails?.count ?? 0);
    return { frontendErrors, backendErrors };
  } catch {
    return { frontendErrors: 0, backendErrors: 0 };
  }
}

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const apiVersion = resolveApiBuildVersion();
  const uptimeSeconds = process.uptime();

  // A runtime parity failure is a synchronous, permanent latch. Return 503
  // before doing any I/O; a fresh guarded process is the only recovery path.
  if (!productionRuntimeLatchAllowsReadiness()) {
    const data = HealthCheckResponse.parse({
      status: "degraded",
      version: apiVersion,
      uptimeSeconds,
      storageStatus: "ok",
      migrationParity: false,
    });
    res.status(503).json(data);
    return;
  }

  // The DB probe is a prerequisite for every DB-backed secondary diagnostic.
  // Short-circuiting here prevents an expired migration cache or DB-backed
  // SMTP settings lookup from outliving the platform's five-second probe.
  const dbPing = await checkDbLatency();
  if (dbPing.status === "error") {
    const data = HealthCheckResponse.parse({
      status: "degraded",
      version: apiVersion,
      uptimeSeconds,
      dbStatus: dbPing.status,
      dbLatencyMs: dbPing.latencyMs,
      storageStatus: "ok",
      migrationParity: null,
    });
    res.status(503).json(data);
    return;
  }

  const [smtp, migration] = await Promise.all([
    checkSmtp(),
    getCachedMigrationParity(),
  ]);

  // Readiness: DB must be reachable AND all expected migrations must be applied.
  // Do not run the live S3 diagnostic here: it performs ListBuckets, HeadBucket and a
  // write/delete probe. The container calls this endpoint every 30 seconds with
  // a 5-second deadline, so a transiently slow object store could otherwise
  // mark a healthy API as dead and trigger a restart. Deep storage diagnostics
  // remain available in /admin/health and the periodic watchdog.
  // Return 503 when not ready so the platform's startup health probe fails fast
  // instead of routing traffic to a broken instance.
  const ready =
    dbPing.status === "ok" &&
    migration.parity &&
    productionRuntimeLatchAllowsReadiness();

  const data = HealthCheckResponse.parse({
    status: ready ? "ok" : "degraded",
    version: apiVersion,
    uptimeSeconds,
    dbStatus: dbPing.status,
    dbLatencyMs: dbPing.latencyMs,
    // Storage does not participate in readiness. Configuration and live
    // read/write health are reported by the admin diagnostics instead.
    storageStatus: "ok",
    smtpStatus: smtp.status,
    migrationParity: migration.parity,
  });
  res.status(ready ? 200 : 503).json(data);
});

router.get(
  "/admin/health",
  requireAuth,
  requirePermission("diagnostics.view"),
  async (req, res) => {
    const [migration, dbPing, storage, smtp, ai, gmail, imap, backups, errors] =
      await Promise.all([
        checkMigrationParity(),
        checkDbLatency(),
        checkStorage(),
        checkSmtp(),
        checkAi(),
        checkGmail(),
        checkImap(),
        getBackupSummaries(),
        getErrorCounts(),
      ]);

    const apiVersion = resolveApiBuildVersion();
    const productionRuntimeBinding = readProductionRuntimeHealthProjection();

    const server5xxErrors24h = countServerErrors(WINDOW_24H);
    const recentServerErrors = getRecentServerErrors(WINDOW_24H, 10);

    const payload = GetAdminHealthResponse.parse({
      apiVersion,
      migrationParity: migration.parity,
      migrationControlParity: migration.controlParity,
      productionRuntimeBinding,
      knownAppliedMigrations: migration.knownAppliedCount,
      knownMigrationRowsSha256: migration.knownRowsSha256,
      opaqueAppliedMigrations: migration.opaqueAppliedCount,
      opaqueMigrationRowsSha256: migration.opaqueRowsSha256,
      expectedMigrations: migration.expectedCount,
      appliedMigrations: migration.appliedCount,
      latestExpectedTag: migration.latestExpectedTag,
      missingMigrationTags: migration.missingTags,
      dbStatus: dbPing.status,
      dbLatencyMs: dbPing.latencyMs,
      storageStatus: storage.status,
      storageIsDevFallback: storage.isDevFallback,
      storageDetails: storage.details,
      smtpStatus: smtp.status,
      smtpHost: smtp.host,
      aiStatus: ai.status,
      aiModel: ai.model,
      gmailStatus: gmail.status,
      gmailEmail: gmail.email,
      imapStatus: imap.status,
      frontendErrorCount24h: errors.frontendErrors,
      backendErrorCount24h: errors.backendErrors,
      server5xxErrors24h,
      recentServerErrors,
      lastSuccessfulBackup: backups.lastSuccessful,
      lastBackupError: backups.lastError,
    });

    req.log.info(
      {
        apiVersion,
        migrationParity: migration.parity,
        dbStatus: dbPing.status,
        frontendErrors: errors.frontendErrors,
        backendErrors: errors.backendErrors,
        server5xxErrors24h,
      },
      "admin health check",
    );
    res.json(payload);
  },
);

router.get(
  "/admin/health/operational",
  requireAuth,
  requirePermission("diagnostics.view"),
  async (req, res) => {
    const dbPing = await checkDbLatency();
    const providers = [
      {
        id: "database" as const,
        state: dbPing.status === "ok" ? ("ok" as const) : ("error" as const),
        required: true,
      },
    ];
    let snapshot = unavailableOperationalSnapshot({ providers });
    if (dbPing.status === "ok") {
      try {
        snapshot = await collectOperationalSnapshot({ providers });
      } catch (err) {
        req.log.warn(
          { errorName: err instanceof Error ? err.name : "unknown" },
          "Operational snapshot DB aggregates unavailable",
        );
      }
    }

    const payload = GetAdminOperationalSnapshotResponse.parse(snapshot);
    req.log.info(
      {
        status: payload.status,
        alertCount: payload.activeAlerts.length,
        queueCount: payload.queues.length,
        alertTransport: payload.alertTransport,
      },
      "admin operational snapshot",
    );
    res.json(payload);
  },
);

router.get(
  "/admin/health/watchdog",
  requireAuth,
  requirePermission("diagnostics.view"),
  async (_req, res) => {
    const payload = GetWatchdogStatusResponse.parse({
      ...getWatchdogState(),
      delivery: await getOperationalAlertDeliverySummary(),
    });
    res.json(payload);
  },
);

router.get(
  "/admin/health/operational-alert-outbox/dead-letters",
  requireAuth,
  requirePermission("diagnostics.manage"),
  async (_req, res) => {
    const payload = ListOperationalAlertDeadLettersResponse.parse({
      items: await listOperationalAlertDeadLetters(),
    });
    res.json(payload);
  },
);

router.post(
  "/admin/health/operational-alert-outbox/:id/requeue",
  requireAuth,
  requirePermission("diagnostics.manage"),
  async (req, res) => {
    const params = RequeueOperationalAlertDeadLetterParams.safeParse(
      req.params,
    );
    const body = RequeueOperationalAlertDeadLetterBody.safeParse(req.body);
    if (
      !params.success ||
      !body.success ||
      !Number.isSafeInteger(params.data.id) ||
      !Number.isSafeInteger(body.data.expectedAttemptCount) ||
      !hasExactRequeueBodyKeys(req.body)
    ) {
      res.status(400).json({
        error: "Invalid operational alert requeue request",
        code: "invalid_operational_alert_requeue_request",
      });
      return;
    }

    const result = await requeueOperationalAlertDeadLetter({
      outboxId: params.data.id,
      expectedAttemptCount: body.data.expectedAttemptCount,
      expectedDeadLetteredAt: body.data.expectedDeadLetteredAt.toISOString(),
      reason: body.data.reason,
      actor: {
        userId: req.auth!.userId,
        name: req.auth!.name,
      },
    });

    if (result.status === "not_found") {
      res.status(404).json({
        error: "Operational alert outbox row not found",
        code: "operational_alert_outbox_not_found",
      });
      return;
    }
    if (result.status === "conflict") {
      res.status(409).json({
        error: "Operational alert requeue precondition failed",
        code:
          result.reason === "not_dead_letter"
            ? "operational_alert_not_dead_letter"
            : "operational_alert_requeue_precondition_failed",
      });
      return;
    }

    res.json(RequeueOperationalAlertDeadLetterResponse.parse(result.value));
  },
);

router.get(
  "/admin/health/log",
  requireAuth,
  requirePermission("diagnostics.view"),
  async (_req, res) => {
    const since = new Date(Date.now() - WINDOW_24H);
    const rows = await db
      .select()
      .from(healthLogTable)
      .where(gte(healthLogTable.checkedAt, since))
      .orderBy(desc(healthLogTable.checkedAt))
      .limit(300);

    const data = rows.map((r) => ({
      id: r.id,
      checkedAt: r.checkedAt.toISOString(),
      dbOk: r.dbOk,
      dbLatencyMs: r.dbLatencyMs ?? null,
      s3Ok: r.s3Ok,
      smtpOk: r.smtpOk,
      overallStatus: r.overallStatus as "ok" | "degraded",
    }));
    res.json(data);
  },
);

export default router;
