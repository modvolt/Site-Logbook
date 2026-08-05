import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  ppeAssignmentsTable,
  publicAccessTokensTable,
  quotesTable,
  resolvePermissions,
  userPermissionOverridesTable,
  usersTable,
  type Permission,
  type PermissionEffect,
  type PublicAccessToken,
  type PublicAccessTokenConsumeAction,
  type PublicAccessTokenPurpose,
  type UserRole,
} from "@workspace/db";
import { isPlausiblePublicAccessToken } from "./public-access-token-format";

export { isPlausiblePublicAccessToken } from "./public-access-token-format";
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "./auth-session";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | DbTransaction;

const RESOURCE_TYPE: Record<PublicAccessTokenPurpose, string> = {
  job_signature: "job",
  ppe_signature: "ppe_assignment",
  ppe_confirmation: "ppe_assignment",
  quote_decision: "quote",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LIFETIME_MS = 365 * DAY_MS;

const ISSUANCE_PERMISSION: Record<PublicAccessTokenPurpose, Permission> = {
  job_signature: "jobs.manage",
  ppe_signature: "people.manage",
  ppe_confirmation: "people.manage",
  quote_decision: "quotes.manage",
};

const CONFLICTING_PURPOSES: Record<
  PublicAccessTokenPurpose,
  readonly PublicAccessTokenPurpose[]
> = {
  job_signature: ["job_signature"],
  ppe_signature: ["ppe_signature", "ppe_confirmation"],
  ppe_confirmation: ["ppe_signature", "ppe_confirmation"],
  quote_decision: ["quote_decision"],
};

function conflictingPurposesFor(
  purpose: string,
): readonly PublicAccessTokenPurpose[] {
  if (
    purpose === "job_signature" ||
    purpose === "ppe_signature" ||
    purpose === "ppe_confirmation" ||
    purpose === "quote_decision"
  ) {
    return CONFLICTING_PURPOSES[purpose];
  }
  throw new Error(`Unsupported public access token purpose: ${purpose}`);
}

function grantFamilyLockKey(
  purpose: PublicAccessTokenPurpose,
  resourceId: number,
): string {
  const family = purpose === "ppe_signature" || purpose === "ppe_confirmation"
    ? "ppe_acknowledgement"
    : purpose;
  return `${family}:${resourceId}`;
}

export type PublicAccessTokenErrorCode =
  | "malformed"
  | "not_found"
  | "expired"
  | "revoked"
  | "consumed";

export class PublicAccessTokenError extends Error {
  readonly code: PublicAccessTokenErrorCode;

  constructor(code: PublicAccessTokenErrorCode) {
    super(`Public access token is ${code}.`);
    this.name = "PublicAccessTokenError";
    this.code = code;
  }
}

export class PublicAccessTokenIssuanceError extends Error {
  constructor(
    readonly code: "issuer_inactive" | "issuer_permission_revoked",
  ) {
    super(`Public access token issuance rejected: ${code}.`);
    this.name = "PublicAccessTokenIssuanceError";
  }
}

export function hashPublicAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function publicTokenExpiry(
  envName: string,
  defaultDays: number,
  now = new Date(),
): Date {
  if (!Number.isInteger(defaultDays) || defaultDays < 1 || defaultDays > 365) {
    throw new Error(`Invalid default public token expiry for ${envName}.`);
  }
  const raw = process.env[envName];
  const days = raw === undefined ? defaultDays : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(
      `Invalid ${envName}: expected an integer number of days from 1 to 365.`,
    );
  }
  return new Date(now.getTime() + days * DAY_MS);
}

function newRawToken(): string {
  return randomBytes(32).toString("base64url");
}

function assertTokenInput(token: string): void {
  if (!isPlausiblePublicAccessToken(token)) {
    throw new PublicAccessTokenError("malformed");
  }
}

function assertUsable(record: PublicAccessToken, now = new Date()): void {
  if (record.revokedAt) throw new PublicAccessTokenError("revoked");
  if (record.consumedAt) throw new PublicAccessTokenError("consumed");
  if (record.artifactBindingStatus !== "bound") {
    // A legacy token cannot prove which document the visitor originally saw.
    // Re-issue it against a new immutable version instead of inventing history.
    throw new PublicAccessTokenError("revoked");
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw new PublicAccessTokenError("expired");
  }
}

