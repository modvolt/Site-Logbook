import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { asc, eq, inArray } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  accountingReasonArtifactsTable,
  auditLogTable,
  billingDocumentFilesTable,
  billingDocumentsTable,
  db,
  pool,
  usersTable,
} from "@workspace/db";
import {
  deleteDocument,
  disposeCostDocument,
  setDocumentStatus,
} from "../src/lib/cost-document-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import { verifyCanonicalAccountingLifecycleEntryJsonBytes } from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingReasonArtifactJsonBytes } from "../src/lib/accounting-reason-artifact-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "../src/lib/accounting-persistence-contract";

const APPROVAL_FLAG = "ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED";
const REJECTION_FLAG = "ACCOUNTING_COST_DOCUMENT_REJECTION_DUAL_WRITE_ENABLED";
const TAG = `test-cost-disposition-accounting-${Date.now()}`;
const FILE_HASH = "d".repeat(64);
const REVIEW_REASON = "Doklad byl po kontrole vyhodnocen jako neplatný.";
const actor = { userId: 0, name: "Cost Disposition Test" };

async function createDocument(
  label: string,
  status: "uploaded" | "needs_review",
) {
  const [document] = await db
    .insert(billingDocumentsTable)
    .values({
      status,
      source: "manual",
      objectPath: `/objects/cost/${TAG}/${label}.pdf`,
      fileName: `${label}.pdf`,
      contentType: "application/pdf",
      fileSize: 2048,
      sha256: createHash("sha256").update(`${TAG}:${label}`).digest("hex"),
      createdByUserId: actor.userId,
    })
    .returning();
  await db.insert(billingDocumentFilesTable).values({
    documentId: document!.id,
    role: "primary",
    originalFileName: `${label}.pdf`,
    mimeType: "application/pdf",
    objectPath: `/objects/cost/${document!.id}/${label}.pdf`,
    sha256Hash: FILE_HASH,
    sizeBytes: 2048,
  });
  return document!;
}

async function evidenceRows(documentId: number) {
  const versions = await db
    .select()
    .from(accountingDocumentVersionsTable)
    .where(eq(accountingDocumentVersionsTable.billingDocumentId, documentId))
    .orderBy(asc(accountingDocumentVersionsTable.version));
  const events = await db
    .select()
    .from(accountingLifecycleEventsTable)
    .where(eq(accountingLifecycleEventsTable.billingDocumentId, documentId))
    .orderBy(asc(accountingLifecycleEventsTable.sequence));
  const reasons = await db
    .select()
    .from(accountingReasonArtifactsTable)
    .where(eq(accountingReasonArtifactsTable.billingDocumentId, documentId));
  const intentIds = [
    ...versions.map((row) => row.id),
    ...events.map((row) => row.id),
    ...reasons.map((row) => row.id),
  ];
  const outbox = intentIds.length
    ? await db
        .select()
        .from(accountingExportOutboxTable)
        .where(inArray(accountingExportOutboxTable.intentId, intentIds))
    : [];
  const heads = await db
    .select()
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.billingDocumentId, documentId));
  const audit = await db
    .select()
    .from(auditLogTable)
    .where(eq(auditLogTable.entityId, documentId));
  return { versions, events, reasons, outbox, heads, audit };
}

async function installReasonOutboxRejector(): Promise<void> {
  await pool.query(`
    CREATE FUNCTION test_reject_cost_rejection_reason_outbox()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation = 'reason-artifact' THEN
        RAISE EXCEPTION 'test cost rejection reason outbox rejection';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_reject_cost_rejection_reason_outbox_trigger
    BEFORE INSERT ON accounting_export_outbox
    FOR EACH ROW EXECUTE FUNCTION test_reject_cost_rejection_reason_outbox();
  `);
}

