import { Router, type IRouter } from "express";
import { HealthCheckResponse, GetAdminHealthResponse } from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";
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

const WINDOW_24H = 24 * 60 * 60 * 1000;

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
  expectedCount: number;
  appliedCount: number;
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
      expectedCount: 0,
      appliedCount: 0,
      latestExpectedTag: null,
      missingTags: ["(journal unreadable)"],
    };
  }

  let appliedCount = 0;
  let missingTags: string[] = [];

  try {
    const result = await db.execute<{ created_at: string | number | null }>(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    // db.execute with node-postgres returns a QueryResult object; rows are in .rows
    const rows: Array<{ created_at: string | number | null }> =
      Array.isArray(result) ? result : (result as any).rows ?? [];
    const appliedMillis = new Set(
      rows.map((r) => Number(r.created_at)).filter((n) => Number.isFinite(n)),
    );
    appliedCount = appliedMillis.size;
    missingTags = expected.filter((e) => !appliedMillis.has(e.when)).map((e) => e.tag);
  } catch {
    missingTags = expected.map((e) => e.tag);
  }

  return {
    parity: missingTags.length === 0,
    expectedCount: expected.length,
    appliedCount,
    latestExpectedTag: expected.at(-1)?.tag ?? null,
    missingTags,
  };
}

// ---------------------------------------------------------------------------
// Cached migration parity — re-checked at most once per minute.
// Migrations are applied at startup; this cache prevents a DB query on every
// liveness probe while still surfacing drift quickly after a broken deploy.
// ---------------------------------------------------------------------------

interface ParityCache {
  parity: boolean;
  expectedCount: number;
  appliedCount: number;
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

async function checkDbLatency(): Promise<{ status: "ok" | "error"; latencyMs: number | null }> {
  const t0 = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", latencyMs: Date.now() - t0 };
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
    const verdict = typeof result["verdict"] === "string" ? result["verdict"] : null;
    const ok =
      result["ok"] === true ||
      (typeof verdict === "string" && verdict.startsWith("OK"));
    return { status: ok ? "ok" : "error", isDevFallback: false, details: verdict };
  } catch (e: unknown) {
    return {
      status: "error",
      isDevFallback: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkSmtp(): Promise<{ status: "configured" | "not_configured"; host: string | null }> {
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
    if (cfg.configured) return { status: "configured_disabled", model: cfg.model };
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

async function checkImap(): Promise<{ status: "configured" | "not_configured" }> {
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
      .where(or(eq(backupLogTable.status, "success"), eq(backupLogTable.status, "failed")))
      .orderBy(desc(backupLogTable.createdAt))
      .limit(20);

    const toSummary = (r: typeof rows[number]): BackupSummary => ({
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

function resolveApiVersion(): string {
  return (
    process.env.BUILD_SHA ||
    process.env.COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.REPLIT_DEPLOYMENT_ID ||
    "dev"
  );
}

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const apiVersion = resolveApiVersion();
  const uptimeSeconds = process.uptime();

  const [dbPing, storage, smtp, migration] = await Promise.all([
    checkDbLatency(),
    checkStorage(),
    checkSmtp(),
    getCachedMigrationParity(),
  ]);

  // Readiness: DB must be reachable AND all expected migrations must be applied.
  // Return 503 when not ready so the platform's startup health probe fails fast
  // instead of routing traffic to a broken instance.
  const ready = dbPing.status === "ok" && migration.parity;

  const data = HealthCheckResponse.parse({
    status: ready ? "ok" : "degraded",
    version: apiVersion,
    uptimeSeconds,
    dbStatus: dbPing.status,
    dbLatencyMs: dbPing.latencyMs,
    storageStatus: storage.status,
    smtpStatus: smtp.status,
    migrationParity: migration.parity,
  });
  res.status(ready ? 200 : 503).json(data);
});

router.get(
  "/admin/health",
  requireAuth,
  requireRole("master", "admin"),
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

    const apiVersion = resolveApiVersion();

    const server5xxErrors24h = countServerErrors(WINDOW_24H);
    const recentServerErrors = getRecentServerErrors(WINDOW_24H, 10);

    const payload = GetAdminHealthResponse.parse({
      apiVersion,
      migrationParity: migration.parity,
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
  "/admin/health/watchdog",
  requireAuth,
  requireRole("master", "admin"),
  (_req, res) => {
    res.json(getWatchdogState());
  },
);

router.get(
  "/admin/health/log",
  requireAuth,
  requireRole("master", "admin"),
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
