import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { billingDocumentsTable } from "./billing-documents";

/**
 * Connected mailbox for importing supplier cost documents (přijaté doklady) from
 * e-mail — currently Gmail / Google Workspace via OAuth.
 *
 * This whole feature is OPTIONAL and OFF by default: it only works when the
 * operator has configured their own Google OAuth app (GOOGLE_CLIENT_ID/SECRET/
 * REDIRECT_URI) and a TOKEN_ENCRYPTION_KEY. The app runs fully without it.
 *
 * The OAuth refresh token is stored ENCRYPTED (AES-256-GCM) — never in plaintext
 * and never logged. Only the `refresh_token_encrypted` ciphertext is persisted;
 * access tokens are short-lived and refreshed on demand, not stored.
 *
 * In practice a single account is connected at a time (a dedicated invoice
 * mailbox), but the table is general. `label_filter` scopes the sync to one
 * Gmail label; `label_after_import` (needs the gmail.modify scope) labels
 * imported messages so they are not re-fetched.
 *
 * status: connected | disconnected
 */
export const emailImportAccountsTable = pgTable(
  "email_import_accounts",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("gmail"),
    status: text("status").notNull().default("connected"),
    emailAddress: text("email_address"),

    // Encrypted OAuth refresh token (AES-256-GCM payload, never plaintext).
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    scope: text("scope"),

    // Sync scoping / behaviour (snapshot of env config at connect time).
    labelFilter: text("label_filter"),
    labelAfterImport: integer("label_after_import").notNull().default(0),

    // Last sync bookkeeping.
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),

    connectedByUserId: integer("connected_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    connectedAt: timestamp("connected_at"),
    disconnectedAt: timestamp("disconnected_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("email_import_accounts_status_idx").on(t.status)],
);

/**
 * One row per fetched e-mail message. The original message stays in the mailbox;
 * we only keep lightweight metadata + the per-message processing state so the
 * admin can review what arrived, import the attachments, or ignore the message.
 *
 * `provider_message_id` is the Gmail message id and is unique per account so the
 * same message is never ingested twice.
 *
 * status: new | imported | ignored | error
 */
export const emailImportMessagesTable = pgTable(
  "email_import_messages",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => emailImportAccountsTable.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    threadId: text("thread_id"),

    fromAddress: text("from_address"),
    fromName: text("from_name"),
    subject: text("subject"),
    snippet: text("snippet"),
    // Gmail internalDate (ms since epoch) kept as ISO timestamp for sorting.
    sentAt: timestamp("sent_at"),

    status: text("status").notNull().default("new"),
    error: text("error"),
    attachmentCount: integer("attachment_count").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    labeled: integer("labeled").notNull().default(0),
    processedAt: timestamp("processed_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_import_messages_provider_message_id_idx").on(
      t.accountId,
      t.providerMessageId,
    ),
    index("email_import_messages_status_idx").on(t.status),
  ],
);

/**
 * One row per attachment discovered on an imported message. Inline parts (e.g.
 * signature logos) and unsupported types are recorded as `skipped` with a reason
 * rather than downloaded. Supported attachments are downloaded to private object
 * storage, de-duplicated by SHA-256 (against both previously-imported
 * attachments and existing billing_documents), and — when imported — linked to
 * the created billing_document via `billing_document_id`.
 */
export const emailImportAttachmentsTable = pgTable(
  "email_import_attachments",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => emailImportMessagesTable.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id"),
    fileName: text("file_name"),
    contentType: text("content_type"),
    size: integer("size"),
    sha256: text("sha256"),
    objectPath: text("object_path"),

    skipped: integer("skipped").notNull().default(0),
    skipReason: text("skip_reason"),

    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("email_import_attachments_message_id_idx").on(t.messageId),
    index("email_import_attachments_sha256_idx").on(t.sha256),
  ],
);

export const insertEmailImportAccountSchema = createInsertSchema(
  emailImportAccountsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEmailImportAccount = z.infer<
  typeof insertEmailImportAccountSchema
>;
export type EmailImportAccount = typeof emailImportAccountsTable.$inferSelect;

export type EmailImportMessage = typeof emailImportMessagesTable.$inferSelect;
export type EmailImportAttachment =
  typeof emailImportAttachmentsTable.$inferSelect;
