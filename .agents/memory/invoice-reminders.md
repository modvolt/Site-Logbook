---
name: Invoice overdue reminders
description: How overdue-payment reminder emails (manual + automatic) are wired in the Stavba billing module.
---

# Invoice overdue reminders

Manual + optional automatic overdue-invoice reminder emails, on top of the existing
`sendEmailWithPdf` SMTP path.

## Send invariants
- A reminder can only be sent for an invoice that is `issued`/`sent`, overdue
  (`daysOverdue(dueDate) > 0`), AND has a generated `pdfObjectPath`. An invoice
  with no PDF (e.g. created directly in SQL) 409s with "Fakturu je nutné nejprve
  vystavit." — this is correct, not a bug; real issued invoices always have a PDF.
- `paid`/`cancelled` are rejected before the overdue check.
- Recipient defaults to `customerEmail` but the request body `to` overrides it;
  empty subject/message fall back to the server-composed Czech default.

## Automatic reminders
- Gated on `billing_settings.reminderEnabled`; thresholds come from
  `reminderDays` (comma string, normalized on write, default "3,14,30").
- Per invoice, the scheduler fires only the **highest crossed threshold that has
  not yet been sent**, recorded by a row in `invoice_reminders` with that
  `threshold`. Each threshold fires at most once (dedupe is by
  `(invoiceId, threshold)`), so reopening/re-running never double-sends.
- Manual sends store `threshold = null` so they never block an automatic threshold.
- Scheduler interval env `REMINDER_INTERVAL_HOURS` (default 12); started from
  `index.ts` alongside `startBackupScheduler()`.

## Audit + logging
- Every send inserts an `audit_log` row with `action: "reminder"` (new action
  value), entityType `invoices`. Auto sends set actorName "Automatická upomínka".

**Why:** task required pre-filled Czech reminder text (number/amount/days overdue),
optional auto reminders with repeat protection, and audit logging.
**How to apply:** preview default text via GET `/billing/invoices/:id/reminder-preview`;
send via POST `/billing/invoices/:id/reminder`. Both 409 when not overdue.
