import { pgTable, serial, text, integer, boolean, timestamp, date, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";
import { usersTable } from "./users";

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

export const PPE_HANDOVER_EVENT_TYPES = ["signed", "pdf_downloaded", "signature_viewed"] as const;
export type PpeHandoverEventType = (typeof PPE_HANDOVER_EVENT_TYPES)[number];

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
    ppeCategorySnapshot: text("ppe_category_snapshot"),
    ppeStandardSnapshot: text("ppe_standard_snapshot"),
    ppeProtectionClassSnapshot: text("ppe_protection_class_snapshot"),
    ppeRiskDescriptionSnapshot: text("ppe_risk_description_snapshot"),
    quantity: integer("quantity").notNull().default(1),
    size: text("size"),
    serialNumber: text("serial_number"),
    issuedAt: date("issued_at").notNull(),
    replaceBy: date("replace_by"),
    nextInspectionAt: date("next_inspection_at"),
    returnedAt: date("returned_at"),
    status: text("status").notNull().default("issued"),
    employeeConfirmedAt: timestamp("employee_confirmed_at"),
    signatureToken: text("signature_token").unique(),
    signatureObjectPath: text("signature_object_path"),
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

export const ppeHandoverDocumentsTable = pgTable(
  "ppe_handover_documents",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => ppeAssignmentsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    documentNumber: text("document_number").notNull(),
    signatoryName: text("signatory_name").notNull(),
    signedAt: timestamp("signed_at").notNull(),
    confirmationText: text("confirmation_text").notNull(),
    pngObjectPath: text("png_object_path").notNull(),
    pngSha256: text("png_sha256").notNull(),
    pdfObjectPath: text("pdf_object_path").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    issuerSnapshot: text("issuer_snapshot").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("ppe_handover_documents_assignment_version_uniq").on(t.assignmentId, t.version),
    index("ppe_handover_documents_assignment_id_idx").on(t.assignmentId),
  ],
);

export const ppeHandoverEventsTable = pgTable(
  "ppe_handover_events",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => ppeAssignmentsTable.id, { onDelete: "cascade" }),
    handoverDocumentId: integer("handover_document_id")
      .references(() => ppeHandoverDocumentsTable.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    actorUserId: integer("actor_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ppe_handover_events_assignment_id_idx").on(t.assignmentId),
  ],
);

export const insertPpeItemSchema = createInsertSchema(ppeItemsTable).omit({ id: true, createdAt: true });
export type InsertPpeItem = z.infer<typeof insertPpeItemSchema>;
export type PpeItem = typeof ppeItemsTable.$inferSelect;

export const insertPpeAssignmentSchema = createInsertSchema(ppeAssignmentsTable).omit({
  id: true, createdAt: true, ppeNameSnapshot: true, personNameSnapshot: true,
  employeeConfirmedAt: true, ppeCategorySnapshot: true, ppeStandardSnapshot: true,
  ppeProtectionClassSnapshot: true, ppeRiskDescriptionSnapshot: true,
});
export type InsertPpeAssignment = z.infer<typeof insertPpeAssignmentSchema>;
export type PpeAssignment = typeof ppeAssignmentsTable.$inferSelect;
export type PpeHandoverDocument = typeof ppeHandoverDocumentsTable.$inferSelect;
export type PpeHandoverEvent = typeof ppeHandoverEventsTable.$inferSelect;
