import { desc, eq, max } from "drizzle-orm";
import {
  customersTable,
  db,
  jobDocumentVersionsTable,
  jobSignatureEventsTable,
  jobsTable,
  type JobDocumentSnapshot,
  type PublicAccessToken,
} from "@workspace/db";
import { evidenceSha256 } from "./evidence-hash";
import { JOB_HANDOVER_RENDERER_VERSION } from "./job-handover-pdf";
import {
  issuePublicAccessToken,
  revokePublicAccessTokens,
} from "./public-access-token";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const JOB_SIGNATURE_CONFIRMATION_TEXT =
  "Podepsáním potvrzuji, že jsem byl/a seznámen/a s tímto předávacím protokolem zakázky a souhlasím s jeho uvedeným obsahem.";

export class JobDocumentStateError extends Error {
  constructor(
    readonly code:
      | "job_not_found"
      | "already_signed"
      | "version_not_found"
      | "version_not_pending"
      | "not_signed",
  ) {
    super(code);
    this.name = "JobDocumentStateError";
  }
}

export async function issueJobSignatureVersion(input: {
  jobId: number;
  expiresAt: Date;
  requestedAt: Date;
  createdByUserId?: number | null;
}) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, input.jobId))
      .for("update");
    if (!job) throw new JobDocumentStateError("job_not_found");
    if (job.signedAt) throw new JobDocumentStateError("already_signed");

    let customerCompanyName: string | null = null;
    if (job.customerId) {
      const [customer] = await tx
        .select({ companyName: customersTable.companyName })
        .from(customersTable)
        .where(eq(customersTable.id, job.customerId));
      customerCompanyName = customer?.companyName ?? null;
    }

    const snapshot: JobDocumentSnapshot = {
      schemaVersion: 1,
      job: {
        id: job.id,
        title: job.title,
        date: job.date,
        customerCompanyName,
        notes: job.notes,
      },
      confirmationText: JOB_SIGNATURE_CONFIRMATION_TEXT,
    };
    const snapshotSha256 = evidenceSha256(snapshot);
    const [{ value: latestVersion }] = await tx
      .select({ value: max(jobDocumentVersionsTable.version) })
      .from(jobDocumentVersionsTable)
      .where(eq(jobDocumentVersionsTable.jobId, job.id));
    const [previousVersion] = await tx
      .select({
        id: jobDocumentVersionsTable.id,
        status: jobDocumentVersionsTable.status,
      })
      .from(jobDocumentVersionsTable)
      .where(eq(jobDocumentVersionsTable.jobId, job.id))
      .orderBy(desc(jobDocumentVersionsTable.version))
      .limit(1);
    if (previousVersion?.status === "pending_signature") {
      await tx.insert(jobSignatureEventsTable).values({
        jobId: job.id,
        documentVersionId: previousVersion.id,
        eventType: "cancelled",
        actorType: "system",
        reason: "signature_link_replaced",
      });
    }
    const [version] = await tx
      .insert(jobDocumentVersionsTable)
      .values({
        jobId: job.id,
        version: Number(latestVersion ?? 0) + 1,
        status: "pending_signature",
        supersedesVersionId: previousVersion?.id ?? null,
        dataSnapshot: snapshot,
        snapshotSha256,
        rendererVersion: JOB_HANDOVER_RENDERER_VERSION,
        confirmationText: JOB_SIGNATURE_CONFIRMATION_TEXT,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    if (!version) throw new Error("Job document version insert returned no row.");

    const issued = await issuePublicAccessToken(
      {
        purpose: "job_signature",
        resourceId: job.id,
        jobDocumentVersionId: version.id,
        expiresAt: input.expiresAt,
        createdByUserId: input.createdByUserId ?? null,
        onIssue: async (inner) => {
          await inner
            .update(jobsTable)
            .set({
              signatureToken: null,
              signatureTokenExpiresAt: input.expiresAt,
              signatureRequestedAt: input.requestedAt,
            })
            .where(eq(jobsTable.id, job.id));
        },
      },
      tx,
    );
    return { ...issued, version };
  });
}

export async function loadBoundJobDocumentVersion(record: PublicAccessToken) {
  if (
    record.purpose !== "job_signature" ||
    record.artifactBindingStatus !== "bound" ||
    !record.jobDocumentVersionId
  ) {
    throw new JobDocumentStateError("version_not_found");
  }
  const [version] = await db
    .select()
    .from(jobDocumentVersionsTable)
    .where(eq(jobDocumentVersionsTable.id, record.jobDocumentVersionId));
  if (!version || version.jobId !== record.resourceId) {
    throw new JobDocumentStateError("version_not_found");
  }
  return version;
}

