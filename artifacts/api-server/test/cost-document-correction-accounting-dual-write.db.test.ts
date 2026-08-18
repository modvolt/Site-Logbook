import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { asc, eq, inArray } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  accountingReasonArtifactsTable,
  accountingVersionRelationsTable,
  auditLogTable,
  billingDocumentFilesTable,
  billingDocumentLinesTable,
  billingDocumentsTable,
  db,
  pool,
  usersTable,
  warehouseItemsTable,
  warehousePriceHistoryTable,
} from "@workspace/db";
import {
  approveDocument,
  deleteDocument,
  setDocumentStatus,
} from "../src/lib/cost-document-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import { verifyCanonicalAccountingLifecycleEntryJsonBytes } from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingReasonArtifactJsonBytes } from "../src/lib/accounting-reason-artifact-contract";

const APPROVAL_FLAG = "ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED";
const CORRECTION_FLAG =
  "ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED";
const TAG = `test-cost-correction-accounting-${Date.now()}`;
const FILE_HASH = "c".repeat(64);
const actor = { userId: 0, name: "Cost Correction Test" };

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
      issueDate: "2042-06-01",
      taxableSupplyDate: "2042-06-01",
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
    .where(eq(accountingDocumentVersionsTable.billingDocumentId, documentId))
    .orderBy(asc(accountingDocumentVersionsTable.version));
  const events = await db
    .select()
    .from(accountingLifecycleEventsTable)
    .where(eq(accountingLifecycleEventsTable.billingDocumentId, documentId))
    .orderBy(asc(accountingLifecycleEventsTable.sequence));
  const versionIds = versions.map((row) => row.id);
  const relations = versionIds.length
    ? await db
        .select()
        .from(accountingVersionRelationsTable)
        .where(
          inArray(accountingVersionRelationsTable.sourceVersionId, versionIds),
        )
    : [];
  const reasons = await db
    .select()
    .from(accountingReasonArtifactsTable)
    .where(eq(accountingReasonArtifactsTable.billingDocumentId, documentId));
  const intentIds = [
    ...versions.map((row) => row.id),
    ...events.map((row) => row.id),
    ...relations.map((row) => row.id),
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
  return { versions, events, reasons, relations, outbox, heads };
}

async function installOutboxRejector(): Promise<void> {
  await pool.query(`
    CREATE FUNCTION test_reject_cost_correction_outbox()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'test cost correction outbox rejection';
    END;
    $$;
    CREATE TRIGGER test_reject_cost_correction_outbox_trigger
    BEFORE INSERT ON accounting_export_outbox
    FOR EACH ROW EXECUTE FUNCTION test_reject_cost_correction_outbox();
  `);
}

async function removeOutboxRejector(): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS test_reject_cost_correction_outbox_trigger
      ON accounting_export_outbox;
    DROP FUNCTION IF EXISTS test_reject_cost_correction_outbox();
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
  delete process.env[CORRECTION_FLAG];
  await removeOutboxRejector();
});

afterAll(() => {
  delete process.env[APPROVAL_FLAG];
  delete process.env[CORRECTION_FLAG];
});

