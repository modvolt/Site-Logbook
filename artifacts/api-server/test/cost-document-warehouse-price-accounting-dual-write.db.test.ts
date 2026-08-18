import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { asc, eq, inArray } from "drizzle-orm";
import {
  accountingExportOutboxTable,
  accountingWarehousePriceObservationsTable,
  accountingWarehousePriceProjectionHeadsTable,
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
  setDocumentStatus,
  updateWarehousePricesFromDocument,
} from "../src/lib/cost-document-service";
import { accountingWarehousePriceObservationFromRow } from "../src/lib/accounting-persistence-db-adapter";
import { verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes } from "../src/lib/accounting-warehouse-price-projection-head";

const APPROVAL_FLAG = "ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED";
const CORRECTION_FLAG =
  "ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED";
const PRICE_FLAG = "ACCOUNTING_WAREHOUSE_PRICE_DUAL_WRITE_ENABLED";
const TAG = `test-cost-warehouse-price-accounting-${Date.now()}`;
const FILE_HASH = "d".repeat(64);
const actor = { userId: 0, name: "Warehouse Price Accounting Test" };

async function createReviewDocument(input: {
  label: string;
  currency?: string;
  unitPrice?: string;
}) {
  const unitPrice = input.unitPrice ?? "10.00";
  const subtotal = String(Number(unitPrice) * 10);
  const vat = String(Number(subtotal) * 0.21);
  const total = String(Number(subtotal) + Number(vat));
  const sku = `SKU-${input.label}-${TAG}`;
  const [document] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "needs_review",
      docType: "receipt",
      docTypeSource: "admin",
      source: "manual",
      supplierName: `Supplier ${input.label} ${TAG}`,
      documentNumber: `PF-${input.label}-${TAG}`,
      issueDate: "2042-08-11",
      taxableSupplyDate: "2042-08-11",
      currency: input.currency ?? "CZK",
      subtotalWithoutVat: subtotal,
      totalVat: vat,
      totalWithVat: total,
      createdByUserId: actor.userId,
    })
    .returning();
  const [line] = await db
    .insert(billingDocumentLinesTable)
    .values({
      documentId: document!.id,
      lineType: "material",
      description: `Cable ${input.label} ${TAG}`,
      quantity: "10.00",
      unit: "m",
      unitPriceWithoutVat: unitPrice,
      vatRate: "21.00",
      vatMode: "standard",
      totalWithoutVat: subtotal,
      totalVat: vat,
      totalWithVat: total,
      supplierSku: sku,
      allocationType: "internal",
      matchConfirmed: 0,
      approved: 0,
    })
    .returning();
  await db.insert(billingDocumentFilesTable).values({
    documentId: document!.id,
    role: "primary",
    originalFileName: `${input.label}.pdf`,
    mimeType: "application/pdf",
    objectPath: `/objects/cost/${document!.id}/${input.label}.pdf`,
    sha256Hash: FILE_HASH,
    sizeBytes: 2048,
  });
  const [item] = await db
    .insert(warehouseItemsTable)
    .values({
      name: `Warehouse ${input.label} ${TAG}`,
      supplierSku: sku,
      quantity: "0",
      purchasePrice: null,
    })
    .returning();
  return { document: document!, line: line!, item: item! };
}

async function priceRows(documentId: number, warehouseItemId: number) {
  const observations = await db
    .select()
    .from(accountingWarehousePriceObservationsTable)
    .where(
      eq(
        accountingWarehousePriceObservationsTable.billingDocumentId,
        documentId,
      ),
    )
    .orderBy(asc(accountingWarehousePriceObservationsTable.sequence));
  const history = await db
    .select()
    .from(warehousePriceHistoryTable)
    .where(eq(warehousePriceHistoryTable.billingDocumentId, documentId));
  const projection = await db
    .select()
    .from(accountingWarehousePriceProjectionHeadsTable)
    .where(
      eq(
        accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
        warehouseItemId,
      ),
    );
  const [item] = await db
    .select({ purchasePrice: warehouseItemsTable.purchasePrice })
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, warehouseItemId));
  const outbox =
    observations.length === 0
      ? []
      : await db
          .select()
          .from(accountingExportOutboxTable)
          .where(
            inArray(
              accountingExportOutboxTable.intentId,
              observations.map((row) => row.id),
            ),
          );
  return { observations, history, projection, item, outbox };
}

function enablePricePlane(): void {
  process.env[APPROVAL_FLAG] = "true";
  process.env[CORRECTION_FLAG] = "true";
  process.env[PRICE_FLAG] = "true";
}

async function removePriceOutboxRejector(): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS test_reject_warehouse_price_outbox_trigger
      ON accounting_export_outbox;
    DROP FUNCTION IF EXISTS test_reject_warehouse_price_outbox();
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
  delete process.env[PRICE_FLAG];
  await removePriceOutboxRejector();
});

afterAll(() => {
  delete process.env[APPROVAL_FLAG];
  delete process.env[CORRECTION_FLAG];
  delete process.env[PRICE_FLAG];
});

