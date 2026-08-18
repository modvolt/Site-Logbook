import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { eq } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  billingDocumentFilesTable,
  billingDocumentLinesTable,
  billingDocumentsTable,
  db,
  pool,
  usersTable,
} from "@workspace/db";
import {
  approveDocument,
  setDocumentStatus,
} from "../src/lib/cost-document-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import {
  verifyAccountingLifecycleEventBinding,
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
} from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "../src/lib/accounting-persistence-contract";

const FEATURE_FLAG = "ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED";
const TAG = `test-cost-approval-accounting-${Date.now()}`;
const FILE_HASH = "a".repeat(64);

const actor = { userId: 0, name: "Cost Approval Test" };

async function createReviewDocument(label: string) {
  const [document] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "needs_review",
      docType: "receipt",
      docTypeSource: "admin",
      source: "manual",
      supplierName: `Supplier ${label} ${TAG}`,
      documentNumber: `PF-${label}-${TAG}`,
      issueDate: "2042-05-01",
      taxableSupplyDate: "2042-05-01",
      currency: "CZK",
      subtotalWithoutVat: "100.00",
      totalVat: "21.00",
      totalWithVat: "121.00",
      createdByUserId: actor.userId,
    })
    .returning();
  await db.insert(billingDocumentLinesTable).values({
    documentId: document!.id,
    lineType: "work",
    description: `Service ${label}`,
    quantity: "1.00",
    unit: "ks",
    unitPriceWithoutVat: "100.00",
    vatRate: "21.00",
    vatMode: "standard",
    totalWithoutVat: "100.00",
    totalVat: "21.00",
    totalWithVat: "121.00",
    allocationType: "internal",
    matchConfirmed: 0,
    approved: 0,
  });
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
    .where(eq(accountingDocumentVersionsTable.billingDocumentId, documentId));
  const events = await db
    .select()
    .from(accountingLifecycleEventsTable)
    .where(eq(accountingLifecycleEventsTable.billingDocumentId, documentId));
  const heads = await db
    .select()
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.billingDocumentId, documentId));
  const outbox =
    versions.length === 0
      ? []
      : await db
          .select()
          .from(accountingExportOutboxTable)
          .where(eq(accountingExportOutboxTable.intentId, versions[0]!.id));
  return { versions, events, heads, outbox };
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

afterEach(() => {
  delete process.env[FEATURE_FLAG];
});

afterAll(() => {
  delete process.env[FEATURE_FLAG];
});

describe("approveDocument accounting dual-write seam", () => {
  it("persists one strict approved version, event, aggregate head and export intent", async () => {
    const document = await createReviewDocument("success");
    process.env[FEATURE_FLAG] = "true";

    const approved = await approveDocument(document.id, actor);
    expect(approved?.document.status).toBe("approved");
    const rows = await evidenceRows(document.id);
    expect(rows.versions).toHaveLength(1);
    expect(rows.events).toHaveLength(1);
    expect(rows.heads).toHaveLength(1);
    expect(rows.outbox).toHaveLength(1);

    const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[0]!.canonicalJson,
    );
    const event = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.events[0]!.canonicalJson,
    );
    expect(() =>
      verifyAccountingLifecycleEventBinding(event, version),
    ).not.toThrow();
    expect(version).toMatchObject({
      aggregate: { kind: "incoming-cost-document", id: String(document.id) },
      purpose: "approved",
      snapshot: {
        kind: "incoming-cost-document",
        sourceTrace: {
          capturePolicy: "human-approved-final-state/v1",
          originalSource: "manual",
        },
      },
    });
    expect(event).toMatchObject({
      eventType: "approved",
      reasonCode: "document_approved",
    });
    const intent = verifyCanonicalAccountingExportIntentJsonBytes(
      rows.outbox[0]!.canonicalJson,
    );
    expect(intent).toMatchObject({
      intentId: version.versionId,
      operation: "initial-version",
      initialState: "pending",
    });
    expect(rows.heads[0]).toMatchObject({
      revision: 1n,
      versionHeadId: version.versionId,
      lifecycleHeadId: event.eventId,
    });

    const reviewedAt = approved?.document.reviewedAt;
    const replay = await approveDocument(document.id, actor);
    expect(replay?.document.reviewedAt).toBe(reviewedAt);
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [expect.anything()],
      events: [expect.anything()],
      heads: [expect.anything()],
      outbox: [expect.anything()],
    });

    await expect(
      setDocumentStatus(document.id, "needs_review", actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    const [stillApproved] = await db
      .select({ status: billingDocumentsTable.status })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, document.id));
    expect(stillApproved?.status).toBe("approved");

    await db
      .update(billingDocumentLinesTable)
      .set({ description: "Tampered after approval" })
      .where(eq(billingDocumentLinesTable.documentId, document.id));
    await expect(approveDocument(document.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await evidenceRows(document.id)).versions).toHaveLength(1);
  });

  it("rolls back document, lines and evidence when export intent insertion fails", async () => {
    const document = await createReviewDocument("rollback");
    process.env[FEATURE_FLAG] = "true";
    await pool.query(`
      CREATE FUNCTION test_reject_cost_accounting_export_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test cost accounting export rejection';
      END;
      $$;
      CREATE TRIGGER test_reject_cost_accounting_export_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_cost_accounting_export_outbox();
    `);
    try {
      await expect(approveDocument(document.id, actor)).rejects.toThrow(
        /accounting_export_outbox/i,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_reject_cost_accounting_export_outbox_trigger
          ON accounting_export_outbox;
        DROP FUNCTION IF EXISTS test_reject_cost_accounting_export_outbox();
      `);
    }

    const [documentAfter] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, document.id));
    const [lineAfter] = await db
      .select()
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, document.id));
    expect(documentAfter).toMatchObject({
      status: "needs_review",
      reviewedByUserId: null,
      reviewedAt: null,
    });
    expect(lineAfter).toMatchObject({ matchConfirmed: 0, approved: 0 });
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      heads: [],
      outbox: [],
    });

    await expect(approveDocument(document.id, actor)).resolves.toMatchObject({
      document: { status: "approved" },
    });
    expect((await evidenceRows(document.id)).versions).toHaveLength(1);
  });

  it("preserves the dark legacy path and refuses to fabricate native history later", async () => {
    const document = await createReviewDocument("disabled");
    process.env[FEATURE_FLAG] = "false";
    await expect(approveDocument(document.id, actor)).resolves.toMatchObject({
      document: { status: "approved" },
    });
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      heads: [],
      outbox: [],
    });

    process.env[FEATURE_FLAG] = "true";
    await expect(approveDocument(document.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      heads: [],
      outbox: [],
    });
  });
});
