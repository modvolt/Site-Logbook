import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import {
  jobDocumentVersionsTable,
  quoteVersionsTable,
} from "./document-versions";
import { ppePublicEvidenceVersionsTable } from "./ppe-public-evidence";

export const PUBLIC_ACCESS_TOKEN_PURPOSES = [
  "job_signature",
  "ppe_signature",
  "ppe_confirmation",
  "quote_decision",
] as const;

export type PublicAccessTokenPurpose =
  (typeof PUBLIC_ACCESS_TOKEN_PURPOSES)[number];

export const PUBLIC_ACCESS_TOKEN_CONSUME_ACTIONS = [
  "signed",
  "confirmed",
  "accepted",
  "rejected",
] as const;

export type PublicAccessTokenConsumeAction =
  (typeof PUBLIC_ACCESS_TOKEN_CONSUME_ACTIONS)[number];

export const PUBLIC_ACCESS_TOKEN_OWNER_KINDS = ["organization", "user"] as const;
export type PublicAccessTokenOwnerKind =
  (typeof PUBLIC_ACCESS_TOKEN_OWNER_KINDS)[number];

export const PUBLIC_ACCESS_TOKEN_OWNER_ASSIGNMENT_SOURCES = [
  "resource_organization",
  "legacy_organization_assignment",
  "manual_user_assignment",
  "offboarding_transfer",
] as const;

/**
 * Hash-only lifecycle records for links that authorize an unauthenticated
 * visitor to read or transition one exact domain resource.
 *
 * `resourceType` is deliberately repeated and constrained by purpose. This
 * keeps audit queries explicit while avoiding unsafe polymorphic foreign keys.
 * Domain existence/state is always rechecked in the consuming transaction.
 */
export const publicAccessTokensTable = pgTable(
  "public_access_tokens",
  {
    id: serial("id").primaryKey(),
    purpose: text("purpose").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: integer("resource_id").notNull(),
    artifactBindingStatus: text("artifact_binding_status").notNull(),
    jobDocumentVersionId: integer("job_document_version_id").references(
      () => jobDocumentVersionsTable.id,
      { onDelete: "restrict" },
    ),
    quoteVersionId: integer("quote_version_id").references(
      () => quoteVersionsTable.id,
      { onDelete: "restrict" },
    ),
    ppeEvidenceVersionId: integer("ppe_evidence_version_id").references(
      () => ppePublicEvidenceVersionsTable.id,
      { onDelete: "restrict" },
    ),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    ownerKind: text("owner_kind"),
    ownerUserId: integer("owner_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    ownerAssignedAt: timestamp("owner_assigned_at"),
    ownerAssignmentSource: text("owner_assignment_source"),
    legacyImportedAt: timestamp("legacy_imported_at"),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: integer("revoked_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    revokeReason: text("revoke_reason"),
    consumedAt: timestamp("consumed_at"),
    consumeAction: text("consume_action"),
  },
  (table) => [
    uniqueIndex("public_access_tokens_purpose_hash_uq").on(
      table.purpose,
      table.tokenHash,
    ),
    index("public_access_tokens_resource_idx").on(
      table.purpose,
      table.resourceType,
      table.resourceId,
    ),
    index("public_access_tokens_expiry_idx").on(
      table.purpose,
      table.expiresAt,
    ),
    index("public_access_tokens_active_owner_idx")
      .on(table.ownerKind, table.ownerUserId, table.expiresAt)
      .where(
        sql`${table.revokedAt} is null and ${table.consumedAt} is null`,
      ),
    index("public_access_tokens_job_version_idx").on(
      table.jobDocumentVersionId,
    ),
    index("public_access_tokens_quote_version_idx").on(
      table.quoteVersionId,
    ),
    index("public_access_tokens_ppe_evidence_version_idx").on(
      table.ppeEvidenceVersionId,
    ),
    check(
      "public_access_tokens_purpose_resource_chk",
      sql`(
        (${table.purpose} = 'job_signature' and ${table.resourceType} = 'job') or
        (${table.purpose} in ('ppe_signature', 'ppe_confirmation') and ${table.resourceType} = 'ppe_assignment') or
        (${table.purpose} = 'quote_decision' and ${table.resourceType} = 'quote')
      )`,
    ),
    check(
      "public_access_tokens_hash_chk",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "public_access_tokens_artifact_binding_chk",
      sql`(
        ${table.purpose} in ('ppe_signature', 'ppe_confirmation') and (
          (${table.artifactBindingStatus} = 'bound' and ${table.ppeEvidenceVersionId} is not null and ${table.jobDocumentVersionId} is null and ${table.quoteVersionId} is null) or
          (${table.artifactBindingStatus} = 'not_applicable' and ${table.ppeEvidenceVersionId} is null and ${table.jobDocumentVersionId} is null and ${table.quoteVersionId} is null)
        )
      ) or (
        ${table.purpose} = 'job_signature' and (
          (${table.artifactBindingStatus} = 'bound' and ${table.jobDocumentVersionId} is not null and ${table.quoteVersionId} is null and ${table.ppeEvidenceVersionId} is null) or
          (${table.artifactBindingStatus} = 'legacy_unbound' and ${table.jobDocumentVersionId} is null and ${table.quoteVersionId} is null and ${table.ppeEvidenceVersionId} is null)
        )
      ) or (
        ${table.purpose} = 'quote_decision' and (
          (${table.artifactBindingStatus} = 'bound' and ${table.quoteVersionId} is not null and ${table.jobDocumentVersionId} is null and ${table.ppeEvidenceVersionId} is null) or
          (${table.artifactBindingStatus} = 'legacy_unbound' and ${table.quoteVersionId} is null and ${table.jobDocumentVersionId} is null and ${table.ppeEvidenceVersionId} is null)
        )
      )`,
    ),
    check(
      "public_access_tokens_prefix_chk",
      sql`${table.tokenPrefix} ~ '^[A-Za-z0-9_-]{8}$'`,
    ),
    check(
      "public_access_tokens_owner_assignment_chk",
      sql`(
        ${table.ownerKind} is null and
        ${table.ownerUserId} is null and
        ${table.ownerAssignedAt} is null and
        ${table.ownerAssignmentSource} is null
      ) or (
        ${table.ownerKind} = 'organization' and
        ${table.ownerUserId} is null and
        ${table.ownerAssignedAt} is not null and
        ${table.ownerAssignmentSource} in ('resource_organization', 'legacy_organization_assignment')
      ) or (
        ${table.ownerKind} = 'user' and
        ${table.ownerUserId} is not null and
        ${table.ownerAssignedAt} is not null and
        ${table.ownerAssignmentSource} in ('manual_user_assignment', 'offboarding_transfer')
      )`,
    ),
    check(
      "public_access_tokens_terminal_state_chk",
      sql`not (${table.revokedAt} is not null and ${table.consumedAt} is not null)`,
    ),
    check(
      "public_access_tokens_consume_action_chk",
      sql`(
        ${table.consumedAt} is null and ${table.consumeAction} is null
      ) or (
        ${table.consumedAt} is not null and (
          (${table.purpose} in ('job_signature', 'ppe_signature') and ${table.consumeAction} = 'signed') or
          (${table.purpose} = 'ppe_confirmation' and ${table.consumeAction} = 'confirmed') or
          (${table.purpose} = 'quote_decision' and ${table.consumeAction} in ('accepted', 'rejected'))
        )
      )`,
    ),
  ],
);

export type PublicAccessToken =
  typeof publicAccessTokensTable.$inferSelect;
