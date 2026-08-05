import { eq, max } from "drizzle-orm";
import {
  db,
  ppeAssignmentsTable,
  ppePublicEvidenceEventsTable,
  ppePublicEvidenceVersionsTable,
  type PpeAssignment,
  type PpePublicEvidencePurpose,
  type PpePublicEvidenceSnapshot,
  type PpePublicEvidenceVersion,
  type PublicAccessToken,
} from "@workspace/db";
import { evidenceSha256 } from "./evidence-hash";
import {
  consumePublicAccessToken,
  issuePublicAccessToken,
  PublicAccessTokenError,
  resolvePublicAccessToken,
} from "./public-access-token";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PPE_PUBLIC_CONFIRMATION_TEXT =
  "Svým potvrzením stvrzuji, že jsem převzal/a výše uvedené osobní ochranné pracovní prostředky (OOPP).";

export const PPE_PUBLIC_SIGNATURE_CONFIRMATION_TEXT =
  "Svým podpisem potvrzuji, že jsem převzal/a výše uvedené ochranné pracovní pomůcky (OOPP). " +
  "Zavazuji se je používat v souladu s pokyny výrobce a zaměstnavatele a chránit je před poškozením.";

export type PpePublicEvidenceErrorCode =
  | "not_found"
  | "closed"
  | "already_confirmed";

export class PpePublicEvidenceError extends Error {
  constructor(readonly code: PpePublicEvidenceErrorCode) {
    super(`PPE public evidence transition rejected: ${code}.`);
    this.name = "PpePublicEvidenceError";
  }
}

function confirmationTextFor(purpose: PpePublicEvidencePurpose): string {
  return purpose === "ppe_signature"
    ? PPE_PUBLIC_SIGNATURE_CONFIRMATION_TEXT
    : PPE_PUBLIC_CONFIRMATION_TEXT;
}

function assertEligible(assignment: PpeAssignment): void {
  if (assignment.status !== "issued") {
    throw new PpePublicEvidenceError("closed");
  }
  if (assignment.employeeConfirmedAt) {
    throw new PpePublicEvidenceError("already_confirmed");
  }
}

function createSnapshot(
  assignment: PpeAssignment,
  purpose: PpePublicEvidencePurpose,
): PpePublicEvidenceSnapshot {
  const confirmationText = confirmationTextFor(purpose);
  return {
    schemaVersion: 1,
    purpose,
    assignment: {
      id: assignment.id,
      ppeNameSnapshot: assignment.ppeNameSnapshot,
      personNameSnapshot: assignment.personNameSnapshot,
      ppeCategorySnapshot: assignment.ppeCategorySnapshot,
      ppeStandardSnapshot: assignment.ppeStandardSnapshot,
      ppeProtectionClassSnapshot: assignment.ppeProtectionClassSnapshot,
      ppeRiskDescriptionSnapshot: assignment.ppeRiskDescriptionSnapshot,
      quantity: assignment.quantity,
      size: assignment.size,
      serialNumber: assignment.serialNumber,
      issuedAt: assignment.issuedAt,
      replaceBy: assignment.replaceBy,
      nextInspectionAt: assignment.nextInspectionAt,
    },
    confirmationText,
  };
}

function assertEvidenceBinding(
  record: PublicAccessToken,
  version: PpePublicEvidenceVersion | null,
  purpose: PpePublicEvidencePurpose,
): PpePublicEvidenceVersion {
  if (
    !version ||
    record.ppeEvidenceVersionId !== version.id ||
    record.resourceType !== "ppe_assignment" ||
    record.resourceId !== version.assignmentId ||
    record.purpose !== purpose ||
    version.purpose !== purpose ||
    version.dataSnapshot.schemaVersion !== 1 ||
    version.dataSnapshot.purpose !== purpose ||
    version.dataSnapshot.assignment.id !== version.assignmentId ||
    version.dataSnapshot.confirmationText !== version.confirmationText
  ) {
    throw new PublicAccessTokenError("revoked");
  }
  try {
    if (evidenceSha256(version.dataSnapshot) !== version.snapshotSha256) {
      throw new PublicAccessTokenError("revoked");
    }
  } catch (error) {
    if (error instanceof PublicAccessTokenError) throw error;
    throw new PublicAccessTokenError("revoked");
  }
  return version;
}

async function loadBoundEvidenceVersion(
  tx: DbTransaction,
  record: PublicAccessToken,
  purpose: PpePublicEvidencePurpose,
): Promise<PpePublicEvidenceVersion> {
  if (!record.ppeEvidenceVersionId) {
    throw new PublicAccessTokenError("revoked");
  }
  const [version] = await tx
    .select()
    .from(ppePublicEvidenceVersionsTable)
    .where(eq(ppePublicEvidenceVersionsTable.id, record.ppeEvidenceVersionId))
    .limit(1);
  return assertEvidenceBinding(record, version ?? null, purpose);
}

async function lockEligibleAssignment(
  tx: DbTransaction,
  assignmentId: number,
): Promise<PpeAssignment> {
  const [assignment] = await tx
    .select()
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.id, assignmentId))
    .limit(1)
    .for("update");
  if (!assignment) throw new PpePublicEvidenceError("not_found");
  assertEligible(assignment);
  return assignment;
}

