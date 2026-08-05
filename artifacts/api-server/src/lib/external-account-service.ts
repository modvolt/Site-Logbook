import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  externalAccountEventsTable,
  externalAccountsTable,
  externalAccountScopesTable,
  jobsTable,
  quotesTable,
  resolveAccountPermissions,
  switchboardsTable,
  userPermissionOverridesTable,
  userSessionsTable,
  usersTable,
  type ExternalAccountStatus,
  type ExternalResourceCapability,
  type ExternalResourceType,
  type PermissionEffect,
  type UserAccountType,
  type UserRole,
} from "@workspace/db";
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "./auth-session";
import { externalAccountsEnabled } from "./external-accounts-feature";
import { lockAndAuthorizeUserManager } from "./user-offboarding-service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_PAGE_SIZE = 100;

export type ExternalAccountLifecycleState = ExternalAccountStatus | "expired";

export type ExternalAccountScopeInput =
  | { resourceType: "job"; resourceId: number; capability: "read" }
  | { resourceType: "quote"; resourceId: number; capability: "read" }
  | { resourceType: "switchboard"; resourceId: number; capability: "read" };

export interface ExternalAccountSummary {
  userId: number;
  username: string;
  name: string;
  email: string | null;
  state: ExternalAccountLifecycleState;
  status: ExternalAccountStatus;
  custodianUserId: number;
  accessReviewedAt: Date;
  accessExpiresAt: Date;
  version: number;
  isActive: boolean;
  sessionGeneration: number;
  activeScopeCount: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  revokedByUserId: number | null;
  revocationReason: string | null;
}

export type ExternalAccountScopeView = ExternalAccountScopeInput & {
  id: number;
  startsAt: Date;
  expiresAt: Date;
};

export interface ExternalAccountDetail extends ExternalAccountSummary {
  scopes: ExternalAccountScopeView[];
}

export class ExternalAccountServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalAccountServiceError";
  }
}

interface LockedExternalAccount {
  userId: number;
  username: string;
  name: string;
  email: string | null;
  accountType: string;
  userIsActive: boolean;
  sessionGeneration: number;
  status: ExternalAccountStatus;
  custodianUserId: number;
  accessReviewedAt: Date;
  accessExpiresAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  revokedByUserId: number | null;
  revocationReason: string | null;
}

interface ScopeRow {
  id: number;
  jobId: number | null;
  quoteId: number | null;
  switchboardId: number | null;
  capability: string;
  startsAt: Date;
  expiresAt: Date;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_input",
      `${field} must be a positive integer.`,
    );
  }
}

function requireExpectedVersion(expectedVersion: number): void {
  requirePositiveInteger(expectedVersion, "expectedVersion");
}

function requireExpiryWindow(expiresAt: Date, now: Date): void {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_expiry",
      "External account expiry must be in the future.",
    );
  }
  const maximum = new Date(now);
  maximum.setUTCFullYear(maximum.getUTCFullYear() + 1);
  if (expiresAt > maximum) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_expiry",
      "External account expiry cannot exceed one year from access review.",
    );
  }
}

function stateOf(
  status: ExternalAccountStatus,
  accessExpiresAt: Date,
  now: Date,
): ExternalAccountLifecycleState {
  if (status === "active" && accessExpiresAt <= now) return "expired";
  return status;
}

function scopeKey(scope: ExternalAccountScopeInput): string {
  return `${scope.resourceType}:${scope.resourceId}:${scope.capability}`;
}

function validateScopes(
  scopes: readonly ExternalAccountScopeInput[],
): ExternalAccountScopeInput[] {
  const seen = new Set<string>();
  return scopes.map((scope) => {
    requirePositiveInteger(scope.resourceId, "resourceId");
    if (scope.capability !== "read") {
      throw new ExternalAccountServiceError(
        400,
        "invalid_external_account_scope",
        "External accounts support read-only scopes.",
      );
    }
    if (
      scope.resourceType !== "job" &&
      scope.resourceType !== "quote" &&
      scope.resourceType !== "switchboard"
    ) {
      throw new ExternalAccountServiceError(
        400,
        "invalid_external_account_scope",
        "Unsupported external account resource type.",
      );
    }
    const normalized = { ...scope } as ExternalAccountScopeInput;
    const key = scopeKey(normalized);
    if (seen.has(key)) {
      throw new ExternalAccountServiceError(
        400,
        "duplicate_external_account_scope",
        "External account scopes must be unique.",
      );
    }
    seen.add(key);
    return normalized;
  });
}

