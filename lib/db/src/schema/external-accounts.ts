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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { quotesTable } from "./quotes";
import { switchboardsTable } from "./switchboards";
import { usersTable } from "./users";

export const EXTERNAL_ACCOUNT_STATUSES = [
  "draft",
  "active",
  "suspended",
  "revoked",
] as const;
export type ExternalAccountStatus =
  (typeof EXTERNAL_ACCOUNT_STATUSES)[number];

export const EXTERNAL_RESOURCE_TYPES = ["job", "quote", "switchboard"] as const;
export type ExternalResourceType = (typeof EXTERNAL_RESOURCE_TYPES)[number];

export const EXTERNAL_RESOURCE_CAPABILITIES = ["read"] as const;
export type ExternalResourceCapability =
  (typeof EXTERNAL_RESOURCE_CAPABILITIES)[number];

export const EXTERNAL_ACCOUNT_EVENT_TYPES = [
  "account_created",
  "account_activated",
  "account_suspended",
  "account_access_reviewed",
  "account_revoked",
  "custodian_transferred",
  "scope_granted",
  "scope_revoked",
] as const;

export const externalAccountsTable = pgTable(
  "external_accounts",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    custodianUserId: integer("custodian_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    accessReviewedAt: timestamp("access_reviewed_at").notNull().defaultNow(),
    accessExpiresAt: timestamp("access_expires_at").notNull(),
    version: integer("version").notNull().default(1),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedByUserId: integer("updated_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: integer("revoked_by_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    revocationReason: text("revocation_reason"),
  },
  (table) => [
    index("external_accounts_custodian_idx").on(
      table.custodianUserId,
      table.status,
    ),
    index("external_accounts_expiry_idx").on(table.status, table.accessExpiresAt),
    check(
      "external_accounts_status_chk",
      sql`${table.status} in ('draft', 'active', 'suspended', 'revoked')`,
    ),
    check("external_accounts_version_chk", sql`${table.version} > 0`),
    check(
      "external_accounts_custodian_chk",
      sql`${table.custodianUserId} <> ${table.userId}`,
    ),
    check(
      "external_accounts_review_window_chk",
      sql`${table.accessExpiresAt} > ${table.accessReviewedAt} and ${table.accessExpiresAt} <= ${table.accessReviewedAt} + interval '1 year'`,
    ),
    check(
      "external_accounts_revocation_chk",
      sql`(
        ${table.status} = 'revoked' and
        ${table.revokedAt} is not null and
        ${table.revokedByUserId} is not null and
        ${table.revocationReason} is not null and
        length(btrim(${table.revocationReason})) >= 3
      ) or (
        ${table.status} <> 'revoked' and
        ${table.revokedAt} is null and
        ${table.revokedByUserId} is null and
        ${table.revocationReason} is null
      )`,
    ),
  ],
);

export const externalAccountScopesTable = pgTable(
  "external_account_scopes",
  {
    id: serial("id").primaryKey(),
    externalUserId: integer("external_user_id")
      .notNull()
      .references(() => externalAccountsTable.userId, { onDelete: "restrict" }),
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "restrict" }),
    quoteId: integer("quote_id").references(() => quotesTable.id, { onDelete: "restrict" }),
    switchboardId: integer("switchboard_id").references(
      () => switchboardsTable.id,
      { onDelete: "restrict" },
    ),
    capability: text("capability").notNull().default("read"),
    startsAt: timestamp("starts_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: integer("revoked_by_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    revocationReason: text("revocation_reason"),
  },
  (table) => [
    index("external_account_scopes_lookup_idx").on(
      table.externalUserId,
      table.startsAt,
      table.expiresAt,
    ),
    uniqueIndex("external_account_scopes_active_job_uq")
      .on(table.externalUserId, table.jobId, table.capability)
      .where(sql`${table.revokedAt} is null and ${table.jobId} is not null`),
    uniqueIndex("external_account_scopes_active_quote_uq")
      .on(table.externalUserId, table.quoteId, table.capability)
      .where(sql`${table.revokedAt} is null and ${table.quoteId} is not null`),
    uniqueIndex("external_account_scopes_active_switchboard_uq")
      .on(table.externalUserId, table.switchboardId, table.capability)
      .where(sql`${table.revokedAt} is null and ${table.switchboardId} is not null`),
    check(
      "external_account_scopes_resource_chk",
      sql`num_nonnulls(${table.jobId}, ${table.quoteId}, ${table.switchboardId}) = 1`,
    ),
    check(
      "external_account_scopes_capability_chk",
      sql`${table.capability} = 'read'`,
    ),
    check(
      "external_account_scopes_expiry_chk",
      sql`${table.expiresAt} > ${table.startsAt}`,
    ),
    check(
      "external_account_scopes_revocation_chk",
      sql`(
        ${table.revokedAt} is null and
        ${table.revokedByUserId} is null and
        ${table.revocationReason} is null
      ) or (
        ${table.revokedAt} is not null and
        ${table.revokedByUserId} is not null and
        ${table.revocationReason} is not null and
        length(btrim(${table.revocationReason})) >= 3
      )`,
    ),
  ],
);

export const externalAccountEventsTable = pgTable(
  "external_account_events",
  {
    id: serial("id").primaryKey(),
    externalUserId: integer("external_user_id")
      .notNull()
      .references(() => externalAccountsTable.userId, { onDelete: "restrict" }),
    scopeId: integer("scope_id").references(() => externalAccountScopesTable.id, {
      onDelete: "set null",
    }),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("external_account_events_user_idx").on(
      table.externalUserId,
      table.createdAt,
    ),
    check(
      "external_account_events_type_chk",
      sql`${table.eventType} in (
        'account_created',
        'account_activated',
        'account_suspended',
        'account_access_reviewed',
        'account_revoked',
        'custodian_transferred',
        'scope_granted',
        'scope_revoked'
      )`,
    ),
  ],
);

export type ExternalAccount = typeof externalAccountsTable.$inferSelect;
export type ExternalAccountScope = typeof externalAccountScopesTable.$inferSelect;
export type ExternalAccountEvent = typeof externalAccountEventsTable.$inferSelect;
