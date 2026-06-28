import { pgTable, serial, text, integer, boolean, timestamp, date, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";

export const PPE_CATEGORIES = [
  "hlava",
  "ruky",
  "telo",
  "nohy",
  "oci",
  "sluch",
  "dychaci",
  "ostatni",
] as const;
export type PpeCategory = (typeof PPE_CATEGORIES)[number];

export const PPE_STATUSES = ["issued", "returned", "damaged", "lost", "disposed"] as const;
export type PpeStatus = (typeof PPE_STATUSES)[number];

export const ppeItemsTable = pgTable("ppe_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default("ostatni"),
  description: text("description"),
  defaultReplacementMonths: integer("default_replacement_months"),
  defaultInspectionMonths: integer("default_inspection_months"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ppeAssignmentsTable = pgTable(
  "ppe_assignments",
  {
    id: serial("id").primaryKey(),
    ppeItemId: integer("ppe_item_id")
      .notNull()
      .references(() => ppeItemsTable.id, { onDelete: "restrict" }),
    personId: integer("person_id")
      .notNull()
      .references(() => peopleTable.id, { onDelete: "restrict" }),
    ppeNameSnapshot: text("ppe_name_snapshot").notNull(),
    personNameSnapshot: text("person_name_snapshot").notNull(),
    quantity: integer("quantity").notNull().default(1),
    size: text("size"),
    serialNumber: text("serial_number"),
    issuedAt: date("issued_at").notNull(),
    replaceBy: date("replace_by"),
    nextInspectionAt: date("next_inspection_at"),
    returnedAt: date("returned_at"),
    status: text("status").notNull().default("issued"),
    employeeConfirmedAt: timestamp("employee_confirmed_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ppe_assignments_person_id_idx").on(t.personId),
    index("ppe_assignments_ppe_item_id_idx").on(t.ppeItemId),
    index("ppe_assignments_status_idx").on(t.status),
    index("ppe_assignments_replace_by_idx").on(t.replaceBy),
    index("ppe_assignments_next_inspection_idx").on(t.nextInspectionAt),
  ],
);

export const insertPpeItemSchema = createInsertSchema(ppeItemsTable).omit({ id: true, createdAt: true });
export type InsertPpeItem = z.infer<typeof insertPpeItemSchema>;
export type PpeItem = typeof ppeItemsTable.$inferSelect;

export const insertPpeAssignmentSchema = createInsertSchema(ppeAssignmentsTable).omit({ id: true, createdAt: true, ppeNameSnapshot: true, personNameSnapshot: true });
export type InsertPpeAssignment = z.infer<typeof insertPpeAssignmentSchema>;
export type PpeAssignment = typeof ppeAssignmentsTable.$inferSelect;
