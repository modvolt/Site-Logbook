import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  ppeAssignmentsTable,
  publicAccessTokensTable,
  quotesTable,
  type PublicAccessToken,
  type PublicAccessTokenConsumeAction,
  type PublicAccessTokenPurpose,
} from "@workspace/db";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | DbTransaction;

const RESOURCE_TYPE: Record<PublicAccessTokenPurpose, string> = {
  job_signature: "job",
  ppe_signature: "ppe_assignment",
  ppe_confirmation: "ppe_assignment",
  quote_decision: "quote",
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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

export function isPlausiblePublicAccessToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function hashPublicAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function publicTokenExpiry(
  envName: string,
  defaultDays: number,
  now = new Date(),
): Date {
  const configured = Number(process.env[envName] ?? defaultDays);
  const days = Number.isFinite(configured) && configured >= 1 && configured <= 365
    ? configured
    : defaultDays;
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
      .limit(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
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
      .limit(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
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
      .limit(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      purpose,
      resourceType: RESOURCE_TYPE[purpose],
      resourceId: row.id,
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
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const consumed = row.status === "accepted" || row.status === "rejected";
  const revoked = row.status === "expired";
  return {
    purpose,
    resourceType: RESOURCE_TYPE[purpose],
    resourceId: row.id,
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
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${purpose}:${tokenHash}`}))`,
  );
  const concurrent = await findRecordForUpdate(tx, purpose, tokenHash);
  if (concurrent) return concurrent;

  const now = new Date();
  const legacy = await readLegacyToken(tx, purpose, rawToken, now);
  if (!legacy) return null;
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
  const record =
    (await findRecordForUpdate(tx, purpose, tokenHash)) ??
    (await importLegacyToken(tx, purpose, rawToken, tokenHash));
  if (!record) throw new PublicAccessTokenError("not_found");
  return record;
}

export async function resolvePublicAccessToken(
  purpose: PublicAccessTokenPurpose,
  rawToken: string,
): Promise<PublicAccessToken> {
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

export async function issuePublicAccessToken(input: {
  purpose: PublicAccessTokenPurpose;
  resourceId: number;
  expiresAt: Date;
  createdByUserId?: number | null;
  onIssue?: (tx: DbTransaction) => Promise<void>;
}): Promise<{ token: string; record: PublicAccessToken }> {
  if (!Number.isInteger(input.resourceId) || input.resourceId <= 0) {
    throw new Error("Public token resource ID must be a positive integer.");
  }
  if (!Number.isFinite(input.expiresAt.getTime())) {
    throw new Error("Public token expiry is invalid.");
  }
  const token = newRawToken();
  const tokenHash = hashPublicAccessToken(token);
  const now = new Date();
  const record = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.purpose}:${input.resourceId}`}))`,
    );
    await tx
      .update(publicAccessTokensTable)
      .set({
        revokedAt: now,
        revokedByUserId: input.createdByUserId ?? null,
        revokeReason: "replaced",
      })
      .where(
        and(
          eq(publicAccessTokensTable.purpose, input.purpose),
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
        tokenHash,
        tokenPrefix: token.slice(0, 8),
        expiresAt: input.expiresAt,
        createdAt: now,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    if (!inserted) throw new Error("Public token insert returned no row.");
    await input.onIssue?.(tx);
    return inserted;
  });
  return { token, record };
}

async function revokeWithClient(
  client: DbClient,
  input: {
    purpose: PublicAccessTokenPurpose;
    resourceId: number;
    revokedByUserId?: number | null;
    reason: string;
  },
): Promise<number> {
  const revoked = await client
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
  if (tx) return revokeWithClient(tx, input);
  return db.transaction(async (inner) => {
    await inner.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.purpose}:${input.resourceId}`}))`,
    );
    return revokeWithClient(inner, input);
  });
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
