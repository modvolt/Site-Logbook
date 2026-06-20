import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Audit/diagnostics log for the incoming-mail importer. One row per processed
 * e-mail message. Used both for re-poll de-duplication (a message whose
 * `messageId` is already logged is never processed again, regardless of its
 * \Seen flag or IMAP UID validity) and for visibility — every outcome,
 * including failures, is recorded here and surfaced in the Settings UI so a
 * supplier invoice is never silently dropped.
 *
 * status:
 *   imported       — at least one attachment became a cost document
 *   no_attachments — message had no supported attachments (informational)
 *   skipped        — every attachment was a duplicate of an existing document
 *   failed         — processing errored (see `error`)
 */
export const emailImportLogTable = pgTable(
  "email_import_log",
  {
    id: serial("id").primaryKey(),
    // RFC 5322 Message-ID header — globally unique per message. Falls back to a
    // synthesized "uid:<n>@<folder>" token if a message lacks the header.
    messageId: text("message_id").notNull(),
    sender: text("sender"),
    subject: text("subject"),
    receivedAt: timestamp("received_at"),
    status: text("status").notNull(),
    attachmentsTotal: integer("attachments_total").notNull().default(0),
    attachmentsImported: integer("attachments_imported").notNull().default(0),
    // Comma-separated billing_documents ids created from this message.
    documentIds: text("document_ids"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_import_log_message_id_idx").on(t.messageId),
    index("email_import_log_created_at_idx").on(t.createdAt),
  ],
);

export type EmailImportLog = typeof emailImportLogTable.$inferSelect;