async function findRecord(
  client: DbClient,
  purpose: PublicAccessTokenPurpose,
  tokenHash: string,
): Promise<PublicAccessToken | null> {
  const [record] = await client
    .select()
    .from(publicAccessTokensTable)
    .where(
      and(
        eq(publicAccessTokensTable.purpose, purpose),
        eq(publicAccessTokensTable.tokenHash, tokenHash),
      ),
    )
    .limit(1);
  return record ?? null;
}

async function findRecordForUpdate(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  tokenHash: string,
): Promise<PublicAccessToken | null> {
  const [record] = await tx
    .select()
    .from(publicAccessTokensTable)
    .where(
      and(
        eq(publicAccessTokensTable.purpose, purpose),
        eq(publicAccessTokensTable.tokenHash, tokenHash),
      ),
    )
    .limit(1)
    .for("update");
  return record ?? null;
}

async function lockGrantResource(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  resourceId: number,
): Promise<boolean> {
  if (purpose === "job_signature") {
    const rows = await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, resourceId))
      .limit(1)
      .for("update");
    return rows.length === 1;
  }
  if (purpose === "ppe_signature" || purpose === "ppe_confirmation") {
    const rows = await tx
      .select({ id: ppeAssignmentsTable.id })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, resourceId))
      .limit(1)
      .for("update");
    return rows.length === 1;
  }
  const rows = await tx
    .select({ id: quotesTable.id })
    .from(quotesTable)
    .where(eq(quotesTable.id, resourceId))
    .limit(1)
    .for("update");
  return rows.length === 1;
}

