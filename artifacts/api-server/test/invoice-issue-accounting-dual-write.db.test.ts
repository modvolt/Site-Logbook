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
import { eq } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  billingSettingsTable,
  customersTable,
  db,
  invoicesTable,
  pool,
  usersTable,
} from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { createDraft, issueInvoice } from "../src/lib/invoice-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import {
  verifyAccountingLifecycleEventBinding,
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
} from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "../src/lib/accounting-persistence-contract";
import { sha256Hex } from "../src/lib/evidence-hash";

const FEATURE_FLAG = "ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED";
const TAG = `test-accounting-issue-${Date.now()}`;

let customerId = 0;
const actor = { userId: 0, name: "Accounting Issue Test" };
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
          description: `Accounting evidence ${label}`,
          quantity: 2,
          unit: "ks",
          unitPriceWithoutVat: 50,
          vatRate: 21,
          vatMode: "standard",
        },
      ],
    },
    actor,
  );
}

async function evidenceRows(invoiceId: number) {
  const versions = await db
    .select()
    .from(accountingDocumentVersionsTable)
    .where(eq(accountingDocumentVersionsTable.invoiceId, invoiceId));
  const events = await db
    .select()
    .from(accountingLifecycleEventsTable)
    .where(eq(accountingLifecycleEventsTable.invoiceId, invoiceId));
  const heads = await db
    .select()
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.invoiceId, invoiceId));
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
  delete process.env[FEATURE_FLAG];
  putPrivateObjectSpy.mockClear();
});

afterAll(() => {
  delete process.env[FEATURE_FLAG];
  vi.restoreAllMocks();
});

describe("issueInvoice accounting dual-write seam", () => {
  it("persists one strict version, issued event, aggregate head and export intent", async () => {
    const draft = await draftInvoice("success");
    process.env[FEATURE_FLAG] = "true";

    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");
    expect(issued.pdfObjectPath).toBeTruthy();
    const rows = await evidenceRows(draft.id);
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

    const upload = putPrivateObjectSpy.mock.calls.find(
      ([path]) => path === issued.pdfObjectPath,
    );
    expect(upload).toBeDefined();
    const uploadedPdf = upload![1] as Buffer;
    expect(version.artifacts[0]).toMatchObject({
      role: "rendered-pdf",
      contentSha256: sha256Hex(uploadedPdf),
      sizeBytes: String(uploadedPdf.length),
    });

    await expect(issueInvoice(draft.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
    const replayRows = await evidenceRows(draft.id);
    expect(replayRows.versions).toHaveLength(1);
    expect(replayRows.events).toHaveLength(1);
    expect(replayRows.outbox).toHaveLength(1);
  });

  it("rolls back invoice numbering and writes no PDF when evidence persistence fails", async () => {
    const draft = await draftInvoice("rollback");
    const [settingsBefore] = await db
      .select({ next: billingSettingsTable.numberNextSeq })
      .from(billingSettingsTable)
      .where(eq(billingSettingsTable.id, 1));
    process.env[FEATURE_FLAG] = "true";
    await pool.query(`
      CREATE FUNCTION test_reject_accounting_export_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test accounting export rejection';
      END;
      $$;
      CREATE TRIGGER test_reject_accounting_export_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_accounting_export_outbox();
    `);
    try {
      await expect(issueInvoice(draft.id, actor)).rejects.toThrow(
        /accounting_export_outbox/i,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_reject_accounting_export_outbox_trigger
          ON accounting_export_outbox;
        DROP FUNCTION IF EXISTS test_reject_accounting_export_outbox();
      `);
    }

    const [invoiceAfter] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draft.id));
    const [settingsAfter] = await db
      .select({ next: billingSettingsTable.numberNextSeq })
      .from(billingSettingsTable)
      .where(eq(billingSettingsTable.id, 1));
    expect(invoiceAfter).toMatchObject({
      status: "draft",
      invoiceNumber: null,
      issuedAt: null,
      pdfObjectPath: null,
    });
    expect(settingsAfter?.next).toBe(settingsBefore?.next);
    expect(await evidenceRows(draft.id)).toMatchObject({
      versions: [],
      events: [],
      heads: [],
      outbox: [],
    });
    expect(putPrivateObjectSpy).not.toHaveBeenCalled();

    const retried = await issueInvoice(draft.id, actor);
    expect(retried.status).toBe("issued");
    const [settingsRetried] = await db
      .select({ next: billingSettingsTable.numberNextSeq })
      .from(billingSettingsTable)
      .where(eq(billingSettingsTable.id, 1));
    expect(settingsRetried?.next).toBe((settingsBefore?.next ?? 0) + 1);
    expect((await evidenceRows(draft.id)).versions).toHaveLength(1);
  });

  it("preserves the legacy issue path when the feature flag is dark", async () => {
    const draft = await draftInvoice("disabled");
    process.env[FEATURE_FLAG] = "false";
    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");
    expect(await evidenceRows(draft.id)).toMatchObject({
      versions: [],
      events: [],
      heads: [],
      outbox: [],
    });
    expect(putPrivateObjectSpy).toHaveBeenCalledTimes(1);
  });
});
