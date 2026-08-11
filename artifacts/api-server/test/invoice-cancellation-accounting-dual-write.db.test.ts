import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { eq, inArray } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  accountingVersionRelationsTable,
  customersTable,
  db,
  invoicesTable,
  pool,
  usersTable,
} from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  cancelInvoice,
  createDraft,
  issueInvoice,
} from "../src/lib/invoice-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import {
  verifyAccountingCorrectionChainBinding,
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
  type AccountingLifecycleEventV1,
  type AccountingVersionRelationV1,
} from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "../src/lib/accounting-persistence-contract";
import { sha256Hex } from "../src/lib/evidence-hash";

const ISSUE_FLAG = "ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED";
const CANCEL_FLAG = "ACCOUNTING_CANCEL_INVOICE_DUAL_WRITE_ENABLED";
const TAG = `test-invoice-cancellation-accounting-${Date.now()}`;

let customerId = 0;
const actor = { userId: 0, name: "Invoice Cancellation Test" };
let putPrivateObjectSpy: ReturnType<typeof vi.spyOn>;

async function draftInvoice(label: string) {
  return createDraft(
    {
      customerId,
      issueDate: "2042-03-04",
      taxableSupplyDate: "2042-03-04",
      dueDate: "2042-03-18",
      paymentMethod: "bank",
      lines: [
        {
          sourceType: "manual",
          description: `Cancellation evidence ${label}`,
          quantity: 1,
          unit: "ks",
          unitPriceWithoutVat: 100,
          vatRate: 21,
          vatMode: "standard",
        },
      ],
    },
    actor,
  );
}

async function issueDraft(label: string, withEvidence: boolean) {
  const draft = await draftInvoice(label);
  process.env[ISSUE_FLAG] = withEvidence ? "true" : "false";
  const issued = await issueInvoice(draft.id, actor);
  delete process.env[ISSUE_FLAG];
  putPrivateObjectSpy.mockClear();
  return issued;
}

async function evidenceRows(invoiceId: number) {
  const versions = (
    await db
      .select()
      .from(accountingDocumentVersionsTable)
      .where(eq(accountingDocumentVersionsTable.invoiceId, invoiceId))
  ).sort((left, right) => Number(left.version - right.version));
  const events = (
    await db
      .select()
      .from(accountingLifecycleEventsTable)
      .where(eq(accountingLifecycleEventsTable.invoiceId, invoiceId))
  ).sort((left, right) => Number(left.sequence - right.sequence));
  const versionIds = versions.map((version) => version.id);
  const relations =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(accountingVersionRelationsTable)
          .where(
            inArray(
              accountingVersionRelationsTable.sourceVersionId,
              versionIds,
            ),
          );
  const intentIds = [
    ...(versions[0] ? [versions[0].id] : []),
    ...relations.map((relation) => relation.id),
  ];
  const outbox =
    intentIds.length === 0
      ? []
      : await db
          .select()
          .from(accountingExportOutboxTable)
          .where(inArray(accountingExportOutboxTable.intentId, intentIds));
  const heads = await db
    .select()
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.invoiceId, invoiceId));
  return { versions, events, relations, outbox, heads };
}

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
  putPrivateObjectSpy = vi
    .spyOn(ObjectStorageService.prototype, "putPrivateObject")
    .mockResolvedValue();
  vi.spyOn(
    ObjectStorageService.prototype,
    "deletePrivateObject",
  ).mockResolvedValue();
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
  const [customer] = await db
    .insert(customersTable)
    .values({
      companyName: `Customer ${TAG}`,
      ic: "12345678",
      dic: "CZ12345678",
      address: "Dlouhá 1, Praha",
      email: "customer@example.test",
    })
    .returning({ id: customersTable.id });
  customerId = customer!.id;
});

afterEach(() => {
  delete process.env[ISSUE_FLAG];
  delete process.env[CANCEL_FLAG];
  putPrivateObjectSpy.mockClear();
});

afterAll(() => {
  delete process.env[ISSUE_FLAG];
  delete process.env[CANCEL_FLAG];
  vi.restoreAllMocks();
});