async function lockGrantFamily(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  resourceId: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${grantFamilyLockKey(purpose, resourceId)}))`,
  );
}

type LegacyImport = Omit<
  typeof publicAccessTokensTable.$inferInsert,
  "id" | "tokenHash" | "tokenPrefix" | "legacyImportedAt"
>;

async function readLegacyToken(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  rawToken: string,
  now: Date,
): Promise<LegacyImport | null> {
  if (purpose === "job_signature") {
    const rows = await tx
      .select({
        id: jobsTable.id,
        expiresAt: jobsTable.signatureTokenExpiresAt,
        requestedAt: jobsTable.signatureRequestedAt,
        signedAt: jobsTable.signedAt,
      })
      .from(jobsTable)
      .where(eq(jobsTable.signatureToken, rawToken))
      .limit(2)
      .for("update");
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
      artifactBindingStatus: "legacy_unbound",
      jobDocumentVersionId: null,
      quoteVersionId: null,
      expiresAt:
        row.expiresAt ??
        (row.requestedAt
          ? new Date(row.requestedAt.getTime() + 7 * DAY_MS)
          : publicTokenExpiry("JOB_SIGNATURE_EXPIRY_DAYS", 7, now)),
      createdAt: now,
      createdByUserId: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      consumedAt: row.signedAt,
      consumeAction: row.signedAt ? "signed" : null,
    };
  }

  if (purpose === "ppe_signature") {
    const rows = await tx
      .select({
        id: ppeAssignmentsTable.id,
        confirmedAt: ppeAssignmentsTable.employeeConfirmedAt,
      })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.signatureToken, rawToken))
      .limit(2)
      .for("update");
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
      artifactBindingStatus: "not_applicable",
      jobDocumentVersionId: null,
      quoteVersionId: null,
      expiresAt: publicTokenExpiry("PPE_SIGNATURE_EXPIRY_DAYS", 30, now),
      createdAt: now,
      createdByUserId: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      consumedAt: row.confirmedAt,
      consumeAction: row.confirmedAt ? "signed" : null,
    };
  }

  if (purpose === "ppe_confirmation") {
    const rows = await tx
      .select({
        id: ppeAssignmentsTable.id,
        expiresAt: ppeAssignmentsTable.confirmTokenExpiresAt,
        confirmedAt: ppeAssignmentsTable.employeeConfirmedAt,
      })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.confirmToken, rawToken))
      .limit(2)
      .for("update");
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
      artifactBindingStatus: "not_applicable",
      jobDocumentVersionId: null,
      quoteVersionId: null,
      expiresAt:
        row.expiresAt ??
        publicTokenExpiry("PPE_CONFIRM_EXPIRY_DAYS", 30, now),
      createdAt: now,
      createdByUserId: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      consumedAt: row.confirmedAt,
      consumeAction: row.confirmedAt ? "confirmed" : null,
    };
  }

  const rows = await tx
    .select({
      id: quotesTable.id,
      status: quotesTable.status,
      updatedAt: quotesTable.updatedAt,
    })
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, rawToken))
    .limit(2)
    .for("update");
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const consumed = row.status === "accepted" || row.status === "rejected";
  const revoked = row.status === "expired";
  return {
    purpose,
    resourceType: RESOURCE_TYPE[purpose],
    resourceId: row.id,
    artifactBindingStatus: "legacy_unbound",
    jobDocumentVersionId: null,
    quoteVersionId: null,
    expiresAt: publicTokenExpiry("QUOTE_SHARE_EXPIRY_DAYS", 30, now),
    createdAt: now,
    createdByUserId: null,
    revokedAt: revoked ? row.updatedAt : null,
    revokedByUserId: null,
    revokeReason: revoked ? "legacy_quote_expired" : null,
    consumedAt: consumed ? row.updatedAt : null,
    consumeAction: consumed ? row.status : null,
  };
}

async function clearImportedLegacyToken(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  resourceId: number,
  rawToken: string,
): Promise<void> {
  let updated: { id: number }[];
  if (purpose === "job_signature") {
    updated = await tx
      .update(jobsTable)
      .set({ signatureToken: null })
      .where(
        and(
          eq(jobsTable.id, resourceId),
          eq(jobsTable.signatureToken, rawToken),
        ),
      )
      .returning({ id: jobsTable.id });
  } else if (purpose === "ppe_signature") {
    updated = await tx
      .update(ppeAssignmentsTable)
      .set({ signatureToken: null })
      .where(
        and(
          eq(ppeAssignmentsTable.id, resourceId),
          eq(ppeAssignmentsTable.signatureToken, rawToken),
        ),
      )
      .returning({ id: ppeAssignmentsTable.id });
  } else if (purpose === "ppe_confirmation") {
    updated = await tx
      .update(ppeAssignmentsTable)
      .set({ confirmToken: null })
      .where(
        and(
          eq(ppeAssignmentsTable.id, resourceId),
          eq(ppeAssignmentsTable.confirmToken, rawToken),
        ),
      )
      .returning({ id: ppeAssignmentsTable.id });
  } else {
    updated = await tx
      .update(quotesTable)
      .set({ shareToken: null })
      .where(
        and(
          eq(quotesTable.id, resourceId),
          eq(quotesTable.shareToken, rawToken),
        ),
      )
      .returning({ id: quotesTable.id });
  }
  if (updated.length !== 1) {
    throw new Error("Legacy public token changed during import.");
  }
}

async function importLegacyToken(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  rawToken: string,
  tokenHash: string,
): Promise<PublicAccessToken | null> {
  const now = new Date();
  const legacy = await readLegacyToken(tx, purpose, rawToken, now);
  if (!legacy) {
    const concurrent = await findRecord(tx, purpose, tokenHash);
    if (!concurrent) return null;
    await lockGrantResource(tx, purpose, concurrent.resourceId);
    await lockGrantFamily(tx, purpose, concurrent.resourceId);
    return findRecordForUpdate(tx, purpose, tokenHash);
  }
  await lockGrantFamily(tx, purpose, legacy.resourceId);
  const concurrent = await findRecordForUpdate(tx, purpose, tokenHash);
  if (concurrent) return concurrent;
  const [inserted] = await tx
    .insert(publicAccessTokensTable)
    .values({
      ...legacy,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      legacyImportedAt: now,
    })
    .returning();
  await clearImportedLegacyToken(
    tx,
    purpose,
    legacy.resourceId,
    rawToken,
  );
  return inserted ?? null;
}

async function loadTokenForUpdate(
  tx: DbTransaction,
  purpose: PublicAccessTokenPurpose,
  rawToken: string,
): Promise<PublicAccessToken> {
  assertTokenInput(rawToken);
  const tokenHash = hashPublicAccessToken(rawToken);
  let candidate = await findRecord(tx, purpose, tokenHash);
  if (!candidate) {
    candidate = await importLegacyToken(tx, purpose, rawToken, tokenHash);
  }
  if (!candidate) throw new PublicAccessTokenError("not_found");
  await lockGrantResource(tx, purpose, candidate.resourceId);
  await lockGrantFamily(tx, purpose, candidate.resourceId);
  const record = await findRecordForUpdate(tx, purpose, tokenHash);
  if (!record) throw new PublicAccessTokenError("not_found");
  return record;
}

export async function resolvePublicAccessToken(
  purpose: PublicAccessTokenPurpose,
  rawToken: string,
  tx?: DbTransaction,
): Promise<PublicAccessToken> {
  if (tx) {
    const record = await loadTokenForUpdate(tx, purpose, rawToken);
    assertUsable(record);
    return record;
  }
  assertTokenInput(rawToken);
  const tokenHash = hashPublicAccessToken(rawToken);
  let record = await findRecord(db, purpose, tokenHash);
  if (!record) {
    record = await db.transaction((tx) =>
      importLegacyToken(tx, purpose, rawToken, tokenHash),
    );
  }
  if (!record) throw new PublicAccessTokenError("not_found");
  assertUsable(record);
  return record;
}

export interface IssuePublicAccessTokenInput {
  purpose: PublicAccessTokenPurpose;
  resourceId: number;
  expiresAt: Date;
  createdByUserId: number;
  jobDocumentVersionId?: number | null;
  quoteVersionId?: number | null;
  ppeEvidenceVersionId?: number | null;
  allowExpiredForTesting?: boolean;
  onIssue?: (tx: DbTransaction) => Promise<void>;
}

async function lockAndAssertActiveOwner(
  tx: DbTransaction,
  ownerUserId: number,
  purpose: PublicAccessTokenPurpose,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SESSION_ISSUANCE_LOCK_NAMESPACE}, ${ownerUserId})`,
  );
  const [owner] = await tx
    .select({ isActive: usersTable.isActive, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1)
    .for("update");
  if (!owner?.isActive) {
    throw new PublicAccessTokenIssuanceError("issuer_inactive");
  }
  const rows = await tx
    .select({
      permission: userPermissionOverridesTable.permission,
      effect: userPermissionOverridesTable.effect,
    })
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.userId, ownerUserId));
  const overrides = rows.flatMap((row) =>
    row.effect === "allow" || row.effect === "deny"
      ? [{
          permission: row.permission,
          effect: row.effect as PermissionEffect,
        }]
      : [],
  );
  const permissions = resolvePermissions(owner.role as UserRole, overrides);
  if (!permissions.includes(ISSUANCE_PERMISSION[purpose])) {
    throw new PublicAccessTokenIssuanceError("issuer_permission_revoked");
  }
}