export async function completeJobSignature(
  tx: DbTransaction,
  input: {
    record: PublicAccessToken;
    signatoryName: string;
    signedAt: Date;
    signatureObjectPath: string;
    signatureSha256: string;
    pdfObjectPath: string;
    pdfSha256: string;
    userAgentSha256: string | null;
  },
) {
  if (!input.record.jobDocumentVersionId) {
    throw new JobDocumentStateError("version_not_found");
  }
  const [version] = await tx
    .select()
    .from(jobDocumentVersionsTable)
    .where(eq(jobDocumentVersionsTable.id, input.record.jobDocumentVersionId))
    .for("update");
  if (!version || version.jobId !== input.record.resourceId) {
    throw new JobDocumentStateError("version_not_found");
  }
  if (version.status !== "pending_signature") {
    throw new JobDocumentStateError("version_not_pending");
  }
  const [job] = await tx
    .select({ id: jobsTable.id, signedAt: jobsTable.signedAt })
    .from(jobsTable)
    .where(eq(jobsTable.id, version.jobId))
    .for("update");
  if (!job) throw new JobDocumentStateError("job_not_found");
  if (job.signedAt) throw new JobDocumentStateError("already_signed");

  const [signedVersion] = await tx
    .update(jobDocumentVersionsTable)
    .set({
      status: "signed",
      signatoryName: input.signatoryName,
      identityAssurance: "self_declared_name",
      signatureObjectPath: input.signatureObjectPath,
      signatureSha256: input.signatureSha256,
      pdfObjectPath: input.pdfObjectPath,
      pdfSha256: input.pdfSha256,
      signedAt: input.signedAt,
    })
    .where(eq(jobDocumentVersionsTable.id, version.id))
    .returning();
  if (!signedVersion) throw new Error("Job document version update returned no row.");
  await tx.insert(jobSignatureEventsTable).values({
    jobId: job.id,
    documentVersionId: version.id,
    eventType: "signed",
    actorType: "public_signer",
    actorName: input.signatoryName,
    identityAssurance: "self_declared_name",
    confirmationText: version.confirmationText,
    userAgentSha256: input.userAgentSha256,
  });
  await tx
    .update(jobsTable)
    .set({
      signedAt: input.signedAt,
      signatureObjectPath: input.signatureObjectPath,
    })
    .where(eq(jobsTable.id, job.id));
  return signedVersion;
}

export async function reopenJobForSignatureCorrection(input: {
  jobId: number;
  reason: string;
  actor: { userId: number; name: string };
}) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ id: jobsTable.id, signedAt: jobsTable.signedAt })
      .from(jobsTable)
      .where(eq(jobsTable.id, input.jobId))
      .for("update");
    if (!job) throw new JobDocumentStateError("job_not_found");
    if (!job.signedAt) throw new JobDocumentStateError("not_signed");
    const [version] = await tx
      .select()
      .from(jobDocumentVersionsTable)
      .where(eq(jobDocumentVersionsTable.jobId, job.id))
      .orderBy(desc(jobDocumentVersionsTable.version))
      .limit(1);
    if (!version || version.status !== "signed") {
      throw new JobDocumentStateError("version_not_found");
    }
    await tx.insert(jobSignatureEventsTable).values({
      jobId: job.id,
      documentVersionId: version.id,
      eventType: "superseded",
      actorType: "admin",
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      reason: input.reason,
    });
    await tx
      .update(jobsTable)
      .set({
        signedAt: null,
        signatureObjectPath: null,
        signatureTokenExpiresAt: null,
        signatureRequestedAt: null,
      })
      .where(eq(jobsTable.id, job.id));
    await revokePublicAccessTokens(
      {
        purpose: "job_signature",
        resourceId: job.id,
        revokedByUserId: input.actor.userId,
        reason: "signature_correction",
      },
      tx,
    );
    return version;
  });
}

export async function latestSignedJobDocument(jobId: number) {
  const [job] = await db
    .select({ signedAt: jobsTable.signedAt })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job?.signedAt) return null;
  const [version] = await db
    .select()
    .from(jobDocumentVersionsTable)
    .where(eq(jobDocumentVersionsTable.jobId, jobId))
    .orderBy(desc(jobDocumentVersionsTable.version))
    .limit(1);
  return version?.status === "signed" ? version : null;
}

export async function listJobSignatureEvidence(jobId: number) {
  const versions = await db
    .select()
    .from(jobDocumentVersionsTable)
    .where(eq(jobDocumentVersionsTable.jobId, jobId))
    .orderBy(desc(jobDocumentVersionsTable.version));
  const events = await db
    .select()
    .from(jobSignatureEventsTable)
    .where(eq(jobSignatureEventsTable.jobId, jobId))
    .orderBy(desc(jobSignatureEventsTable.createdAt));
  return { versions, events };
}
