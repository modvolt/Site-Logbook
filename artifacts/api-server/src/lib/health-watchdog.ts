/**
 * Health watchdog — checks DB and S3 every 5 minutes, writes results to
 * health_log, and sends email alerts on ok→fail and fail→ok transitions
 * (only after 2 consecutive failures to avoid noise from transient hiccups).
 */
import { sql } from "drizzle-orm";
import { db, healthLogTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";
import { diagnoseS3 } from "./objectStorage";
import { resolveEmailConfig } from "./email";
import nodemailer from "nodemailer";

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

// ---------------------------------------------------------------------------
// Individual sub-checks
// ---------------------------------------------------------------------------

async function pingDb(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const t0 = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - t0 };
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
    const verdict = typeof result["verdict"] === "string" ? result["verdict"] : null;
    return result["ok"] === true || (typeof verdict === "string" && verdict.startsWith("OK"));
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
      .where(and(eq(usersTable.isActive, true)));
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
  logger.info({ recipients, subject }, "Health alert email sent");
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

export async function runHealthCheck(): Promise<void> {
  const [dbResult, s3Ok, smtpOk] = await Promise.all([
    pingDb(),
    pingS3(),
    checkSmtpConfigured(),
  ]);

  const { ok: dbOk, latencyMs: dbLatencyMs } = dbResult;
  const overallOk = dbOk && s3Ok;
  const overallStatus: "ok" | "degraded" = overallOk ? "ok" : "degraded";

  // Write to health_log
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
    await db.execute(
      sql`DELETE FROM health_log WHERE checked_at < ${cutoff}`,
    );
    logger.info("Health watchdog: purged old health_log rows");
  } catch (err) {
    logger.error({ err }, "Health watchdog: failed to purge health_log");
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let started = false;

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startHealthWatchdog(): void {
  if (started) return;
  started = true;

  // Run an initial check shortly after startup
  setTimeout(() => {
    runHealthCheck().catch((err) =>
      logger.error({ err }, "Health watchdog: initial check failed"),
    );
  }, 30_000);

  const checkTimer = setInterval(() => {
    runHealthCheck().catch((err) =>
      logger.error({ err }, "Health watchdog: check failed"),
    );
  }, CHECK_INTERVAL_MS);
  checkTimer.unref();

  const purgeTimer = setInterval(() => {
    purgeOldHealthLogs().catch((err) =>
      logger.error({ err }, "Health watchdog: purge failed"),
    );
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  logger.info("Health watchdog started (interval: 5 min)");
}

/** Expose in-process state for the lightweight nav-indicator endpoint. */
export function getWatchdogState(): {
  overallStatus: "ok" | "degraded" | "unknown";
  lastAlertAt: string | null;
  consecutiveFailures: number;
} {
  if (state.lastAlertedState === null) {
    return { overallStatus: "unknown", lastAlertAt: null, consecutiveFailures: 0 };
  }
  return {
    overallStatus: state.lastAlertedState === "fail" ? "degraded" : "ok",
    lastAlertAt: state.lastAlertAt,
    consecutiveFailures: state.consecutiveFailures,
  };
}