function validateArtifactBinding(input: IssuePublicAccessTokenInput): {
  artifactBindingStatus: "bound" | "not_applicable";
  jobDocumentVersionId: number | null;
  quoteVersionId: number | null;
  ppeEvidenceVersionId: number | null;
} {
  const jobDocumentVersionId = input.jobDocumentVersionId ?? null;
  const quoteVersionId = input.quoteVersionId ?? null;
  const ppeEvidenceVersionId = input.ppeEvidenceVersionId ?? null;
  if (input.purpose === "job_signature") {
    if (
      !Number.isInteger(jobDocumentVersionId) ||
      jobDocumentVersionId! <= 0 ||
      quoteVersionId !== null ||
      ppeEvidenceVersionId !== null
    ) {
      throw new Error("Job signature token requires one job document version.");
    }
    return {
      artifactBindingStatus: "bound",
      jobDocumentVersionId,
      quoteVersionId: null,
      ppeEvidenceVersionId: null,
    };
  }
  if (input.purpose === "quote_decision") {
    if (
      !Number.isInteger(quoteVersionId) ||
      quoteVersionId! <= 0 ||
      jobDocumentVersionId !== null ||
      ppeEvidenceVersionId !== null
    ) {
      throw new Error("Quote decision token requires one quote version.");
    }
    return {
      artifactBindingStatus: "bound",
      jobDocumentVersionId: null,
      quoteVersionId,
      ppeEvidenceVersionId: null,
    };
  }
  if (
    !Number.isInteger(ppeEvidenceVersionId) ||
    ppeEvidenceVersionId! <= 0 ||
    jobDocumentVersionId !== null ||
    quoteVersionId !== null
  ) {
    throw new Error("PPE public token requires one PPE evidence version.");
  }
  return {
    artifactBindingStatus: "bound",
    jobDocumentVersionId: null,
    quoteVersionId: null,
    ppeEvidenceVersionId,
  };
}

