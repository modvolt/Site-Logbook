import nodemailer from "nodemailer";
import { and, eq, lte, or, isNotNull, inArray } from "drizzle-orm";
import { db, ppeAssignmentsTable, ppeItemsTable, peopleTable, usersTable } from "@workspace/db";
import { logger } from "./logger";
import { resolveEmailConfig } from "./email";
import { withSchedulerLock, SCHEDULER_LOCK_KEYS } from "./scheduler-lock";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Format an ISO "YYYY-MM-DD" date as Czech `d.M.yyyy`. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(d)}.${Number(m)}.${y}`;
}

interface OverdueRow {
  assignmentId: number;
  personName: string;
  ppeName: string;
  replaceBy: string | null;
  nextInspectionAt: string | null;
}

/**
 * Collect all currently-overdue PPE assignments: status=issued and either
 * replaceBy or nextInspectionAt is on or before today.
 */
export async function collectOverduePpeAssignments(): Promise<OverdueRow[]> {
  const todayStr = today();

  const rows = await db
    .select({
      assignmentId: ppeAssignmentsTable.id,
      personName: ppeAssignmentsTable.personNameSnapshot,
      ppeName: ppeAssignmentsTable.ppeNameSnapshot,
      replaceBy: ppeAssignmentsTable.replaceBy,
      nextInspectionAt: ppeAssignmentsTable.nextInspectionAt,
    })
    .from(ppeAssignmentsTable)
    .where(
      and(
        eq(ppeAssignmentsTable.status, "issued"),
        or(
          and(isNotNull(ppeAssignmentsTable.replaceBy), lte(ppeAssignmentsTable.replaceBy, todayStr)),
          and(isNotNull(ppeAssignmentsTable.nextInspectionAt), lte(ppeAssignmentsTable.nextInspectionAt, todayStr)),
        ),
      )!,
    )
    .orderBy(ppeAssignmentsTable.personNameSnapshot, ppeAssignmentsTable.ppeNameSnapshot);

  return rows.map((r) => ({
    assignmentId: r.assignmentId,
    personName: r.personName,
    ppeName: r.ppeName,
    replaceBy: r.replaceBy,
    nextInspectionAt: r.nextInspectionAt,
  }));
}

/** Collect e-mail addresses of all active admin and master users who have an email set. */
async function collectAdminEmails(): Promise<string[]> {
  const admins = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["admin", "master"]),
      ),
    );

  return admins
    .map((u) => (u.email ?? "").trim())
    .filter((e) => e.length > 0 && e.includes("@"));
}

function buildEmailText(rows: OverdueRow[]): { subject: string; text: string } {
  const todayStr = today();
  const subject = `OOPP – ${rows.length} položek po termínu (${fmtDate(todayStr)})`;

  const lines: string[] = [
    `Dobrý den,`,
    ``,
    `následující osobní ochranné pracovní prostředky jsou po termínu výměny nebo inspekce:`,
    ``,
  ];

  for (const row of rows) {
    const parts: string[] = [`• ${row.personName} – ${row.ppeName}`];
    if (row.replaceBy && row.replaceBy <= todayStr) {
      parts.push(`  Výměna do: ${fmtDate(row.replaceBy)}`);
    }
    if (row.nextInspectionAt && row.nextInspectionAt <= todayStr) {
      parts.push(`  Inspekce do: ${fmtDate(row.nextInspectionAt)}`);
    }
    lines.push(...parts);
  }

  lines.push(
    ``,
    `Prosíme o prověření a zajištění nápravy v aplikaci Stavba (sekce OOPP).`,
    ``,
    `Tato zpráva byla vygenerována automaticky.`,
  );

  return { subject, text: lines.join("\n") };
}

/**
 * Run one pass of the PPE overdue check. Queries overdue assignments, collects
 * admin e-mails, and sends a single digest e-mail. No e-mail is sent when there
 * are zero overdue items or no admin has an e-mail address configured.
 */
export async function runPpeOverdueNotification(): Promise<{
  overdueCount: number;
  sent: boolean;
  recipients: number;
}> {
  const overdue = await collectOverduePpeAssignments();
  if (overdue.length === 0) {
    return { overdueCount: 0, sent: false, recipients: 0 };
  }

  const recipients = await collectAdminEmails();
  if (recipients.length === 0) {
    logger.warn(
      { overdueCount: overdue.length },
      "PPE overdue items found but no admin has an email address — skipping notification",
    );
    return { overdueCount: overdue.length, sent: false, recipients: 0 };
  }

  let cfg;
  try {
    cfg = await resolveEmailConfig();
  } catch (err) {
    logger.warn(
      { err, overdueCount: overdue.length },
      "PPE overdue notification skipped — email not configured",
    );
    return { overdueCount: overdue.length, sent: false, recipients: 0 };
  }

  const { subject, text } = buildEmailText(overdue);

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });

  try {
    await transporter.sendMail({
      from: cfg.from,
      to: recipients,
      subject,
      text,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, overdueCount: overdue.length, recipients: recipients.length },
      `PPE overdue notification email failed: ${detail}`,
    );
    return { overdueCount: overdue.length, sent: false, recipients: recipients.length };
  }

  logger.info(
    { overdueCount: overdue.length, recipients: recipients.length },
    "PPE overdue notification sent",
  );
  return { overdueCount: overdue.length, sent: true, recipients: recipients.length };
}

let schedulerStarted = false;

/**
 * Start the daily PPE overdue notification scheduler. Idempotent. Interval is
 * PPE_NOTIFY_INTERVAL_HOURS (default 24 h). Safe to run even when e-mail is
 * not configured — it logs a warning and skips silently.
 */
export function startPpeOverdueScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const hours = Number(process.env.PPE_NOTIFY_INTERVAL_HOURS);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;

  const tick = () =>
    withSchedulerLock(SCHEDULER_LOCK_KEYS.ppeOverdue, async () => {
      await runPpeOverdueNotification();
    }).catch((err) =>
      logger.error({ err }, "PPE overdue notification sweep failed"),
    );

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  // Run once ~2 minutes after startup so the initial check fires on a fresh
  // deploy without waiting a full day.
  const initial = setTimeout(tick, 2 * 60 * 1000);
  initial.unref();

  logger.info(
    { intervalHours: intervalMs / (60 * 60 * 1000) },
    "PPE overdue notification scheduler started",
  );
}
