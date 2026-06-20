import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceRemindersTable,
  auditLogTable,
  type Invoice,
} from "@workspace/db";
import { logger } from "./logger";
import { sendEmailWithPdf } from "./email";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import {
  ensureBillingSettings,
  daysOverdue,
  parseReminderDays,
  type Actor,
  type AppError,
} from "./invoice-service";
import { num } from "./invoice-calc";

const objectStorage = new ObjectStorageService();

function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Czech plural of "den" — 1 den, 2–4 dny, 5+ dní. */
function dayNoun(days: number): string {
  const n = Math.abs(days);
  if (n === 1) return "den";
  if (n >= 2 && n <= 4) return "dny";
  return "dní";
}

/** Format an amount as Czech koruna, e.g. `1 234,50 Kč`. */
function fmtKc(value: number): string {
  const formatted = value.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} Kč`;
}

/** Format an ISO "YYYY-MM-DD" date as Czech `d.M.yyyy`. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(d)}.${Number(m)}.${y}`;
}

export interface ReminderText {
  subject: string;
  message: string;
}

/**
 * Build the default polite Czech reminder e-mail for an overdue invoice. Used to
 * pre-fill the manual reminder dialog and as the body of automatic reminders.
 */
export function composeReminder(invoice: Invoice, overdueDays: number): ReminderText {
  const number = invoice.invoiceNumber ?? `#${invoice.id}`;
  const amount = fmtKc(num(invoice.totalWithVat));
  const due = fmtDate(invoice.dueDate);
  const subject = `Upomínka – faktura ${number} po splatnosti`;
  const message =
    `Dobrý den,\n\n` +
    `dovolujeme si Vás upozornit, že faktura ${number} ` +
    `se splatností ${due} je ${overdueDays} ${dayNoun(overdueDays)} po splatnosti.\n\n` +
    `Fakturovaná částka: ${amount}\n\n` +
    `Prosíme o její úhradu v nejbližším možném termínu. ` +
    `Pokud jste platbu již provedli, považujte tuto zprávu za bezpředmětnou ` +
    `a předem děkujeme.\n\n` +
    `Fakturu naleznete v příloze.\n\n` +
    `S pozdravem`;
  return { subject, message };
}

async function loadInvoice(id: number): Promise<Invoice | null> {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return invoice ?? null;
}

/** True when an invoice is an outstanding receivable that is past its due date. */
export function isOverdue(invoice: Pick<Invoice, "status" | "dueDate">): boolean {
  if (invoice.status !== "issued" && invoice.status !== "sent") return false;
  if (!invoice.dueDate) return false;
  return daysOverdue(invoice.dueDate) > 0;
}

export interface SendReminderOptions {
  to?: string | null;
  subject?: string | null;
  message?: string | null;
  /** Set for scheduler-driven sends; identifies the threshold day that fired. */
  threshold?: number | null;
  auto?: boolean;
}

export interface SendReminderResult {
  sent: boolean;
  to: string;
  daysOverdue: number;
}

/**
 * Send a single overdue reminder for an invoice: validates it is overdue,
 * attaches the invoice PDF, sends the e-mail, records it in invoice_reminders
 * and the audit log. Throws an AppError (with statusCode) on validation failure.
 */