async function issueWithTransaction(
  tx: DbTransaction,
  input: IssuePublicAccessTokenInput,
  token: string,
  tokenHash: string,
  now: Date,
  binding: ReturnType<typeof validateArtifactBinding>,
): Promise<PublicAccessToken> {
  const resourceExists = await lockGrantResource(
    tx,
    input.purpose,
    input.resourceId,
  );
  if (!resourceExists) {
    throw new Error("Public token resource does not exist.");
  }
  await lockAndAssertActiveOwner(tx, input.createdByUserId, input.purpose);
  await lockGrantFamily(tx, input.purpose, input.resourceId);
  await tx
    .update(publicAccessTokensTable)
    .set({
      revokedAt: now,
      revokedByUserId: input.createdByUserId,
      revokeReason: "replaced",
    })
    .where(
      and(
        inArray(
          publicAccessTokensTable.purpose,
          CONFLICTING_PURPOSES[input.purpose],
        ),
        eq(publicAccessTokensTable.resourceType, RESOURCE_TYPE[input.purpose]),
        eq(publicAccessTokensTable.resourceId, input.resourceId),
        isNull(publicAccessTokensTable.revokedAt),
        isNull(publicAccessTokensTable.consumedAt),
      ),
    );
  const [inserted] = await tx
    .insert(publicAccessTokensTable)
    .values({
      purpose: input.purpose,
      resourceType: RESOURCE_TYPE[input.purpose],
      resourceId: input.resourceId,
      ...binding,
      tokenHash,
      tokenPrefix: token.slice(0, 8),
      expiresAt: input.expiresAt,
      createdAt: now,
      createdByUserId: input.createdByUserId,
      ownerKind: "organization",
      ownerUserId: null,
      ownerAssignedAt: now,
      ownerAssignmentSource: "resource_organization",
    })
    .returning();
  if (!inserted) throw new Error("Public token insert returned no row.");
  await input.onIssue?.(tx);
  return inserted;
}

export async function issuePublicAccessToken(
  input: IssuePublicAccessTokenInput,
  tx?: DbTransaction,
): Promise<{ token: string; record: PublicAccessToken }> {
  if (!Number.isInteger(input.resourceId) || input.resourceId <= 0) {
    throw new Error("Public token resource ID must be a positive integer.");
  }
  if (!Number.isInteger(input.createdByUserId) || input.createdByUserId <= 0) {
    throw new Error("Public token issuer ID must be a positive integer.");
  }
  if (!Number.isFinite(input.expiresAt.getTime())) {
    throw new Error("Public token expiry is invalid.");
  }
  const now = new Date();
  const allowExpiredForTesting =
    input.allowExpiredForTesting === true &&
    process.env.NODE_ENV !== "production";
  if (!allowExpiredForTesting && input.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Public token expiry must be in the future.");
  }
  if (input.expiresAt.getTime() - now.getTime() > MAX_TOKEN_LIFETIME_MS) {
    throw new Error("Public token expiry exceeds the 365-day hard limit.");
  }
  const binding = validateArtifactBinding(input);
  const token = newRawToken();
  const tokenHash = hashPublicAccessToken(token);
  const record = tx
    ? await issueWithTransaction(tx, input, token, tokenHash, now, binding)
    : await db.transaction((inner) =>
        issueWithTransaction(inner, input, token, tokenHash, now, binding),
      );
  return { token, record };
}

