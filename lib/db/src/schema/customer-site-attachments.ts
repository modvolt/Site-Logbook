import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customerSitesTable } from "./customer-sites";

export const customerSiteAttachmentsTable = pgTable("customer_site_attachments", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id")
    .notNull()
    .references(() => customerSitesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("ostatni"),
  fileName: text("file_name"),
  url: text("url"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCustomerSiteAttachmentSchema = createInsertSchema(customerSiteAttachmentsTable).omit({ id: true, createdAt: true });
export type InsertCustomerSiteAttachment = z.infer<typeof insertCustomerSiteAttachmentSchema>;
export type CustomerSiteAttachment = typeof customerSiteAttachmentsTable.$inferSelect;