function scopeFromRow(row: ScopeRow): ExternalAccountScopeView {
  const resource = row.jobId
    ? ({ resourceType: "job", resourceId: row.jobId } as const)
    : row.quoteId
      ? ({ resourceType: "quote", resourceId: row.quoteId } as const)
      : row.switchboardId
        ? ({
            resourceType: "switchboard",
            resourceId: row.switchboardId,
          } as const)
        : null;
  if (!resource || row.capability !== "read") {
    throw new Error("Invalid external account scope row.");
  }
  return {
    id: row.id,
    ...resource,
    capability: "read",
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
  };
}

async function lockExternalAccount(
  tx: Transaction,
  externalUserId: number,
): Promise<LockedExternalAccount> {
  const result = await tx.execute(sql`
    select u.id as "userId",
           u.username,
           u.name,
           u.email,
           u.account_type as "accountType",
           u.is_active as "userIsActive",
           u.session_generation as "sessionGeneration",
           e.status,
           e.custodian_user_id as "custodianUserId",
           e.access_reviewed_at as "accessReviewedAt",
           e.access_expires_at as "accessExpiresAt",
           e.version,
           e.created_at as "createdAt",
           e.updated_at as "updatedAt",
           e.revoked_at as "revokedAt",
           e.revoked_by_user_id as "revokedByUserId",
           e.revocation_reason as "revocationReason"
      from external_accounts e
      join users u on u.id = e.user_id
     where e.user_id = ${externalUserId}
     for update of e, u
  `);
  const account = result.rows[0] as unknown as
    | LockedExternalAccount
    | undefined;
  if (!account) {
    throw new ExternalAccountServiceError(
      404,
      "external_account_not_found",
      "External account not found.",
    );
  }
  if (account.accountType !== "external") {
    throw new Error("External account row points to an internal user.");
  }
  return account;
}

function assertVersion(
  account: LockedExternalAccount,
  expectedVersion: number,
): void {
  if (account.version !== expectedVersion) {
    throw new ExternalAccountServiceError(
      409,
      "external_account_version_conflict",
      "External account changed since it was loaded.",
    );
  }
}

function assertMutable(account: LockedExternalAccount): void {
  if (account.status === "revoked") {
    throw new ExternalAccountServiceError(
      409,
      "external_account_revoked",
      "A revoked external account cannot be changed.",
    );
  }
}