async function revokeWithTransaction(
  tx: DbTransaction,
  input: {
    purpose: PublicAccessTokenPurpose;
    resourceId: number;
    revokedByUserId?: number | null;
    reason: string;
  },
): Promise<number> {
  await lockGrantResource(tx, input.purpose, input.resourceId);
  await lockGrantFamily(tx, input.purpose, input.resourceId);
  const revoked = await tx
    .update(publicAccessTokensTable)
    .set({
      revokedAt: new Date(),
      revokedByUserId: input.revokedByUserId ?? null,
      revokeReason: input.reason,
    })
    .where(
      and(
        eq(publicAccessTokensTable.purpose, input.purpose),
        eq(publicAccessTokensTable.resourceType, RESOURCE_TYPE[input.purpose]),
        eq(publicAccessTokensTable.resourceId, input.resourceId),
        isNull(publicAccessTokensTable.revokedAt),
        isNull(publicAccessTokensTable.consumedAt),
      ),
    )
    .returning({ id: publicAccessTokensTable.id });
  return revoked.length;
}

export async function revokePublicAccessTokens(
  input: {
    purpose: PublicAccessTokenPurpose;
    resourceId: number;
    revokedByUserId?: number | null;
    reason: string;
  },
  tx?: DbTransaction,
): Promise<number> {
  if (tx) return revokeWithTransaction(tx, input);
  return db.transaction((inner) => revokeWithTransaction(inner, input));
}

export async function revokePublicAccessTokenById(
  input: {
    tokenId: number;
    revokedByUserId: number;
    reason: string;
  },
  tx: DbTransaction,
): Promise<
  | { found: false; revoked: null }
  | { found: true; revoked: PublicAccessToken | null }
> {
  const [candidate] = await tx
    .select()
    .from(publicAccessTokensTable)
    .where(eq(publicAccessTokensTable.id, input.tokenId))
    .limit(1);
  if (!candidate) return { found: false, revoked: null };
  const purpose = candidate.purpose;
  if (
    purpose !== "job_signature" &&
    purpose !== "ppe_signature" &&
    purpose !== "ppe_confirmation" &&
    purpose !== "quote_decision"
  ) {
    throw new Error(`Unsupported public access token purpose: ${purpose}`);
  }
  await lockGrantResource(tx, purpose, candidate.resourceId);
  await lockGrantFamily(tx, purpose, candidate.resourceId);
  const [revoked] = await tx
    .update(publicAccessTokensTable)
    .set({
      revokedAt: new Date(),
      revokedByUserId: input.revokedByUserId,
      revokeReason: input.reason,
    })
    .where(
      and(
        eq(publicAccessTokensTable.id, input.tokenId),
        isNull(publicAccessTokensTable.revokedAt),
        isNull(publicAccessTokensTable.consumedAt),
      ),
    )
    .returning();
  return { found: true, revoked: revoked ?? null };
}

export async function consumePublicAccessToken<T>(input: {
  purpose: PublicAccessTokenPurpose;
  token: string;
  action: PublicAccessTokenConsumeAction;
  transition: (tx: DbTransaction, record: PublicAccessToken) => Promise<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
    const record = await loadTokenForUpdate(tx, input.purpose, input.token);
    const now = new Date();
    assertUsable(record, now);
    const result = await input.transition(tx, record);
    const conflictingPurposes = conflictingPurposesFor(record.purpose);
    if (conflictingPurposes.length > 1) {
      await tx
        .update(publicAccessTokensTable)
        .set({
          revokedAt: now,
          revokeReason: "superseded_by_completion",
        })
        .where(
          and(
            ne(publicAccessTokensTable.id, record.id),
            inArray(publicAccessTokensTable.purpose, conflictingPurposes),
            eq(publicAccessTokensTable.resourceType, record.resourceType),
            eq(publicAccessTokensTable.resourceId, record.resourceId),
            isNull(publicAccessTokensTable.revokedAt),
            isNull(publicAccessTokensTable.consumedAt),
          ),
        );
    }
    const [consumed] = await tx
      .update(publicAccessTokensTable)
      .set({ consumedAt: now, consumeAction: input.action })
      .where(
        and(
          eq(publicAccessTokensTable.id, record.id),
          isNull(publicAccessTokensTable.revokedAt),
          isNull(publicAccessTokensTable.consumedAt),
          gt(publicAccessTokensTable.expiresAt, now),
        ),
      )
      .returning({ id: publicAccessTokensTable.id });
    if (!consumed) throw new PublicAccessTokenError("consumed");
    return result;
  });
}

export function publicAccessTokenHttpStatus(
  error: PublicAccessTokenError,
): 400 | 404 | 409 | 410 {
  if (error.code === "malformed") return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "consumed") return 409;
  return 410;
}
