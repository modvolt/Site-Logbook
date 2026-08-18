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
  accountingPaymentEventsTable,
  customersTable,
  db,
  invoicesTable,
  pool,
  usersTable,
} from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  confirmBankPayments,
  createDraft,
  issueInvoice,
  updateInvoiceStatus,
} from "../src/lib/invoice-service";
import { verifyCanonicalAccountingDocumentVersionJsonBytes } from "../src/lib/accounting-document-version-contract";
import {
  verifyAccountingLifecycleEventBinding,
  verifyAccountingPaymentEventBinding,
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
  type AccountingLifecycleEventV1,
  type AccountingPaymentEventV1,
} from "../src/lib/accounting-lifecycle-event-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "../src/lib/accounting-persistence-contract";

const ISSUE_FLAG = "ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED";
const STATUS_FLAG = "ACCOUNTING_INVOICE_STATUS_DUAL_WRITE_ENABLED";
const BANK_FLAG = "ACCOUNTING_BANK_PAYMENT_DUAL_WRITE_ENABLED";
const TAG = `test-invoice-status-payment-accounting-${Date.now()}`;

let customerId = 0;
const actor = { userId: 0, name: "Invoice Status Payment Test" };

async function issueTestInvoice(label: string, withEvidence = true) {
  const draft = await createDraft(
    {
      customerId,
      issueDate: "2042-03-04",
      taxableSupplyDate: "2042-03-04",
      dueDate: "2042-03-18",
      paymentMethod: "bank",
      lines: [
        {
          sourceType: "manual",
          description: `Status payment evidence ${label}`,
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
  process.env[ISSUE_FLAG] = withEvidence ? "true" : "false";
  try {
    return await issueInvoice(draft.id, actor);
  } finally {
    delete process.env[ISSUE_FLAG];
  }
}

async function evidenceRows(invoiceId: number) {
  const versions = await db
    .select()
    .from(accountingDocumentVersionsTable)
    .where(eq(accountingDocumentVersionsTable.invoiceId, invoiceId));
  const lifecycle = (
    await db
      .select()
      .from(accountingLifecycleEventsTable)
      .where(eq(accountingLifecycleEventsTable.invoiceId, invoiceId))
  ).sort((left, right) => Number(left.sequence - right.sequence));
  const payments = (
    await db
      .select()
      .from(accountingPaymentEventsTable)
      .where(eq(accountingPaymentEventsTable.invoiceId, invoiceId))
  ).sort((left, right) => Number(left.sequence - right.sequence));
  const heads = await db
    .select()
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.invoiceId, invoiceId));
  const intentIds = [
    ...versions.map((row) => row.id),
    ...lifecycle.map((row) => row.id),
    ...payments.map((row) => row.id),
  ];
  const outbox =
    intentIds.length === 0
      ? []
      : await db
          .select()
          .from(accountingExportOutboxTable)
          .where(inArray(accountingExportOutboxTable.intentId, intentIds));
  return { versions, lifecycle, payments, heads, outbox };
}

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
  vi.spyOn(
    ObjectStorageService.prototype,
    "putPrivateObject",
  ).mockResolvedValue();
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
  delete process.env[STATUS_FLAG];
  delete process.env[BANK_FLAG];
});

afterAll(() => {
  delete process.env[ISSUE_FLAG];
  delete process.env[STATUS_FLAG];
  delete process.env[BANK_FLAG];
  vi.restoreAllMocks();
});

