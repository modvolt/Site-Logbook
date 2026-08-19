/**
 * Health watchdog — checks DB and S3 every 5 minutes, writes results to
 * health_log, and sends email alerts on ok→fail and fail→ok transitions
 * (only after 2 consecutive failures to avoid noise from transient hiccups).
 */
import { sql } from "drizzle-orm";
import { db, healthLogTable, usersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { diagnoseS3 } from "./objectStorage";
import { resolveEmailConfig } from "./email";
import nodemailer from "nodemailer";
import { probeDatabaseReadiness } from "./db-health-probe";
import {
  collectOperationalSnapshot,
  unavailableOperationalSnapshot,
} from "./operational-signals";
import { OperationalAlertTracker } from "./operational-alert-policy";
import { emitLocalOperationalAlertTransitions } from "./operational-alert-sink";
import {
  deliverOperationalAlertTransitions,
  getOperationalAlertTransportMode,
} from "./operational-alert-transport";
import { SCHEDULER_LOCK_KEYS, withSchedulerLock } from "./scheduler-lock";
import { reconcileOperationalIncidents } from "./operational-incident-store";

// ---------------------------------------------------------------------------
// In-process state for transition detection
// ---------------------------------------------------------------------------

type CheckState = "ok" | "fail";

interface WatchdogState {
  /** Last emitted overall state (used to detect transitions). */
  lastAlertedState: CheckState | null;
  /** How many consecutive failures have been recorded. */
  consecutiveFailures: number;
  /** ISO timestamp of the last alert sent (either fail or recovery). */
  lastAlertAt: string | null;
}

const state: WatchdogState = {
  lastAlertedState: null,
  consecutiveFailures: 0,
  lastAlertAt: null,
};
const operationalAlertTracker = new OperationalAlertTracker();
const fallbackOnlyAlertFingerprints = new Set<string>();
let operationalStatus: "ok" | "warning" | "critical" | "unknown" = "unknown";
let activeOperationalAlerts = 0;
let lastOperationalAlertAt: string | null = null;

// ---------------------------------------------------------------------------
// Individual sub-checks
// ---------------------------------------------------------------------------

async function pingDb(): Promise<{ ok: boolean; latencyMs: number | null }> {
  try {
    const latencyMs = await probeDatabaseReadiness();
    return { ok: true, latencyMs };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

function s3IsConfigured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY,
  );
}

async function pingS3(): Promise<boolean> {
  if (!s3IsConfigured()) return true; // dev fallback — not an error
  try {
    const result = await diagnoseS3();
    const verdict =
      typeof result["verdict"] === "string" ? result["verdict"] : null;
    return (
      result["ok"] === true ||
      (typeof verdict === "string" && verdict.startsWith("OK"))
    );
  } catch {
    return false;
  }
}

async function checkSmtpConfigured(): Promise<boolean> {
  try {
    await resolveEmailConfig();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Alert email helpers
// ---------------------------------------------------------------------------

async function getAdminEmails(): Promise<string[]> {
  try {
    const rows = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isActive, true),
          inArray(usersTable.role, ["admin", "master"]),
        ),
      );
    return rows
      .map((r) => r.email)
      .filter((e): e is string => typeof e === "string" && e.includes("@"));
  } catch {
    return [];
  }
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const cfg = await resolveEmailConfig();
  const recipients = await getAdminEmails();
  if (recipients.length === 0) {
    logger.warn("Health watchdog: no admin emails found, skipping alert");
    return;
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transporter.sendMail({
    from: cfg.from,
    to: recipients,
    subject,
    text: body,
  });
  logger.info({ recipientCount: recipients.length }, "Health alert email sent");
}

function describeFailure(dbOk: boolean, s3Ok: boolean): string {
  const parts: string[] = [];
  if (!dbOk) parts.push("databáze (DB ping selhal)");
  if (!s3Ok) parts.push("objektové úložiště (S3 HeadBucket selhal)");
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Main watchdog check
// ---------------------------------------------------------------------------

export async function runHealthCheck(preflightDbResult?: {
  ok: boolean;
  latencyMs: number | null;
}): Promise<void> {
  const dbResult = preflightDbResult ?? (await pingDb());
  const [s3Ok, smtpOk] = await Promise.all([
    pingS3(),
    dbResult.ok ? checkSmtpConfigured() : Promise.resolve(false),
  ]);

  const { ok: dbOk, latencyMs: dbLatencyMs } = dbResult;
  const overallOk = dbOk && s3Ok;
  const overallStatus: "ok" | "degraded" = overallOk ? "ok" : "degraded";
  const storageConfigured =
    s3IsConfigured() || Boolean(process.env.PRIVATE_OBJECT_DIR);
  const storageRequired =
    storageConfigured || process.env.NODE_ENV === "production";

  const providers = [
    {
      id: "database" as const,
      state: dbOk ? ("ok" as const) : ("error" as const),
      required: true,
    },
    {
      id: "storage" as const,
      state: !storageConfigured
        ? ("not_configured" as const)
        : s3Ok
          ? ("ok" as const)
          : ("error" as const),
      required: storageRequired,
    },
    {
      id: "smtp" as const,
      state: smtpOk ? ("ok" as const) : ("not_configured" as const),
      required: false,
    },
  ];
  let operational = unavailableOperationalSnapshot({ providers });
  let operationalSnapshotComplete = false;
  if (dbOk) {
    try {
      operational = await collectOperationalSnapshot({ providers });
      operationalSnapshotComplete = true;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "unknown" },
        "Health watchdog: operational snapshot unavailable",
      );
    }
  }
  const trackerTransitions = operationalAlertTracker.update(
    operational.activeAlerts,
    operational.generatedAt,
  );
  let operationalTransitions;
  let directTransitions = trackerTransitions;
  let durableIncidentState = false;
  if (dbOk && operationalSnapshotComplete) {
    try {
      operationalTransitions = await reconcileOperationalIncidents(
        operational.activeAlerts,
        operational.generatedAt,
      );
      durableIncidentState = true;
      const fallbackRecoveries = trackerTransitions.filter(
        (transition) =>
          transition.kind === "recovered" &&
          fallbackOnlyAlertFingerprints.delete(transition.alert.fingerprint),
      );
      for (const alert of operational.activeAlerts) {
        // The durable registry has now adopted any still-active fallback alert.
        fallbackOnlyAlertFingerprints.delete(alert.fingerprint);
      }
      operationalTransitions.push(...fallbackRecoveries);
      directTransitions = fallbackRecoveries;
    } catch (error) {
      logger.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Health watchdog: durable incident reconciliation unavailable",
      );
    }
  }
  operationalTransitions ??= trackerTransitions;
  if (!durableIncidentState) {
    for (const transition of trackerTransitions) {
      if (transition.kind === "recovered") {
        fallbackOnlyAlertFingerprints.delete(transition.alert.fingerprint);
      } else {
        fallbackOnlyAlertFingerprints.add(transition.alert.fingerprint);
      }
    }
  }
  const alertTransport = getOperationalAlertTransportMode();
  emitLocalOperationalAlertTransitions(operationalTransitions, alertTransport);
  // A DB-unavailable fallback and its later recovery bypass the outbox because
  // PostgreSQL could not persist the original transition. Duplicate risk is
  // explicit and preferable to losing the only signal that the DB is down.
  if (!durableIncidentState) {
    directTransitions = operationalTransitions;
  }
  if (directTransitions.length > 0) {
    void deliverOperationalAlertTransitions(directTransitions).catch(
      (error) => {
        logger.warn(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "Health watchdog: operational alert transport unavailable",
        );
      },
    );
  }
  operationalStatus = operational.status;
  activeOperationalAlerts = operational.activeAlerts.length;
  if (operationalTransitions.length > 0) {
    lastOperationalAlertAt = operational.generatedAt;
  }

  // Write to health_log
  if (dbOk) {
    try {
      await db.insert(healthLogTable).values({
        dbOk,
        dbLatencyMs: dbLatencyMs ?? undefined,
        s3Ok,
        smtpOk,
        overallStatus,
      });
    } catch (err) {
      logger.error({ err }, "Health watchdog: failed to write health_log");
    }
  }

  // Transition detection — only alert after 2 consecutive failures
  if (!overallOk) {
    state.consecutiveFailures += 1;
  } else {
    const wasInFailState = state.lastAlertedState === "fail";
    state.consecutiveFailures = 0;

    if (wasInFailState) {
      // Recovery transition
      state.lastAlertedState = "ok";
      state.lastAlertAt = new Date().toISOString();
      try {
        await sendAlertEmail(
          "✅ Stavba – systém obnovil provoz",
          `Všechny subsystémy jsou znovu v pořádku.\n\nČas obnovení: ${new Date().toLocaleString("cs-CZ")}\n`,
        );
      } catch (err) {
        logger.error({ err }, "Health watchdog: failed to send recovery alert");
      }
    } else {
      state.lastAlertedState = "ok";
    }
    return;
  }

  // Send alert only after 2 consecutive failures AND only when transitioning
  // from ok → fail (not on every subsequent failure while already degraded).
  if (state.consecutiveFailures >= 2 && state.lastAlertedState !== "fail") {
    state.lastAlertedState = "fail";
    state.lastAlertAt = new Date().toISOString();
    try {
      const failed = describeFailure(dbOk, s3Ok);
      await sendAlertEmail(
        "🔴 Stavba – systémový výpadek",
        `Watchdog detekoval selhání subsystémů: ${failed}.\n\n` +
          `Čas: ${new Date().toLocaleString("cs-CZ")}\n` +
          `Stav: ${state.consecutiveFailures} po sobě jdoucích selhání.\n\n` +
          `Zkontrolujte stav systému v administraci: /admin/health\n`,
      );
    } catch (err) {
      logger.error({ err }, "Health watchdog: failed to send fail alert");
    }
  }
}

