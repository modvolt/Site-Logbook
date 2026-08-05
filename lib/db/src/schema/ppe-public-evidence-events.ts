import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { ppeAssignmentsTable } from "./ppe";
import { ppePublicEvidenceVersionsTable } from "./ppe-public-evidence";
import { publicAccessTokensTable } from "./public-access-tokens";

export const PPE_PUBLIC_EVIDENCE_ACTIONS = ["signed", "confirmed"] as const;
export type PpePublicEvidenceAction =
  (typeof PPE_PUBLIC_EVIDENCE_ACTIONS)[number];

/**
 * Append-only proof that a public capability completed the action against the
 * exact snapshot it displayed. Migrations must attach both the cross-resource
 * INSERT binding guard and the shared immutable evidence trigger.
 */
export const ppePublicEvidenceEventsTable = pgTable(
  "ppe_public_evidence_events",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => ppeAssignmentsTable.id, { onDelete: "restrict" }),
    evidenceVersionId: integer("evidence_version_id")
      .notNull()
      .references(() => ppePublicEvidenceVersionsTable.id, {
        onDelete: "restrict",
      }),
    publicAccessTokenId: integer("public_access_token_id")
      .notNull()
      .references(() => publicAccessTokensTable.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    confirmationText: text("confirmation_text").notNull(),
    signatureObjectPath: text("signature_object_path"),
    signatureSha256: text("signature_sha256"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("ppe_public_evidence_events_token_uq").on(
      table.publicAccessTokenId,
    ),
    index("ppe_public_evidence_events_assignment_idx").on(
      table.assignmentId,
      table.createdAt,
    ),
    index("ppe_public_evidence_events_version_idx").on(
      table.evidenceVersionId,
    ),
    check(
      "ppe_public_evidence_events_action_chk",
      sql`${table.action} in ('signed', 'confirmed')`,
    ),
    check(
      "ppe_public_evidence_events_snapshot_hash_chk",
      sql`${table.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ppe_public_evidence_events_signature_chk",
      sql`(
        ${table.action} = 'signed' and
        ${table.signatureObjectPath} is not null and
        ${table.signatureSha256} ~ '^[0-9a-f]{64}$'
      ) or (
        ${table.action} = 'confirmed' and
        ${table.signatureObjectPath} is null and
        ${table.signatureSha256} is null
      )`,
    ),
    check(
      "ppe_public_evidence_events_confirmation_text_chk",
      sql`length(btrim(${table.confirmationText})) > 0`,
    ),
  ],
);

export type PpePublicEvidenceEvent =
  typeof ppePublicEvidenceEventsTable.$inferSelect;