async function lockValidCustodian(
  tx: Transaction,
  custodianUserId: number,
  externalUserId?: number,
): Promise<void> {
  requirePositiveInteger(custodianUserId, "custodianUserId");
  if (externalUserId === custodianUserId) {
    throw new ExternalAccountServiceError(
      409,
      "external_account_self_custody_forbidden",
      "An external account cannot be its own custodian.",
    );
  }
  const [custodian] = await tx
    .select({
      accountType: usersTable.accountType,
      role: usersTable.role,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(eq(usersTable.id, custodianUserId))
    .for("update");
  const overrideRows = custodian
    ? await tx
        .select({
          permission: userPermissionOverridesTable.permission,
          effect: userPermissionOverridesTable.effect,
        })
        .from(userPermissionOverridesTable)
        .where(eq(userPermissionOverridesTable.userId, custodianUserId))
    : [];
  const overrides = overrideRows.flatMap((row) =>
    row.effect === "allow" || row.effect === "deny"
      ? [{ permission: row.permission, effect: row.effect as PermissionEffect }]
      : [],
  );
  if (
    !custodian?.isActive ||
    custodian.accountType !== "internal" ||
    !resolveAccountPermissions(
      custodian.accountType as UserAccountType,
      custodian.role as UserRole,
      overrides,
    ).includes("users.manage")
  ) {
    throw new ExternalAccountServiceError(
      409,
      "invalid_external_account_custodian",
      "Custodian must be an active internal user.",
    );
  }
}

async function lockSessionIssuance(
  tx: Transaction,
  externalUserId: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SESSION_ISSUANCE_LOCK_NAMESPACE}, ${externalUserId})`,
  );
}

async function invalidateExternalSessions(
  tx: Transaction,
  externalUserId: number,
  isActive?: boolean,
): Promise<number> {
  const updates: {
    sessionGeneration: SQL;
    isActive?: boolean;
  } = {
    sessionGeneration: sql`${usersTable.sessionGeneration} + 1`,
  };
  if (isActive !== undefined) updates.isActive = isActive;
  const [updated] = await tx
    .update(usersTable)
    .set(updates)
    .where(
      and(
        eq(usersTable.id, externalUserId),
        eq(usersTable.accountType, "external"),
      ),
    )
    .returning({ sessionGeneration: usersTable.sessionGeneration });
  if (!updated) throw new Error("External user row was not updated.");
  await tx
    .delete(userSessionsTable)
    .where(
      sql`${userSessionsTable.userId} = ${externalUserId} or ${userSessionsTable.sess}->>'userId' = ${String(externalUserId)}`,
    );
  return updated.sessionGeneration;
}

async function loadActiveScopes(
  tx: Transaction,
  externalUserId: number,
): Promise<ExternalAccountScopeView[]> {
  const rows = await tx
    .select({
      id: externalAccountScopesTable.id,
      jobId: externalAccountScopesTable.jobId,
      quoteId: externalAccountScopesTable.quoteId,
      switchboardId: externalAccountScopesTable.switchboardId,
      capability: externalAccountScopesTable.capability,
      startsAt: externalAccountScopesTable.startsAt,
      expiresAt: externalAccountScopesTable.expiresAt,
    })
    .from(externalAccountScopesTable)
    .where(
      and(
        eq(externalAccountScopesTable.externalUserId, externalUserId),
        isNull(externalAccountScopesTable.revokedAt),
      ),
    )
    .orderBy(externalAccountScopesTable.id);
  return rows.map((row) => scopeFromRow(row));
}

async function assertResourcesExist(
  tx: Transaction,
  scopes: readonly ExternalAccountScopeInput[],
): Promise<void> {
  const byType: Record<ExternalResourceType, number[]> = {
    job: [],
    quote: [],
    switchboard: [],
  };
  for (const scope of scopes) byType[scope.resourceType].push(scope.resourceId);

  const [jobs, quotes, switchboards] = await Promise.all([
    byType.job.length
      ? tx
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(inArray(jobsTable.id, byType.job))
      : Promise.resolve([]),
    byType.quote.length
      ? tx
          .select({ id: quotesTable.id })
          .from(quotesTable)
          .where(inArray(quotesTable.id, byType.quote))
      : Promise.resolve([]),
    byType.switchboard.length
      ? tx
          .select({ id: switchboardsTable.id })
          .from(switchboardsTable)
          .where(inArray(switchboardsTable.id, byType.switchboard))
      : Promise.resolve([]),
  ]);
  if (
    jobs.length !== byType.job.length ||
    quotes.length !== byType.quote.length ||
    switchboards.length !== byType.switchboard.length
  ) {
    throw new ExternalAccountServiceError(
      404,
      "external_account_scope_resource_not_found",
      "One or more scoped resources do not exist.",
    );
  }
}

function scopeInsertValues(
  externalUserId: number,
  actorUserId: number,
  expiresAt: Date,
  scope: ExternalAccountScopeInput,
) {
  return {
    externalUserId,
    jobId: scope.resourceType === "job" ? scope.resourceId : null,
    quoteId: scope.resourceType === "quote" ? scope.resourceId : null,
    switchboardId:
      scope.resourceType === "switchboard" ? scope.resourceId : null,
    capability: scope.capability satisfies ExternalResourceCapability,
    startsAt: new Date(),
    expiresAt,
    createdByUserId: actorUserId,
  };
}

function summaryFromLocked(
  account: LockedExternalAccount,
  activeScopeCount: number,
  now: Date,
): ExternalAccountSummary {
  return {
    userId: account.userId,
    username: account.username,
    name: account.name,
    email: account.email,
    state: stateOf(account.status, account.accessExpiresAt, now),
    status: account.status,
    custodianUserId: account.custodianUserId,
    accessReviewedAt: account.accessReviewedAt,
    accessExpiresAt: account.accessExpiresAt,
    version: account.version,
    isActive: account.userIsActive,
    sessionGeneration: account.sessionGeneration,
    activeScopeCount,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    revokedAt: account.revokedAt,
    revokedByUserId: account.revokedByUserId,
    revocationReason: account.revocationReason,
  };
}

export async function listExternalAccounts(input: {
  actorUserId: number;
  status?: ExternalAccountLifecycleState | "all";
  custodianUserId?: number;
  beforeId?: number;
  limit?: number;
}): Promise<{
  runtimeEnabled: boolean;
  items: ExternalAccountSummary[];
  nextBeforeId: number | null;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  if (input.custodianUserId !== undefined) {
    requirePositiveInteger(input.custodianUserId, "custodianUserId");
  }
  if (input.beforeId !== undefined)
    requirePositiveInteger(input.beforeId, "beforeId");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_page",
      "External account page size must be between 1 and 100.",
    );
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    const conditions: SQL[] = [];
    if (input.custodianUserId !== undefined) {
      conditions.push(
        eq(externalAccountsTable.custodianUserId, input.custodianUserId),
      );
    }
    if (input.beforeId !== undefined) {
      conditions.push(lt(externalAccountsTable.userId, input.beforeId));
    }
    if (input.status === "expired") {
      conditions.push(ne(externalAccountsTable.status, "revoked"));
      conditions.push(lte(externalAccountsTable.accessExpiresAt, now));
    } else if (input.status && input.status !== "all") {
      conditions.push(eq(externalAccountsTable.status, input.status));
      if (input.status === "active") {
        conditions.push(gt(externalAccountsTable.accessExpiresAt, now));
      }
    }

    const rows = await tx
      .select({
        userId: externalAccountsTable.userId,
        username: usersTable.username,
        name: usersTable.name,
        email: usersTable.email,
        status: externalAccountsTable.status,
        custodianUserId: externalAccountsTable.custodianUserId,
        accessReviewedAt: externalAccountsTable.accessReviewedAt,
        accessExpiresAt: externalAccountsTable.accessExpiresAt,
        version: externalAccountsTable.version,
        isActive: usersTable.isActive,
        sessionGeneration: usersTable.sessionGeneration,
        createdAt: externalAccountsTable.createdAt,
        updatedAt: externalAccountsTable.updatedAt,
        revokedAt: externalAccountsTable.revokedAt,
        revokedByUserId: externalAccountsTable.revokedByUserId,
        revocationReason: externalAccountsTable.revocationReason,
      })
      .from(externalAccountsTable)
      .innerJoin(usersTable, eq(usersTable.id, externalAccountsTable.userId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(externalAccountsTable.userId))
      .limit(limit);

    const scopeCounts = rows.length
      ? await tx
          .select({
            externalUserId: externalAccountScopesTable.externalUserId,
            value: count(),
          })
          .from(externalAccountScopesTable)
          .where(
            and(
              inArray(
                externalAccountScopesTable.externalUserId,
                rows.map((row) => row.userId),
              ),
              isNull(externalAccountScopesTable.revokedAt),
            ),
          )
          .groupBy(externalAccountScopesTable.externalUserId)
      : [];
    const counts = new Map(
      scopeCounts.map((row) => [row.externalUserId, Number(row.value)]),
    );
    const items: ExternalAccountSummary[] = rows.map((row) => ({
      ...row,
      status: row.status as ExternalAccountStatus,
      state: stateOf(
        row.status as ExternalAccountStatus,
        row.accessExpiresAt,
        now,
      ),
      activeScopeCount: counts.get(row.userId) ?? 0,
    }));
    return {
      runtimeEnabled: externalAccountsEnabled(),
      items,
      nextBeforeId: rows.length === limit ? rows.at(-1)!.userId : null,
    };
  });
}

export async function getExternalAccountDetail(input: {
  actorUserId: number;
  externalUserId: number;
}): Promise<ExternalAccountDetail> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    const scopes = await loadActiveScopes(tx, account.userId);
    return {
      ...summaryFromLocked(account, scopes.length, new Date()),
      scopes,
    };
  });
}

export async function createExternalAccountDraft(input: {
  actorUserId: number;
  username: string;
  passwordHash: string;
  name: string;
  email?: string | null;
  custodianUserId: number;
  accessExpiresAt: Date;
}): Promise<ExternalAccountDetail> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.custodianUserId, "custodianUserId");
  const username = input.username.trim();
  const name = input.name.trim();
  const email = input.email?.trim() || null;
  if (!username || !name || !input.passwordHash) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_identity",
      "Username, name and a password hash are required.",
    );
  }
  const now = new Date();
  requireExpiryWindow(input.accessExpiresAt, now);

  try {
    return await db.transaction(async (tx) => {
      await lockAndAuthorizeUserManager(tx, input.actorUserId);
      await lockValidCustodian(tx, input.custodianUserId);
      const [user] = await tx
        .insert(usersTable)
        .values({
          username,
          passwordHash: input.passwordHash,
          name,
          email,
          role: "guest",
          accountType: "external",
          personId: null,
          isActive: false,
          sessionGeneration: 1,
        })
        .returning({ id: usersTable.id });
      if (!user) throw new Error("External user row was not created.");

      await lockSessionIssuance(tx, user.id);
      await tx.insert(externalAccountsTable).values({
        userId: user.id,
        status: "draft",
        custodianUserId: input.custodianUserId,
        accessReviewedAt: now,
        accessExpiresAt: input.accessExpiresAt,
        version: 1,
        createdByUserId: input.actorUserId,
        createdAt: now,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      });
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: user.id,
        actorUserId: input.actorUserId,
        eventType: "account_created",
        details: {
          status: "draft",
          custodianUserId: input.custodianUserId,
          accessExpiresAt: input.accessExpiresAt.toISOString(),
        },
      });
      const account = await lockExternalAccount(tx, user.id);
      return {
        ...summaryFromLocked(account, 0, now),
        scopes: [],
      };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new ExternalAccountServiceError(
        409,
        "external_account_username_exists",
        "Username is already in use.",
      );
    }
    throw error;
  }
}

export async function activateExternalAccount(input: {
  actorUserId: number;
  externalUserId: number;
  expectedVersion: number;
}): Promise<{
  userId: number;
  status: "active";
  version: number;
  sessionGeneration: number;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  requireExpectedVersion(input.expectedVersion);
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await lockSessionIssuance(tx, input.externalUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    assertVersion(account, input.expectedVersion);
    if (!externalAccountsEnabled()) {
      throw new ExternalAccountServiceError(
        409,
        "external_accounts_disabled",
        "External account authentication is globally disabled.",
      );
    }
    if (account.status !== "draft") {
      throw new ExternalAccountServiceError(
        409,
        "external_account_activation_invalid_state",
        "Only a draft external account can be activated.",
      );
    }
    const now = new Date();
    if (account.accessExpiresAt <= now) {
      throw new ExternalAccountServiceError(
        409,
        "external_account_expired",
        "External account access has expired.",
      );
    }
    await lockValidCustodian(tx, account.custodianUserId, account.userId);
    const [scopeCount] = await tx
      .select({ value: count() })
      .from(externalAccountScopesTable)
      .where(
        and(
          eq(externalAccountScopesTable.externalUserId, account.userId),
          isNull(externalAccountScopesTable.revokedAt),
          lte(externalAccountScopesTable.startsAt, now),
          gt(externalAccountScopesTable.expiresAt, now),
        ),
      );
    if (!scopeCount || Number(scopeCount.value) < 1) {
      throw new ExternalAccountServiceError(
        409,
        "external_account_scope_required",
        "External account activation requires at least one active scope.",
      );
    }
    const [updated] = await tx
      .update(externalAccountsTable)
      .set({
        status: "active",
        version: sql`${externalAccountsTable.version} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalAccountsTable.userId, account.userId),
          eq(externalAccountsTable.version, input.expectedVersion),
        ),
      )
      .returning({ version: externalAccountsTable.version });
    if (!updated) throw new Error("Locked external account activation failed.");
    const sessionGeneration = await invalidateExternalSessions(
      tx,
      account.userId,
      true,
    );
    await tx.insert(externalAccountEventsTable).values({
      externalUserId: account.userId,
      actorUserId: input.actorUserId,
      eventType: "account_activated",
      details: {
        previousVersion: account.version,
        version: updated.version,
        sessionGeneration,
      },
    });
    return {
      userId: account.userId,
      status: "active",
      version: updated.version,
      sessionGeneration,
    };
  });
}