// ---------------------------------------------------------------------------
// Purge old records (older than 48 h) — called from daily cron
// ---------------------------------------------------------------------------

export async function purgeOldHealthLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  try {
    await db.execute(sql`DELETE FROM health_log WHERE checked_at < ${cutoff}`);
    logger.info("Health watchdog: purged old health_log rows");
  } catch (err) {
    logger.error({ err }, "Health watchdog: failed to purge health_log");
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type SchedulerStopHandle = Readonly<{
  stop(): void;
}>;

let schedulerHandle: SchedulerStopHandle | undefined;

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runScheduledHealthCheck(): Promise<void> {
  const dbResult = await pingDb();
  if (!dbResult.ok) {
    // PostgreSQL is also the advisory-lock authority. Preserve outage
    // visibility when the lock cannot exist; duplicate replica logs are safer
    // than suppressing the only locally independent signal.
    await runHealthCheck(dbResult);
    return;
  }
  await withSchedulerLock(SCHEDULER_LOCK_KEYS.healthWatchdog, async () => {
    await runHealthCheck(dbResult);
  });
}

export function startHealthWatchdog(): SchedulerStopHandle {
  if (schedulerHandle) return schedulerHandle;
  let stopped = false;

  // Run an initial check shortly after startup
  const initial = setTimeout(() => {
    if (stopped) return;
    runScheduledHealthCheck().catch((err) =>
      logger.error({ err }, "Health watchdog: initial check failed"),
    );
  }, 30_000);
  initial.unref();

  const checkTimer = setInterval(() => {
    if (stopped) return;
    runScheduledHealthCheck().catch((err) =>
      logger.error({ err }, "Health watchdog: check failed"),
    );
  }, CHECK_INTERVAL_MS);
  checkTimer.unref();

  const purgeTimer = setInterval(() => {
    if (stopped) return;
    withSchedulerLock(
      SCHEDULER_LOCK_KEYS.healthWatchdogPurge,
      purgeOldHealthLogs,
    ).catch((err) => logger.error({ err }, "Health watchdog: purge failed"));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const handle: SchedulerStopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(initial);
      clearInterval(checkTimer);
      clearInterval(purgeTimer);
      if (schedulerHandle === handle) schedulerHandle = undefined;
    },
  };
  schedulerHandle = handle;

  logger.info("Health watchdog started (interval: 5 min)");
  return handle;
}

/** Expose in-process state for the lightweight nav-indicator endpoint. */
export function getWatchdogState(): {
  overallStatus: "ok" | "degraded" | "unknown";
  lastAlertAt: string | null;
  consecutiveFailures: number;
  operationalStatus: "ok" | "warning" | "critical" | "unknown";
  activeOperationalAlerts: number;
  lastOperationalAlertAt: string | null;
  alertTransport: "local_log_only" | "local_log_and_https_webhook";
} {
  if (state.lastAlertedState === null) {
    return {
      overallStatus:
        operationalStatus === "warning" || operationalStatus === "critical"
          ? "degraded"
          : "unknown",
      lastAlertAt: null,
      consecutiveFailures: 0,
      operationalStatus,
      activeOperationalAlerts,
      lastOperationalAlertAt,
      alertTransport: getOperationalAlertTransportMode(),
    };
  }
  return {
    overallStatus:
      state.lastAlertedState === "fail" ||
      operationalStatus === "warning" ||
      operationalStatus === "critical"
        ? "degraded"
        : operationalStatus === "unknown"
          ? "unknown"
          : "ok",
    lastAlertAt: state.lastAlertAt,
    consecutiveFailures: state.consecutiveFailures,
    operationalStatus,
    activeOperationalAlerts,
    lastOperationalAlertAt,
    alertTransport: getOperationalAlertTransportMode(),
  };
}
