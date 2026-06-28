import { pgTable, serial, text, timestamp, integer, date, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customerSitesTable } from "./customer-sites";
import { customersTable } from "./customers";

export const CUSTOMER_DOC_STATUSES = ["current", "expiring", "expired", "replaced", "archived"] as const;
export type CustomerDocStatus = (typeof CUSTOMER_DOC_STATUSES)[number];

export const customerSiteAttachmentsTable = pgTable(
  "customer_site_attachments",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .references(() => customerSitesTable.id, { onDelete: "cascade" }),
    customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("ostatni"),
    fileName: text("file_name"),
    url: text("url"),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    title: text("title"),
    documentNumber: text("document_number"),
    revision: text("revision"),
    issuedAt: date("issued_at"),
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),
    docStatus: text("doc_status").notNull().default("current"),
    replacesAttachmentId: integer("replaces_attachment_id"),
    tags: text("tags"),
    mimeType: text("mime_type"),
    fileSize: bigint("file_size", { mode: "number" }),
    sha256: text("sha256"),
    uploadedByUserId: integer("uploaded_by_user_id"),
    uploadedByNameSnapshot: text("uploaded_by_name_snapshot"),
    updatedAt: timestamp("updated_at"),
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    index("idx_csa_customer_id").on(t.customerId),
    index("idx_csa_valid_until").on(t.validUntil),
  ],
);

export const insertCustomerSiteAttachmentSchema = createInsertSchema(customerSiteAttachmentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomerSiteAttachment = z.infer<typeof insertCustomerSiteAttachmentSchema>;
export type CustomerSiteAttachment = typeof customerSiteAttachmentsTable.$inferSelect;