export async function updateExternalAccountExpiry(input: {
  actorUserId: number;
  externalUserId: number;
  expectedVersion: number;
  accessExpiresAt: Date;
}): Promise<{
  userId: number;
  accessExpiresAt: Date;
  version: number;
  sessionGeneration: number;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  requireExpectedVersion(input.expectedVersion);
  const now = new Date();
  requireExpiryWindow(input.accessExpiresAt, now);
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await lockSessionIssuance(tx, input.externalUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    assertVersion(account, input.expectedVersion);
    assertMutable(account);
    const currentScopes = await loadActiveScopes(tx, account.userId);

    const [updated] = await tx
      .update(externalAccountsTable)
      .set({
        accessReviewedAt: now,
        accessExpiresAt: input.accessExpiresAt,
        version: sql`${externalAccountsTable.version} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalAccountsTable.userId, account.userId),
          eq(externalAccountsTable.version, input.expectedVersion),
        ),
      )
      .returning({ version: externalAccountsTable.version });
    if (!updated)
      throw new Error("Locked external account expiry update failed.");
    for (const scope of currentScopes) {
      await tx
        .update(externalAccountScopesTable)
        .set({
          revokedAt: now,
          revokedByUserId: input.actorUserId,
          revocationReason: "account_expiry_changed",
        })
        .where(
          and(
            eq(externalAccountScopesTable.id, scope.id),
            isNull(externalAccountScopesTable.revokedAt),
          ),
        );
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: account.userId,
        scopeId: scope.id,
        actorUserId: input.actorUserId,
        eventType: "scope_revoked",
        details: {
          resourceType: scope.resourceType,
          resourceId: scope.resourceId,
          capability: scope.capability,
          reason: "account_expiry_changed",
        },
      });
      const [replacement] = await tx
        .insert(externalAccountScopesTable)
        .values(
          scopeInsertValues(
            account.userId,
            input.actorUserId,
            input.accessExpiresAt,
            scope,
          ),
        )
        .returning({ id: externalAccountScopesTable.id });
      if (!replacement)
        throw new Error("External account scope replacement failed.");
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: account.userId,
        scopeId: replacement.id,
        actorUserId: input.actorUserId,
        eventType: "scope_granted",
        details: {
          resourceType: scope.resourceType,
          resourceId: scope.resourceId,
          capability: scope.capability,
          expiresAt: input.accessExpiresAt.toISOString(),
          reason: "account_expiry_changed",
        },
      });
    }
    const sessionGeneration = await invalidateExternalSessions(
      tx,
      account.userId,
    );
    await tx.insert(externalAccountEventsTable).values({
      externalUserId: account.userId,
      actorUserId: input.actorUserId,
      eventType: "account_access_reviewed",
      details: {
        previousAccessExpiresAt: account.accessExpiresAt.toISOString(),
        accessExpiresAt: input.accessExpiresAt.toISOString(),
        previousVersion: account.version,
        version: updated.version,
        sessionGeneration,
      },
    });
    return {
      userId: account.userId,
      accessExpiresAt: input.accessExpiresAt,
      version: updated.version,
      sessionGeneration,
    };
  });
}

export async function replaceExternalAccountScopes(input: {
  actorUserId: number;
  externalUserId: number;
  expectedVersion: number;
  scopes: readonly ExternalAccountScopeInput[];
}): Promise<{
  userId: number;
  scopes: ExternalAccountScopeView[];
  version: number;
  sessionGeneration: number;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  requireExpectedVersion(input.expectedVersion);
  const requested = validateScopes(input.scopes);
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await lockSessionIssuance(tx, input.externalUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    assertVersion(account, input.expectedVersion);
    assertMutable(account);
    const now = new Date();
    if (account.accessExpiresAt <= now) {
      throw new ExternalAccountServiceError(
        409,
        "external_account_expired",
        "Review and extend account access before assigning scopes.",
      );
    }
    await assertResourcesExist(tx, requested);
    const current = await loadActiveScopes(tx, account.userId);
    const currentKeys = new Set(current.map(scopeKey));
    const requestedKeys = new Set(requested.map(scopeKey));
    const revoked = current.filter(
      (scope) => !requestedKeys.has(scopeKey(scope)),
    );
    const granted = requested.filter(
      (scope) => !currentKeys.has(scopeKey(scope)),
    );
    if (revoked.length === 0 && granted.length === 0) {
      return {
        userId: account.userId,
        scopes: current,
        version: account.version,
        sessionGeneration: account.sessionGeneration,
      };
    }

    for (const scope of revoked) {
      await tx
        .update(externalAccountScopesTable)
        .set({
          revokedAt: now,
          revokedByUserId: input.actorUserId,
          revocationReason: "scope_replaced",
        })
        .where(
          and(
            eq(externalAccountScopesTable.id, scope.id),
            isNull(externalAccountScopesTable.revokedAt),
          ),
        );
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: account.userId,
        scopeId: scope.id,
        actorUserId: input.actorUserId,
        eventType: "scope_revoked",
        details: {
          resourceType: scope.resourceType,
          resourceId: scope.resourceId,
          capability: scope.capability,
          reason: "scope_replaced",
        },
      });
    }
    for (const scope of granted) {
      const [inserted] = await tx
        .insert(externalAccountScopesTable)
        .values(
          scopeInsertValues(
            account.userId,
            input.actorUserId,
            account.accessExpiresAt,
            scope,
          ),
        )
        .returning({ id: externalAccountScopesTable.id });
      if (!inserted)
        throw new Error("External account scope was not inserted.");
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: account.userId,
        scopeId: inserted.id,
        actorUserId: input.actorUserId,
        eventType: "scope_granted",
        details: {
          resourceType: scope.resourceType,
          resourceId: scope.resourceId,
          capability: scope.capability,
          expiresAt: account.accessExpiresAt.toISOString(),
        },
      });
    }
    const [updated] = await tx
      .update(externalAccountsTable)
      .set({
        version: sql`${externalAccountsTable.version} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalAccountsTable.userId, account.userId),
          eq(externalAccountsTable.version, input.expectedVersion),
        ),
      )
      .returning({ version: externalAccountsTable.version });
    if (!updated)
      throw new Error("Locked external account scope update failed.");
    const sessionGeneration = await invalidateExternalSessions(
      tx,
      account.userId,
    );
    return {
      userId: account.userId,
      scopes: await loadActiveScopes(tx, account.userId),
      version: updated.version,
      sessionGeneration,
    };
  });
}

