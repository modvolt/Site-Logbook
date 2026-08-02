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
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
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
      "public_access_tokens_prefix_chk",
      sql`${table.tokenPrefix} ~ '^[A-Za-z0-9_-]{8}$'`,
    ),
    check(
      "public_access_tokens_terminal_state_chk",
      sql`not (${table.revokedAt} is not null and ${table.consumedAt} is not null)`,
    ),
    check(
      "public_access_tokens_consume_action_chk",
      sql`(${table.consumedAt} is null and ${table.consumeAction} is null) or (${table.consumedAt} is not null and ${table.consumeAction} in ('signed', 'confirmed', 'accepted', 'rejected'))`,
    ),
  ],
);

export type PublicAccessToken =
  typeof publicAccessTokensTable.$inferSelect;