describe("cancelInvoice accounting dual-write seam", () => {
  it("appends version-two cancellation PDF, void relation/event and one export intent", async () => {
    const issued = await issueDraft("success", true);
    process.env[CANCEL_FLAG] = "true";

    const cancelled = await cancelInvoice(
      issued.id,
      { returnJobsToDone: false, reasonCode: "incorrect_job" },
      actor,
    );
    expect(cancelled.status).toBe("cancelled");
    const rows = await evidenceRows(issued.id);
    expect(rows.versions).toHaveLength(2);
    expect(rows.events).toHaveLength(2);
    expect(rows.relations).toHaveLength(1);
    expect(rows.outbox).toHaveLength(2);
    expect(rows.heads).toHaveLength(1);

    const target = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[0]!.canonicalJson,
    );
    const source = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[1]!.canonicalJson,
    );
    const event = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.events[1]!.canonicalJson,
    ) as AccountingLifecycleEventV1;
    const relation = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.relations[0]!.canonicalJson,
    ) as AccountingVersionRelationV1;
    expect(() =>
      verifyAccountingCorrectionChainBinding(relation, event, source, target),
    ).not.toThrow();
    expect(source).toMatchObject({
      version: "2",
      purpose: "cancellation_notice",
      supersedesVersionId: target.versionId,
    });
    expect(relation).toMatchObject({
      relationType: "voids",
      reasonCode: "incorrect_job",
    });
    expect(event).toMatchObject({
      eventType: "void_confirmed",
      sequence: "1",
      previousEventSha256: rows.events[0]!.entrySha256,
    });
    expect(rows.heads[0]).toMatchObject({
      revision: 2n,
      versionHeadId: source.versionId,
      lifecycleHeadId: event.eventId,
    });
    const correctionIntent = rows.outbox
      .map((row) =>
        verifyCanonicalAccountingExportIntentJsonBytes(row.canonicalJson),
      )
      .find((intent) => intent.operation === "correction-bundle");
    expect(correctionIntent?.entries.map((entry) => entry.kind)).toEqual([
      "document-version",
      "lifecycle-event",
      "version-relation",
    ]);

    expect(putPrivateObjectSpy).toHaveBeenCalledTimes(1);
    const [path, bytes, mediaType] = putPrivateObjectSpy.mock.calls[0]!;
    expect(path).toMatch(/\.cancellation-v2-[0-9a-f]{24}\.pdf$/);
    expect(mediaType).toBe("application/pdf");
    expect(source.artifacts[0]).toMatchObject({
      contentSha256: sha256Hex(bytes as Buffer),
      sizeBytes: String((bytes as Buffer).length),
      rendererVersion: "invoice-cancellation-pdf/v1",
    });

    await expect(
      cancelInvoice(
        issued.id,
        { returnJobsToDone: false, reasonCode: "incorrect_job" },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await evidenceRows(issued.id)).versions).toHaveLength(2);
  });

  it("rolls back status and the whole cancellation bundle before PDF upload on outbox failure", async () => {
    const issued = await issueDraft("rollback", true);
    process.env[CANCEL_FLAG] = "true";
    await pool.query(`
      CREATE FUNCTION test_reject_cancellation_export_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test cancellation export rejection';
      END;
      $$;
      CREATE TRIGGER test_reject_cancellation_export_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_cancellation_export_outbox();
    `);
    try {
      await expect(
        cancelInvoice(
          issued.id,
          { returnJobsToDone: false, reasonCode: "customer_complaint" },
          actor,
        ),
      ).rejects.toThrow(/accounting_export_outbox/i);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_reject_cancellation_export_outbox_trigger
          ON accounting_export_outbox;
        DROP FUNCTION IF EXISTS test_reject_cancellation_export_outbox();
      `);
    }

    const [invoiceAfter] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, issued.id));
    expect(invoiceAfter).toMatchObject({ status: "issued", cancelledAt: null });
    expect(await evidenceRows(issued.id)).toMatchObject({
      versions: [expect.anything()],
      events: [expect.anything()],
      relations: [],
      outbox: [expect.anything()],
      heads: [expect.objectContaining({ revision: 1n })],
    });
    expect(putPrivateObjectSpy).not.toHaveBeenCalled();

    await expect(
      cancelInvoice(
        issued.id,
        { returnJobsToDone: false, reasonCode: "customer_complaint" },
        actor,
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect((await evidenceRows(issued.id)).versions).toHaveLength(2);
    expect(putPrivateObjectSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to fabricate a native void chain for an issued legacy invoice", async () => {
    const issued = await issueDraft("legacy-block", false);
    process.env[CANCEL_FLAG] = "true";
    await expect(
      cancelInvoice(
        issued.id,
        { returnJobsToDone: false, reasonCode: "billing_error" },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const [unchanged] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, issued.id));
    expect(unchanged).toMatchObject({ status: "issued", cancelledAt: null });
    expect(await evidenceRows(issued.id)).toMatchObject({
      versions: [],
      events: [],
      relations: [],
      outbox: [],
      heads: [],
    });
    expect(putPrivateObjectSpy).not.toHaveBeenCalled();
  });

  it("preserves the existing cancellation path while the new gate is dark", async () => {
    const issued = await issueDraft("disabled", false);
    process.env[CANCEL_FLAG] = "false";
    await expect(
      cancelInvoice(
        issued.id,
        { returnJobsToDone: false, reasonCode: "order_cancelled" },
        actor,
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(await evidenceRows(issued.id)).toMatchObject({
      versions: [],
      events: [],
      relations: [],
      outbox: [],
      heads: [],
    });
    expect(putPrivateObjectSpy).not.toHaveBeenCalled();
  });
});