export async function issuePpePublicEvidenceToken(input: {
  assignmentId: number;
  purpose: PpePublicEvidencePurpose;
  expiresAt: Date;
  createdByUserId: number;
}): Promise<{
  token: string;
  record: PublicAccessToken;
  evidenceVersion: PpePublicEvidenceVersion;
  assignment: PpeAssignment;
  snapshot: PpePublicEvidenceSnapshot;
}> {
  return db.transaction(async (tx) => {
    const assignment = await lockEligibleAssignment(tx, input.assignmentId);
    const [latest] = await tx
      .select({ version: max(ppePublicEvidenceVersionsTable.version) })
      .from(ppePublicEvidenceVersionsTable)
      .where(eq(ppePublicEvidenceVersionsTable.assignmentId, assignment.id));
    const versionNumber = Number(latest?.version ?? 0) + 1;
    const snapshot = createSnapshot(assignment, input.purpose);
    const [evidenceVersion] = await tx
      .insert(ppePublicEvidenceVersionsTable)
      .values({
        assignmentId: assignment.id,
        purpose: input.purpose,
        version: versionNumber,
        dataSnapshot: snapshot,
        snapshotSha256: evidenceSha256(snapshot),
        confirmationText: snapshot.confirmationText,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    if (!evidenceVersion) {
      throw new Error("PPE public evidence version insert returned no row.");
    }

    const issued = await issuePublicAccessToken({
      purpose: input.purpose,
      resourceId: assignment.id,
      ppeEvidenceVersionId: evidenceVersion.id,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
      onIssue: async (inner) => {
        await inner
          .update(ppeAssignmentsTable)
          .set(input.purpose === "ppe_signature"
            ? { signatureToken: null }
            : {
                confirmToken: null,
                confirmTokenExpiresAt: input.expiresAt,
              })
          .where(eq(ppeAssignmentsTable.id, assignment.id));
      },
    }, tx);

    return {
      ...issued,
      evidenceVersion,
      assignment,
      snapshot,
    };
  });
}

export async function resolvePpePublicEvidenceToken(
  purpose: PpePublicEvidencePurpose,
  token: string,
): Promise<{
  record: PublicAccessToken;
  evidenceVersion: PpePublicEvidenceVersion;
  snapshot: PpePublicEvidenceSnapshot;
}> {
  return db.transaction(async (tx) => {
    const record = await resolvePublicAccessToken(purpose, token, tx);
    const evidenceVersion = await loadBoundEvidenceVersion(tx, record, purpose);
    await lockEligibleAssignment(tx, evidenceVersion.assignmentId);
    return {
      record,
      evidenceVersion,
      snapshot: evidenceVersion.dataSnapshot,
    };
  });
}

type ConsumePpePublicEvidenceInput =
  | {
      purpose: "ppe_signature";
      token: string;
      action: "signed";
      signatureObjectPath: string;
      signatureSha256: string;
    }
  | {
      purpose: "ppe_confirmation";
      token: string;
      action: "confirmed";
    };

export async function consumePpePublicEvidenceToken(
  input: ConsumePpePublicEvidenceInput,
): Promise<{
  confirmedAt: Date;
  evidenceVersion: PpePublicEvidenceVersion;
  snapshot: PpePublicEvidenceSnapshot;
}> {
  if (
    input.purpose === "ppe_signature" &&
    !/^[0-9a-f]{64}$/.test(input.signatureSha256)
  ) {
    throw new Error("PPE signature evidence requires a SHA-256 hash.");
  }

  return consumePublicAccessToken({
    purpose: input.purpose,
    token: input.token,
    action: input.action,
    transition: async (tx, record) => {
      const evidenceVersion = await loadBoundEvidenceVersion(
        tx,
        record,
        input.purpose,
      );
      const assignment = await lockEligibleAssignment(
        tx,
        evidenceVersion.assignmentId,
      );
      const confirmedAt = new Date();
      const [updated] = await tx
        .update(ppeAssignmentsTable)
        .set(input.purpose === "ppe_signature"
          ? {
              employeeConfirmedAt: confirmedAt,
              signatureObjectPath: input.signatureObjectPath,
            }
          : { employeeConfirmedAt: confirmedAt })
        .where(eq(ppeAssignmentsTable.id, assignment.id))
        .returning({ id: ppeAssignmentsTable.id });
      if (!updated) throw new PpePublicEvidenceError("not_found");

      await tx.insert(ppePublicEvidenceEventsTable).values({
        assignmentId: assignment.id,
        evidenceVersionId: evidenceVersion.id,
        publicAccessTokenId: record.id,
        action: input.action,
        snapshotSha256: evidenceVersion.snapshotSha256,
        confirmationText: evidenceVersion.confirmationText,
        signatureObjectPath: input.purpose === "ppe_signature"
          ? input.signatureObjectPath
          : null,
        signatureSha256: input.purpose === "ppe_signature"
          ? input.signatureSha256
          : null,
        createdAt: confirmedAt,
      });

      return {
        confirmedAt,
        evidenceVersion,
        snapshot: evidenceVersion.dataSnapshot,
      };
    },
  });
}