describe("cost-document correction accounting dual-write seam", () => {
  it("preserves version one and appends reopen plus corrected version two", async () => {
    const document = await createReviewDocument("success");
    process.env[APPROVAL_FLAG] = "true";
    process.env[CORRECTION_FLAG] = "true";

    await approveDocument(document.id, actor);
    await setDocumentStatus(
      document.id,
      "needs_review",
      actor,
      "Doklad patří k jiné zakázce",
    );
    await db
      .update(billingDocumentLinesTable)
      .set({ description: "Corrected service" })
      .where(eq(billingDocumentLinesTable.documentId, document.id));
    await expect(deleteDocument(document.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
    await approveDocument(document.id, actor);

    const rows = await evidenceRows(document.id);
    expect(rows.versions).toHaveLength(2);
    expect(rows.events).toHaveLength(3);
    expect(rows.reasons).toHaveLength(1);
    expect(rows.relations).toHaveLength(1);
    expect(rows.outbox).toHaveLength(4);
    const versions = rows.versions.map((row) =>
      verifyCanonicalAccountingDocumentVersionJsonBytes(row.canonicalJson),
    );
    const events = rows.events.map((row) =>
      verifyCanonicalAccountingLifecycleEntryJsonBytes(row.canonicalJson),
    );
    expect(versions[0]).toMatchObject({ version: "1", purpose: "approved" });
    expect(versions[1]).toMatchObject({
      version: "2",
      purpose: "correction",
      supersedesVersionId: versions[0]!.versionId,
      snapshot: {
        lines: [expect.objectContaining({ description: "Corrected service" })],
      },
    });
    expect(
      events.map((event) => ("eventType" in event ? event.eventType : null)),
    ).toEqual(["approved", "review_reopened", "correction_linked"]);
    expect(
      verifyCanonicalAccountingReasonArtifactJsonBytes(
        rows.reasons[0]!.canonicalJson,
      ),
    ).toMatchObject({
      aggregate: {
        kind: "incoming-cost-document",
        id: String(document.id),
        versionId: versions[0]!.versionId,
      },
      lifecycleEvent: {
        eventId: events[1]!.eventId,
        eventSha256: events[1]!.integrity.entrySha256,
      },
      reason: {
        code: "review_reopened",
        text: "Doklad patří k jiné zakázce",
        textSha256: events[1]!.reasonDetailSha256,
      },
      accessPolicy: {
        mode: "restricted",
        listing: "metadata-only",
        plaintextExport: "authorized-audit-only",
      },
    });
    expect(
      rows.outbox.find((row) => row.operation === "reason-artifact"),
    ).toMatchObject({
      intentId: rows.reasons[0]!.id,
      state: "pending",
    });
    expect(rows.relations[0]).toMatchObject({
      relationType: "supersedes",
      sourceVersionId: versions[1]!.versionId,
      targetVersionId: versions[0]!.versionId,
    });
    expect(rows.heads[0]).toMatchObject({
      revision: 3n,
      versionHeadVersion: 2n,
      versionHeadId: versions[1]!.versionId,
      lifecycleHeadSequence: 2n,
    });
    const auditRows = await db
      .select({ summary: auditLogTable.summary })
      .from(auditLogTable)
      .where(eq(auditLogTable.entityId, document.id));
    expect(auditRows).toContainEqual({
      summary: "status:approved->needs_review",
    });
    expect(
      auditRows.every(
        (row) => !row.summary.includes(rows.reasons[0]!.reasonText),
      ),
    ).toBe(true);

    await approveDocument(document.id, actor);
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [expect.anything(), expect.anything()],
      events: [expect.anything(), expect.anything(), expect.anything()],
      reasons: [expect.anything()],
      relations: [expect.anything()],
      outbox: [
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    });
  });

  it("rolls back reopen and correction projections when outbox insertion fails", async () => {
    const document = await createReviewDocument("rollback");
    process.env[APPROVAL_FLAG] = "true";
    process.env[CORRECTION_FLAG] = "true";
    await approveDocument(document.id, actor);

    await installOutboxRejector();
    await expect(
      setDocumentStatus(
        document.id,
        "needs_review",
        actor,
        "Oprava údajů dodavatele",
      ),
    ).rejects.toThrow(/accounting_export_outbox/i);
    await removeOutboxRejector();
    expect(
      await db
        .select({ status: billingDocumentsTable.status })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, document.id)),
    ).toEqual([{ status: "approved" }]);
    expect((await evidenceRows(document.id)).events).toHaveLength(1);
    expect((await evidenceRows(document.id)).reasons).toHaveLength(0);

    await setDocumentStatus(
      document.id,
      "needs_review",
      actor,
      "Oprava údajů dodavatele",
    );
    await db
      .update(billingDocumentLinesTable)
      .set({ description: "Corrected after retry" })
      .where(eq(billingDocumentLinesTable.documentId, document.id));

    await installOutboxRejector();
    await expect(approveDocument(document.id, actor)).rejects.toThrow(
      /accounting_export_outbox/i,
    );
    await removeOutboxRejector();
    expect(
      await db
        .select({ status: billingDocumentsTable.status })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, document.id)),
    ).toEqual([{ status: "needs_review" }]);
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [expect.anything()],
      events: [expect.anything(), expect.anything()],
      reasons: [expect.anything()],
      relations: [],
    });

    await approveDocument(document.id, actor);
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [expect.anything(), expect.anything()],
      events: [expect.anything(), expect.anything(), expect.anything()],
      reasons: [expect.anything()],
      relations: [expect.anything()],
    });
  });

  it("requires a normalized reason and keeps the legacy cutover dark", async () => {
    const document = await createReviewDocument("guard");
    process.env[APPROVAL_FLAG] = "true";
    await approveDocument(document.id, actor);

    await expect(
      setDocumentStatus(document.id, "needs_review", actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    process.env[CORRECTION_FLAG] = "true";
    await expect(
      setDocumentStatus(document.id, "needs_review", actor, "  "),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await evidenceRows(document.id)).events).toHaveLength(1);
  });

  it("fails closed when correction is enabled without approval evidence", async () => {
    const document = await createReviewDocument("misconfigured");
    process.env[CORRECTION_FLAG] = "true";
    await expect(
      setDocumentStatus(document.id, "reviewed", actor),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await evidenceRows(document.id)).toMatchObject({
      versions: [],
      events: [],
      relations: [],
      outbox: [],
    });
  });

  it("preserves existing warehouse price history by refusing an unsafe reopen", async () => {
    const document = await createReviewDocument("warehouse-history");
    process.env[APPROVAL_FLAG] = "true";
    process.env[CORRECTION_FLAG] = "true";
    await approveDocument(document.id, actor);
    const [line] = await db
      .select({ id: billingDocumentLinesTable.id })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, document.id));
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `History item ${TAG}`, quantity: "0" })
      .returning({ id: warehouseItemsTable.id });
    const [history] = await db
      .insert(warehousePriceHistoryTable)
      .values({
        warehouseItemId: item!.id,
        billingDocumentId: document.id,
        billingDocumentLineId: line!.id,
        purchasePrice: "100.00",
        currency: "CZK",
      })
      .returning({ id: warehousePriceHistoryTable.id });

    await expect(
      setDocumentStatus(
        document.id,
        "needs_review",
        actor,
        "Oprava nákupní ceny",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await db
        .select({ status: billingDocumentsTable.status })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, document.id)),
    ).toEqual([{ status: "approved" }]);
    expect(
      await db
        .select({ id: warehousePriceHistoryTable.id })
        .from(warehousePriceHistoryTable)
        .where(eq(warehousePriceHistoryTable.id, history!.id)),
    ).toEqual([{ id: history!.id }]);
    expect((await evidenceRows(document.id)).events).toHaveLength(1);
  });
});