export async function sendInvoiceReminder(
  id: number,
  opts: SendReminderOptions,
  actor: Actor | null,
): Promise<SendReminderResult> {
  const invoice = await loadInvoice(id);
  if (!invoice) throw appError(404, "Faktura nenalezena.");
  if (invoice.status === "draft" || !invoice.pdfObjectPath) {
    throw appError(409, "Fakturu je nutné nejprve vystavit.");
  }
  if (invoice.status === "paid") {
    throw appError(409, "Faktura je již zaplacena.");
  }
  if (invoice.status === "cancelled") {
    throw appError(409, "Faktura je stornována.");
  }
  if (!isOverdue(invoice)) {
    throw appError(409, "Faktura není po splatnosti.");
  }

  const overdue = daysOverdue(invoice.dueDate!);
  const to = (opts.to ?? invoice.customerEmail ?? "").trim();
  if (!EMAIL_PATTERN.test(to)) {
    throw appError(400, "Chybí platná e-mailová adresa příjemce.");
  }

  const defaults = composeReminder(invoice, overdue);
  const subject = (opts.subject ?? "").trim() || defaults.subject;
  const message = (opts.message ?? "").trim() || defaults.message;
  const number = invoice.invoiceNumber ?? `#${id}`;

  let buffer: Buffer;
  try {
    buffer = await objectStorage.getPrivateObjectBuffer(invoice.pdfObjectPath);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      throw appError(404, "PDF faktury nebylo nalezeno v úložišti.");
    }
    throw err;
  }

  try {
    await sendEmailWithPdf({
      to,
      subject,
      text: message,
      pdfBase64: buffer.toString("base64"),
      filename: `faktura-${number.replace(/[^\w.-]+/g, "-")}.pdf`,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw appError(502, detail || "Odeslání upomínky e-mailem selhalo.");
  }

  await db.transaction(async (tx) => {
    await tx.insert(invoiceRemindersTable).values({
      invoiceId: id,
      threshold: opts.threshold ?? null,
      daysOverdue: overdue,
      toEmail: to,
      auto: opts.auto ?? false,
      sentByUserId: actor?.userId ?? null,
    });
    await tx.insert(auditLogTable).values({
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? (opts.auto ? "Automatická upomínka" : null),
      action: "reminder",
      entityType: "invoices",
      entityId: id,
      summary: `Upomínka k faktuře ${number} odeslána na ${to} (${overdue} ${dayNoun(
        overdue,
      )} po splatnosti)`,
      method: "POST",
      path: `/billing/invoices/${id}/reminder`,
    });
  });

  return { sent: true, to, daysOverdue: overdue };
}

/**
 * Run one pass of automatic reminders: for every overdue issued/sent invoice,
 * find the highest configured threshold it has crossed that has not yet been
 * sent, and send a reminder for it. Each threshold fires at most once per
 * invoice. Safe to call repeatedly (idempotent within a day).
 */
export async function runAutomaticReminders(): Promise<{
  considered: number;
  sent: number;
  failed: number;
}> {
  const settings = await ensureBillingSettings();
  if (!settings.reminderEnabled) return { considered: 0, sent: 0, failed: 0 };

  const thresholds = parseReminderDays(settings.reminderDays);
  if (!thresholds.length) return { considered: 0, sent: 0, failed: 0 };

  const candidates = await db
    .select()
    .from(invoicesTable)
    .where(inArray(invoicesTable.status, ["issued", "sent"]));

  const overdue = candidates.filter((inv) => isOverdue(inv));
  if (!overdue.length) return { considered: 0, sent: 0, failed: 0 };

  const overdueIds = overdue.map((inv) => inv.id);
  const sentRows = await db
    .select({
      invoiceId: invoiceRemindersTable.invoiceId,
      threshold: invoiceRemindersTable.threshold,
    })
    .from(invoiceRemindersTable)
    .where(
      and(
        inArray(invoiceRemindersTable.invoiceId, overdueIds),
        eq(invoiceRemindersTable.auto, true),
      ),
    );
  const sentByInvoice = new Map<number, Set<number>>();
  for (const r of sentRows) {
    if (r.threshold == null) continue;
    const set = sentByInvoice.get(r.invoiceId) ?? new Set<number>();
    set.add(r.threshold);
    sentByInvoice.set(r.invoiceId, set);
  }

  let considered = 0;
  let sent = 0;
  let failed = 0;

  for (const invoice of overdue) {
    const overdueCount = daysOverdue(invoice.dueDate!);
    const already = sentByInvoice.get(invoice.id) ?? new Set<number>();
    // Highest crossed threshold not yet sent — only the most recent milestone
    // fires so a freshly-enabled config doesn't blast every past threshold.
    const due = thresholds
      .filter((t) => overdueCount >= t && !already.has(t))
      .sort((a, b) => b - a)[0];
    if (due == null) continue;
    // Skip invoices without a deliverable customer e-mail rather than erroring.
    if (!invoice.customerEmail || !EMAIL_PATTERN.test(invoice.customerEmail.trim())) {
      continue;
    }
    considered += 1;
    try {
      await sendInvoiceReminder(
        invoice.id,
        { threshold: due, auto: true },
        null,
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, invoiceId: invoice.id, threshold: due },
        "Automatic invoice reminder failed",
      );
    }
  }

  if (sent || failed) {
    logger.info({ considered, sent, failed }, "Automatic invoice reminders run");
  }
  return { considered, sent, failed };
}

let schedulerStarted = false;

/**
 * Start the periodic automatic-reminder sweep. Idempotent. Interval is
 * REMINDER_INTERVAL_HOURS (default 12h). The sweep itself is gated on the
 * `reminderEnabled` billing setting, so it is cheap to run while disabled.
 */
export function startReminderScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const hours = Number(process.env.REMINDER_INTERVAL_HOURS);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;

  const tick = () =>
    runAutomaticReminders().catch((err) =>
      logger.error({ err }, "Automatic reminder sweep failed"),
    );

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  // Run once shortly after startup so a freshly-due invoice doesn't wait a full
  // interval, but give the server a moment to settle first.
  const initial = setTimeout(tick, 60_000);
  initial.unref();

  logger.info(
    { intervalHours: intervalMs / (60 * 60 * 1000) },
    "Invoice reminder scheduler started",
  );
}