export async function transferExternalAccountCustodian(input: {
  actorUserId: number;
  externalUserId: number;
  expectedVersion: number;
  custodianUserId: number;
}): Promise<{
  userId: number;
  custodianUserId: number;
  version: number;
  sessionGeneration: number;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  requirePositiveInteger(input.custodianUserId, "custodianUserId");
  requireExpectedVersion(input.expectedVersion);
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await lockSessionIssuance(tx, input.externalUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    assertVersion(account, input.expectedVersion);
    assertMutable(account);
    await lockValidCustodian(tx, input.custodianUserId, account.userId);
    if (account.custodianUserId === input.custodianUserId) {
      return {
        userId: account.userId,
        custodianUserId: account.custodianUserId,
        version: account.version,
        sessionGeneration: account.sessionGeneration,
      };
    }
    const now = new Date();
    const [updated] = await tx
      .update(externalAccountsTable)
      .set({
        custodianUserId: input.custodianUserId,
        version: sql`${externalAccountsTable.version} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalAccountsTable.userId, account.userId),
          eq(externalAccountsTable.version, input.expectedVersion),
        ),
      )
      .returning({ version: externalAccountsTable.version });
    if (!updated) throw new Error("Locked external account transfer failed.");
    const sessionGeneration = await invalidateExternalSessions(
      tx,
      account.userId,
    );
    await tx.insert(externalAccountEventsTable).values({
      externalUserId: account.userId,
      actorUserId: input.actorUserId,
      eventType: "custodian_transferred",
      details: {
        previousCustodianUserId: account.custodianUserId,
        custodianUserId: input.custodianUserId,
        previousVersion: account.version,
        version: updated.version,
        sessionGeneration,
      },
    });
    return {
      userId: account.userId,
      custodianUserId: input.custodianUserId,
      version: updated.version,
      sessionGeneration,
    };
  });
}

export async function revokeExternalAccount(input: {
  actorUserId: number;
  externalUserId: number;
  expectedVersion: number;
  reason: string;
}): Promise<{
  userId: number;
  status: "revoked";
  version: number;
  sessionGeneration: number;
  revokedAt: Date;
}> {
  requirePositiveInteger(input.actorUserId, "actorUserId");
  requirePositiveInteger(input.externalUserId, "externalUserId");
  requireExpectedVersion(input.expectedVersion);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) {
    throw new ExternalAccountServiceError(
      400,
      "invalid_external_account_revocation_reason",
      "Revocation reason must contain between 3 and 300 characters.",
    );
  }
  return db.transaction(async (tx) => {
    await lockAndAuthorizeUserManager(tx, input.actorUserId);
    await lockSessionIssuance(tx, input.externalUserId);
    const account = await lockExternalAccount(tx, input.externalUserId);
    assertVersion(account, input.expectedVersion);
    assertMutable(account);
    const now = new Date();
    const revokedScopes = await tx
      .update(externalAccountScopesTable)
      .set({
        revokedAt: now,
        revokedByUserId: input.actorUserId,
        revocationReason: reason,
      })
      .where(
        and(
          eq(externalAccountScopesTable.externalUserId, account.userId),
          isNull(externalAccountScopesTable.revokedAt),
        ),
      )
      .returning({
        id: externalAccountScopesTable.id,
        jobId: externalAccountScopesTable.jobId,
        quoteId: externalAccountScopesTable.quoteId,
        switchboardId: externalAccountScopesTable.switchboardId,
        capability: externalAccountScopesTable.capability,
        startsAt: externalAccountScopesTable.startsAt,
        expiresAt: externalAccountScopesTable.expiresAt,
      });
    for (const row of revokedScopes) {
      const scope = scopeFromRow(row);
      await tx.insert(externalAccountEventsTable).values({
        externalUserId: account.userId,
        scopeId: scope.id,
        actorUserId: input.actorUserId,
        eventType: "scope_revoked",
        details: {
          resourceType: scope.resourceType,
          resourceId: scope.resourceId,
          capability: scope.capability,
          reason,
        },
      });
    }
    const [updated] = await tx
      .update(externalAccountsTable)
      .set({
        status: "revoked",
        version: sql`${externalAccountsTable.version} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
        revokedAt: now,
        revokedByUserId: input.actorUserId,
        revocationReason: reason,
      })
      .where(
        and(
          eq(externalAccountsTable.userId, account.userId),
          eq(externalAccountsTable.version, input.expectedVersion),
        ),
      )
      .returning({ version: externalAccountsTable.version });
    if (!updated) throw new Error("Locked external account revocation failed.");
    const sessionGeneration = await invalidateExternalSessions(
      tx,
      account.userId,
      false,
    );
    await tx.insert(externalAccountEventsTable).values({
      externalUserId: account.userId,
      actorUserId: input.actorUserId,
      eventType: "account_revoked",
      details: {
        reason,
        revokedScopeCount: revokedScopes.length,
        previousVersion: account.version,
        version: updated.version,
        sessionGeneration,
      },
    });
    return {
      userId: account.userId,
      status: "revoked",
      version: updated.version,
      sessionGeneration,
      revokedAt: now,
    };
  });
}