describe("cost-document warehouse-price accounting dual-write", () => {
  it("appends observed, withdrawal and corrected evidence with exact replay and projection parity", async () => {
    const fixture = await createReviewDocument({ label: "lifecycle" });
    enablePricePlane();

    await approveDocument(fixture.document.id, actor);
    await updateWarehousePricesFromDocument(fixture.document.id, actor);
    let rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations).toHaveLength(1);
    expect(rows.history).toHaveLength(1);
    expect(rows.item?.purchasePrice).toBe("10.00");
    expect(
      accountingWarehousePriceObservationFromRow(rows.observations[0]!),
    ).toMatchObject({
      transition: "observed",
      purchasePrice: "10",
      currency: "CZK",
      source: { sourceLineId: String(fixture.line.id) },
      warehouseMatch: { mode: "code" },
    });
    expect(
      verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
        rows.projection[0]!.canonicalJson,
      ),
    ).toMatchObject({
      effectivePrice: { purchasePrice: "10", currency: "CZK" },
      valuationPolicy: {
        mode: "source-currency",
        fxConversionApplied: false,
      },
    });

    await updateWarehousePricesFromDocument(fixture.document.id, actor);
    rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations).toHaveLength(1);
    expect(rows.history).toHaveLength(1);

    await setDocumentStatus(
      fixture.document.id,
      "needs_review",
      actor,
      "Oprava nákupní ceny",
    );
    rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations.map((row) => row.transition)).toEqual([
      "observed",
      "withdrawn",
    ]);
    expect(rows.history).toHaveLength(0);
    expect(rows.item?.purchasePrice).toBeNull();
    expect(
      verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
        rows.projection[0]!.canonicalJson,
      ).effectivePrice,
    ).toBeNull();

    await db
      .update(billingDocumentLinesTable)
      .set({
        unitPriceWithoutVat: "12.00",
        totalWithoutVat: "120.00",
        totalVat: "25.20",
        totalWithVat: "145.20",
      })
      .where(eq(billingDocumentLinesTable.id, fixture.line.id));
    await db
      .update(billingDocumentsTable)
      .set({
        subtotalWithoutVat: "120.00",
        totalVat: "25.20",
        totalWithVat: "145.20",
      })
      .where(eq(billingDocumentsTable.id, fixture.document.id));
    await approveDocument(fixture.document.id, actor);
    await updateWarehousePricesFromDocument(fixture.document.id, actor);

    rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations.map((row) => row.transition)).toEqual([
      "observed",
      "withdrawn",
      "corrected",
    ]);
    expect(rows.history).toHaveLength(1);
    expect(rows.item?.purchasePrice).toBe("12.00");
    expect(
      verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
        rows.projection[0]!.canonicalJson,
      ),
    ).toMatchObject({
      streamHead: { sequence: "2" },
      effectivePrice: { purchasePrice: "12", currency: "CZK" },
    });
    expect(rows.outbox).toHaveLength(3);
  });

  it("rolls back legacy price, observation, intent and projection when the price outbox fails", async () => {
    const fixture = await createReviewDocument({ label: "rollback" });
    enablePricePlane();
    await approveDocument(fixture.document.id, actor);
    await pool.query(`
      CREATE FUNCTION test_reject_warehouse_price_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation = 'warehouse-price-observation' THEN
          RAISE EXCEPTION 'test warehouse price outbox rejection';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_reject_warehouse_price_outbox_trigger
      BEFORE INSERT ON accounting_export_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_warehouse_price_outbox();
    `);
    await expect(
      updateWarehousePricesFromDocument(fixture.document.id, actor),
    ).rejects.toThrow(/accounting_export_outbox/i);

    let rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations).toHaveLength(0);
    expect(rows.history).toHaveLength(0);
    expect(rows.projection).toHaveLength(0);
    expect(rows.item?.purchasePrice).toBeNull();

    await removePriceOutboxRejector();
    await updateWarehousePricesFromDocument(fixture.document.id, actor);
    rows = await priceRows(fixture.document.id, fixture.item.id);
    expect(rows.observations).toHaveLength(1);
    expect(rows.history).toHaveLength(1);
    expect(rows.projection).toHaveLength(1);
    expect(rows.item?.purchasePrice).toBe("10.00");
  });

  it("fails closed for non-CZK sources and unbootstrapped legacy item prices", async () => {
    const foreign = await createReviewDocument({
      label: "foreign",
      currency: "EUR",
    });
    enablePricePlane();
    await approveDocument(foreign.document.id, actor);
    await expect(
      updateWarehousePricesFromDocument(foreign.document.id, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await priceRows(foreign.document.id, foreign.item.id)).toMatchObject(
      { observations: [], history: [], projection: [] },
    );

    const legacy = await createReviewDocument({ label: "legacy" });
    await db
      .update(warehouseItemsTable)
      .set({ purchasePrice: "9.00" })
      .where(eq(warehouseItemsTable.id, legacy.item.id));
    await approveDocument(legacy.document.id, actor);
    await expect(
      updateWarehousePricesFromDocument(legacy.document.id, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    const legacyRows = await priceRows(legacy.document.id, legacy.item.id);
    expect(legacyRows.observations).toHaveLength(0);
    expect(legacyRows.history).toHaveLength(0);
    expect(legacyRows.item?.purchasePrice).toBe("9.00");
  });
});
