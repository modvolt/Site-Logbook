import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { ppeAssignmentsTable } from "./ppe";
import { usersTable } from "./users";

export const PPE_PUBLIC_EVIDENCE_PURPOSES = [
  "ppe_signature",
  "ppe_confirmation",
] as const;

export type PpePublicEvidencePurpose =
  (typeof PPE_PUBLIC_EVIDENCE_PURPOSES)[number];

export interface PpePublicEvidenceSnapshot {
  schemaVersion: 1;
  purpose: PpePublicEvidencePurpose;
  assignment: {
    id: number;
    ppeNameSnapshot: string;
    personNameSnapshot: string;
    ppeCategorySnapshot: string | null;
    ppeStandardSnapshot: string | null;
    ppeProtectionClassSnapshot: string | null;
    ppeRiskDescriptionSnapshot: string | null;
    quantity: number;
    size: string | null;
    serialNumber: string | null;
    issuedAt: string;
    replaceBy: string | null;
    nextInspectionAt: string | null;
  };
  confirmationText: string;
}

/**
 * Immutable content shown to a public PPE recipient before one exact action.
 * Database migrations must protect rows with the shared immutable-evidence
 * UPDATE/DELETE trigger used by the other evidence-version tables.
 */
export const ppePublicEvidenceVersionsTable = pgTable(
  "ppe_public_evidence_versions",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => ppeAssignmentsTable.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    version: integer("version").notNull(),
    dataSnapshot: jsonb("data_snapshot")
      .$type<PpePublicEvidenceSnapshot>()
      .notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    confirmationText: text("confirmation_text").notNull(),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("ppe_public_evidence_versions_assignment_purpose_version_uq").on(
      table.assignmentId,
      table.purpose,
      table.version,
    ),
    index("ppe_public_evidence_versions_assignment_idx").on(
      table.assignmentId,
      table.purpose,
      table.createdAt,
    ),
    check(
      "ppe_public_evidence_versions_purpose_chk",
      sql`${table.purpose} in ('ppe_signature', 'ppe_confirmation')`,
    ),
    check(
      "ppe_public_evidence_versions_version_chk",
      sql`${table.version} > 0`,
    ),
    check(
      "ppe_public_evidence_versions_hash_chk",
      sql`${table.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ppe_public_evidence_versions_confirmation_text_chk",
      sql`length(btrim(${table.confirmationText})) > 0`,
    ),
  ],
);

export type PpePublicEvidenceVersion =
  typeof ppePublicEvidenceVersionsTable.$inferSelect;