async function removeReasonOutboxRejector(): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS test_reject_cost_rejection_reason_outbox_trigger
      ON accounting_export_outbox;
    DROP FUNCTION IF EXISTS test_reject_cost_rejection_reason_outbox();
  `);
}

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: "test-only",
      name: actor.name,
      role: "admin",
    })
    .returning({ id: usersTable.id });
  actor.userId = user!.id;
});

afterEach(async () => {
  delete process.env[APPROVAL_FLAG];
  delete process.env[REJECTION_FLAG];
  await removeReasonOutboxRejector();
});

afterAll(() => {
  delete process.env[APPROVAL_FLAG];
  delete process.env[REJECTION_FLAG];
});

describe("cost-document disposition accounting seam", () => {
  it("keeps untouched-upload discard operational and outside accounting evidence", async () => {
    const document = await createDocument("early", "uploaded");

    await expect(
      disposeCostDocument(
        document.id,
        {
          mode: "early_discard",
          reasonCode: "not_a_document",
          confirmed: true,
        },
        actor,
      ),
    ).resolves.toMatchObject({ document: { status: "ignored" } });

    const rows = await evidenceRows(document.id);
    expect(rows).toMatchObject({
      versions: [],
      events: [],
      reasons: [],
      outbox: [],
      heads: [],
    });
    expect(rows.audit).toEqual([
      expect.objectContaining({
        action: "cost_document_early_discarded",
        summary: "early_discard:not_a_document",
      }),
    ]);
  });

  it("persists reviewed rejection, restricted readable reason and two export intents atomically", async () => {
    const document = await createDocument("reviewed", "needs_review");
    process.env[APPROVAL_FLAG] = "true";
    process.env[REJECTION_FLAG] = "true";

    await expect(
      disposeCostDocument(
        document.id,
        {
          mode: "reviewed_rejection",
          reasonCode: "invalid_document",
          reason: REVIEW_REASON,
        },
        actor,
      ),
    ).resolves.toMatchObject({ document: { status: "ignored" } });

    const rows = await evidenceRows(document.id);
    expect(rows.versions).toHaveLength(1);
    expect(rows.events).toHaveLength(1);
    expect(rows.reasons).toHaveLength(1);
    expect(rows.outbox).toHaveLength(2);
    expect(rows.heads).toHaveLength(1);
    const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[0]!.canonicalJson,
    );
    const event = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.events[0]!.canonicalJson,
    );
    const reason = verifyCanonicalAccountingReasonArtifactJsonBytes(
      rows.reasons[0]!.canonicalJson,
    );
    expect(version).toMatchObject({
      purpose: "discarded_observation",
      snapshot: {
        kind: "incoming-cost-document",
        sourceTrace: {
          capturePolicy: "human-reviewed-rejection-state/v1",
        },
      },
      provenance: {
        captureMode: "native-rejection",
      },
    });
    expect(event).toMatchObject({
      eventType: "ignored",
      reasonCode: "invalid_document",
      reasonDetailSha256: reason.reason.textSha256,
    });
    expect(reason).toMatchObject({
      aggregate: {
        kind: "incoming-cost-document",
        id: String(document.id),
        versionId: version.versionId,
      },
      lifecycleEvent: {
        eventId: event.eventId,
        eventSha256: event.integrity.entrySha256,
      },
      reason: {
        code: "invalid_document",
        text: REVIEW_REASON,
      },
      retention: {
        class: "restricted-accounting-evidence",
        legalHoldAware: true,
      },
      accessPolicy: {
        mode: "restricted",
        listing: "metadata-only",
        plaintextExport: "authorized-audit-only",
      },
    });
    const intents = rows.outbox.map((row) =>
      verifyCanonicalAccountingExportIntentJsonBytes(row.canonicalJson),
    );
    expect(intents.map((intent) => intent.operation).sort()).toEqual([
      "initial-version",
      "reason-artifact",
    ]);
    expect(
      intents.find((intent) => intent.operation === "reason-artifact"),
    ).toMatchObject({
      destination: {
        namespace: "accounting-evidence-restricted/v1",
      },
    });
    expect(rows.heads[0]).toMatchObject({
      revision: 1n,
      versionHeadId: version.versionId,
      lifecycleHeadId: event.eventId,
    });
    expect(rows.audit).toEqual([
      expect.objectContaining({
        action: "cost_document_reviewed_rejected",
        summary: "reviewed_rejection:invalid_document",
      }),
    ]);
    const unrestrictedEvidenceText = [
      ...rows.versions.map((row) => row.canonicalJson),
      ...rows.events.map((row) => row.canonicalJson),
      ...rows.outbox.map((row) => row.canonicalJson),
      ...rows.audit.map((row) => row.summary),
    ].join("\n");
    expect(unrestrictedEvidenceText).not.toContain(REVIEW_REASON);
    await expect(deleteDocument(document.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rolls back projection and all evidence when the restricted outbox insert fails", async () => {
    const document = await createDocument("rollback", "needs_review");
    process.env[APPROVAL_FLAG] = "true";
    process.env[REJECTION_FLAG] = "true";
    await installReasonOutboxRejector();

    await expect(
      disposeCostDocument(
        document.id,
        {
          mode: "reviewed_rejection",
          reasonCode: "duplicate_document",
          reason: "Doklad je duplicitním zobrazením stejného zdroje.",
        },
        actor,
      ),
    ).rejects.toThrow(/accounting_export_outbox/i);

    expect(
      await db
        .select({ status: billingDocumentsTable.status })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, document.id)),
    ).toEqual([{ status: "needs_review" }]);
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      reasons: [],
      outbox: [],
      heads: [],
      audit: [],
    });
  });

  it("keeps reviewed rejection dark and blocks the legacy ignored path after activation", async () => {
    const document = await createDocument("dark", "needs_review");
    process.env[APPROVAL_FLAG] = "true";

    await expect(
      disposeCostDocument(
        document.id,
        {
          mode: "reviewed_rejection",
          reasonCode: "invalid_document",
          reason: REVIEW_REASON,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      reasons: [],
      outbox: [],
      heads: [],
      audit: [],
    });

    process.env[REJECTION_FLAG] = "true";
    await expect(
      setDocumentStatus(document.id, "ignored", actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
