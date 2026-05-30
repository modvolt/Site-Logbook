import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { activitiesTable } from "./activities";

export const activityAttachmentsTable = pgTable("activity_attachments", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id").notNull().references(() => activitiesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("photo"),
  fileName: text("file_name"),
  url: text("url"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertActivityAttachmentSchema = createInsertSchema(activityAttachmentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivityAttachment = z.infer<typeof insertActivityAttachmentSchema>;
export type ActivityAttachment = typeof activityAttachmentsTable.$inferSelect;