describe("invoice status and payment accounting dual-write seams", () => {
  it("appends sent lifecycle and manual payment evidence without changing the version", async () => {
    const issued = await issueTestInvoice("manual-success");
    process.env[STATUS_FLAG] = "true";

    await expect(
      updateInvoiceStatus(issued.id, { status: "sent" }, actor),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      updateInvoiceStatus(issued.id, { status: "sent" }, actor),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      updateInvoiceStatus(
        issued.id,
        { status: "paid", paidDate: "2042-03-10", paidAmount: 121 },
        actor,
      ),
    ).resolves.toMatchObject({
      status: "paid",
      paidDate: "2042-03-10",
      paidAmount: 121,
    });
    await expect(
      updateInvoiceStatus(
        issued.id,
        { status: "paid", paidDate: "2042-03-10", paidAmount: 121 },
        actor,
      ),
    ).resolves.toMatchObject({ status: "paid" });

    const rows = await evidenceRows(issued.id);
    expect(rows.versions).toHaveLength(1);
    expect(rows.lifecycle).toHaveLength(2);
    expect(rows.payments).toHaveLength(1);
    expect(rows.outbox).toHaveLength(3);
    expect(rows.heads[0]).toMatchObject({
      revision: 3n,
      versionHeadId: rows.versions[0]!.id,
      lifecycleHeadId: rows.lifecycle[1]!.id,
      paymentHeadId: rows.payments[0]!.id,
    });

    const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[0]!.canonicalJson,
    );
    const sent = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.lifecycle[1]!.canonicalJson,
    ) as AccountingLifecycleEventV1;
    const payment = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.payments[0]!.canonicalJson,
    ) as AccountingPaymentEventV1;
    expect(() =>
      verifyAccountingLifecycleEventBinding(sent, version),
    ).not.toThrow();
    expect(() =>
      verifyAccountingPaymentEventBinding(payment, version),
    ).not.toThrow();
    expect(sent).toMatchObject({
      eventType: "sent",
      sequence: "1",
      previousEventSha256: rows.lifecycle[0]!.entrySha256,
    });
    expect(payment).toMatchObject({
      eventType: "received",
      sequence: "0",
      source: "manual",
      sourceRefSha256: null,
      amountDelta: "121",
      occurredOn: "2042-03-10",
    });
    expect(
      rows.outbox.map((row) =>
        verifyCanonicalAccountingExportIntentJsonBytes(row.canonicalJson),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "lifecycle-event" }),
        expect.objectContaining({ operation: "payment-event" }),
      ]),
    );
  });

  it("rolls a manual payment projection and event back together on outbox failure", async () => {
    const issued = await issueTestInvoice("manual-fault");
    process.env[STATUS_FLAG] = "true";
    await pool.query(`
      CREATE FUNCTION test_reject_status_payment_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test status payment export rejection';
      END;
      $$;
      CREATE TRIGGER test_reject_status_payment_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_status_payment_outbox();
    `);
    try {
      await expect(
        updateInvoiceStatus(
          issued.id,
          { status: "paid", paidDate: "2042-03-11", paidAmount: 121 },
          actor,
        ),
      ).rejects.toThrow(/accounting_export_outbox/i);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_reject_status_payment_outbox_trigger
          ON accounting_export_outbox;
        DROP FUNCTION IF EXISTS test_reject_status_payment_outbox();
      `);
    }
    const [unchanged] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, issued.id));
    expect(unchanged).toMatchObject({
      status: "issued",
      paidDate: null,
      paidAmount: null,
    });
    expect((await evidenceRows(issued.id)).payments).toHaveLength(0);

    await expect(
      updateInvoiceStatus(
        issued.id,
        { status: "paid", paidDate: "2042-03-11", paidAmount: 121 },
        actor,
      ),
    ).resolves.toMatchObject({ status: "paid" });
    expect((await evidenceRows(issued.id)).payments).toHaveLength(1);
  });

  it("records bank-import provenance as a hash and one payment event", async () => {
    const issued = await issueTestInvoice("bank-success");
    process.env[BANK_FLAG] = "true";
    const result = await confirmBankPayments(
      [
        {
          invoiceId: issued.id,
          amount: 121,
          variableSymbol: issued.variableSymbol,
          counterparty: "Customer Bank Account",
          paymentDate: "2042-03-12",
        },
      ],
      actor,
    );
    expect(result).toEqual({ paidCount: 1, skipped: [] });
    const rows = await evidenceRows(issued.id);
    expect(rows.payments).toHaveLength(1);
    expect(rows.outbox).toHaveLength(2);
    const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
      rows.versions[0]!.canonicalJson,
    );
    const payment = verifyCanonicalAccountingLifecycleEntryJsonBytes(
      rows.payments[0]!.canonicalJson,
    ) as AccountingPaymentEventV1;
    expect(() =>
      verifyAccountingPaymentEventBinding(payment, version),
    ).not.toThrow();
    expect(payment).toMatchObject({
      source: "bank_import",
      reasonCode: "payment_imported",
      amountDelta: "121",
      occurredOn: "2042-03-12",
    });
    expect(payment.sourceRefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.payments[0]!.canonicalJson).not.toContain(
      "Customer Bank Account",
    );
    expect(rows.heads[0]).toMatchObject({ revision: 2n });
  });

  it("rolls an ordered multi-invoice bank batch back when a later outbox append fails", async () => {
    const first = await issueTestInvoice("bank-batch-first");
    const second = await issueTestInvoice("bank-batch-second");
    expect(first.id).toBeLessThan(second.id);
    process.env[BANK_FLAG] = "true";
    await pool.query(`
      CREATE FUNCTION test_reject_second_bank_payment_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.canonical_json::jsonb #>> '{affectedAggregates,0,id}' = '${second.id}' THEN
          RAISE EXCEPTION 'test second bank payment export rejection';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_reject_second_bank_payment_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_second_bank_payment_outbox();
    `);
    const reversedInput = [second, first].map((invoice) => ({
      invoiceId: invoice.id,
      amount: 121,
      variableSymbol: invoice.variableSymbol,
      counterparty: `Batch payer ${invoice.id}`,
      paymentDate: "2042-03-12",
    }));
    try {
      await expect(confirmBankPayments(reversedInput, actor)).rejects.toThrow(
        /accounting_export_outbox/i,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_reject_second_bank_payment_outbox_trigger
          ON accounting_export_outbox;
        DROP FUNCTION IF EXISTS test_reject_second_bank_payment_outbox();
      `);
    }
    for (const invoice of [first, second]) {
      const [stored] = await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id));
      expect(stored).toMatchObject({
        status: "issued",
        paidDate: null,
        paidAmount: null,
      });
      expect((await evidenceRows(invoice.id)).payments).toHaveLength(0);
    }

    await expect(confirmBankPayments(reversedInput, actor)).resolves.toEqual({
      paidCount: 2,
      skipped: [],
    });
    expect((await evidenceRows(first.id)).payments).toHaveLength(1);
    expect((await evidenceRows(second.id)).payments).toHaveLength(1);
  });

  it("refuses to fabricate status/payment history for legacy or lifecycle-drifted invoices", async () => {
    const legacy = await issueTestInvoice("legacy", false);
    process.env[STATUS_FLAG] = "true";
    await expect(
      updateInvoiceStatus(legacy.id, { status: "sent" }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    process.env[BANK_FLAG] = "true";
    const skipped = await confirmBankPayments(
      [{ invoiceId: legacy.id, amount: 121, paymentDate: "2042-03-13" }],
      actor,
    );
    expect(skipped).toMatchObject({ paidCount: 0 });
    expect(skipped.skipped[0]?.reason).toMatch(/legacy backfill/i);

    const drifted = await issueTestInvoice("lifecycle-drift");
    delete process.env[STATUS_FLAG];
    await updateInvoiceStatus(drifted.id, { status: "sent" }, actor);
    process.env[BANK_FLAG] = "true";
    await expect(
      confirmBankPayments(
        [{ invoiceId: drifted.id, amount: 121, paymentDate: "2042-03-13" }],
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const [stillSent] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, drifted.id));
    expect(stillSent).toMatchObject({ status: "sent", paidDate: null });
  });

  it("preserves both legacy status paths while their exact gates are dark", async () => {
    const manual = await issueTestInvoice("manual-dark", false);
    process.env[STATUS_FLAG] = "false";
    await expect(
      updateInvoiceStatus(
        manual.id,
        { status: "paid", paidDate: "2042-03-14", paidAmount: 121 },
        actor,
      ),
    ).resolves.toMatchObject({ status: "paid" });
    expect((await evidenceRows(manual.id)).payments).toHaveLength(0);

    const bank = await issueTestInvoice("bank-dark", false);
    process.env[BANK_FLAG] = "false";
    await expect(
      confirmBankPayments(
        [{ invoiceId: bank.id, amount: 121, paymentDate: "2042-03-14" }],
        actor,
      ),
    ).resolves.toEqual({ paidCount: 1, skipped: [] });
    expect((await evidenceRows(bank.id)).payments).toHaveLength(0);
  });
});
