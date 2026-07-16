import { pgTable, serial, text, timestamp, numeric, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export const attachmentsTable = pgTable("attachments", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("manual_item"),
  fileName: text("file_name"),
  url: text("url"),
  description: text("description"),
  amount: numeric("amount", { precision: 10, scale: 2 }),
  billingDocumentId: integer("billing_document_id"),
  pageIndex: integer("page_index"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("attachments_job_id_idx").on(t.jobId),
  index("attachments_file_name_idx").on(t.fileName),
  index("attachments_billing_document_id_idx").on(t.billingDocumentId),
]);

export const insertAttachmentSchema = createInsertSchema(attachmentsTable).omit({ id: true, createdAt: true });
export type InsertAttachment = z.infer<typeof insertAttachmentSchema>;
export type Attachment = typeof attachmentsTable.$inferSelect;
