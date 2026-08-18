import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import { eq } from "drizzle-orm";
import {
  accountingExportOutboxTable,
  accountingWarehousePriceObservationsTable,
  accountingWarehousePriceProjectionHeadsTable,
  billingDocumentsTable,
  db,
  pool,
  warehouseItemsTable,
  type BillingDocument,
  type BillingDocumentFile,
  type BillingDocumentLine,
} from "@workspace/db";
import { accountingArchiveDbRepository } from "../src/lib/accounting-archive-db-store";
import { buildApprovedCostDocumentAccountingEvidence } from "../src/lib/accounting-cost-document-approval-evidence";
import {
  buildCorrectedCostDocumentAccountingEvidence,
  buildCostDocumentReviewReopenEvidence,
} from "../src/lib/accounting-cost-document-correction-evidence";
import {
  accountingWarehousePriceObservationFromRow,
  accountingWarehousePriceProjectionHeadFromRow,
  createAccountingPersistenceDbAdapter,
} from "../src/lib/accounting-persistence-db-adapter";
import {
  canonicalAccountingWarehousePriceObservationJson,
  createAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import { appendAccountingWarehousePriceObservationInTransaction } from "../src/lib/accounting-warehouse-price-persistence";
import { appendAccountingWarehousePriceWithProjectionInTransaction } from "../src/lib/accounting-warehouse-price-projection-persistence";
import { canonicalAccountingExportIntentJson } from "../src/lib/accounting-persistence-contract";
import { verifyCanonicalAccountingWarehousePriceParityReportJsonBytes } from "../src/lib/accounting-warehouse-price-parity";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PARITY_CLI = resolve(
  ROOT,
  "artifacts/api-server/src/scripts/audit-warehouse-price-parity.ts",
);
const TSX = resolve(ROOT, "scripts/node_modules/tsx/dist/cli.mjs");
const RECORDED_AT = new Date("2042-08-01T10:00:00.000Z");
const SOURCE_HASH = "a".repeat(64);
const MATCH_HASH = "b".repeat(64);

function runParityAudit() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for parity DB test.");
  const database = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, ""),
  );
  return spawnSync(
    process.execPath,
    [
      TSX,
      PARITY_CLI,
      `--database=${database}`,
      `--target-fingerprint=${"e".repeat(64)}`,
      "--max-items=100",
      "--max-observations=100",
      "--max-legacy-rows=100",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function document(id: number): BillingDocument {
  return {
    id,
    status: "approved",
    docType: "receipt",
    declaredDocType: "receipt",
    detectedDocType: null,
    detectedDocTypeConfidence: null,
    docTypeSource: "admin",
    docTypeConfirmedByUserId: 7,
    docTypeConfirmedAt: RECORDED_AT,
    source: "manual",
    sourceRef: null,
    objectPath: `/objects/cost/${id}.pdf`,
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    fileSize: 2048,
    sha256: SOURCE_HASH,
    supplierName: "Supplier s.r.o.",
    supplierIc: "12345678",
    supplierDic: null,
    supplierAddress: "Dlouhá 1, Praha",
    documentNumber: `PD-2042-${id}`,
    variableSymbol: null,
    issueDate: "2042-08-01",
    taxableSupplyDate: "2042-08-01",
    dueDate: null,
    currency: "CZK",
    subtotalWithoutVat: "100.00",
    totalVat: "21.00",
    totalWithVat: "121.00",
    deliveryNoteNumber: null,
    summaryDeliveryNoteNumber: null,
    deliveryNumber: null,
    orderNumber: null,
    supplierOrderNumber: null,
    deliveryNoteResolution: "not_required",
    deliveryNoteResolutionReason: "Dodací list není vyžadován",
    deliveryNoteResolutionByUserId: 7,
    deliveryNoteResolutionAt: RECORDED_AT,
    constantSymbol: null,
    specificSymbol: null,
    bankAccount: null,
    iban: null,
    bic: null,
    isdocUuid: null,
    mergeGroupId: null,
    uploadGroupToken: null,
    uploadCompletedAt: null,
    primaryDocumentId: null,
    sourcePriority: "manual",
    parsedBy: null,
    extractionVersion: 1,
    customerId: null,
    jobId: null,
    notes: null,
    warnings: null,
    aiRawJson: null,
    aiConfidence: null,
    aiModel: null,
    aiExtractedAt: null,
    createdByUserId: 7,
    reviewedByUserId: 7,
    reviewedAt: RECORDED_AT,
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
  };
}

function line(documentId: number): BillingDocumentLine {
  return {
    id: 501,
    documentId,
    parentLineId: null,
    lineType: "material",
    description: "Kabel",
    quantity: "10.00",
    unit: "m",
    originalUnit: null,
    unitPriceWithoutVat: "10.00",
    vatRate: "21.00",
    vatMode: "standard",
    totalWithoutVat: "100.00",
    totalVat: "21.00",
    totalWithVat: "121.00",
    supplierSku: "KABEL-1",
    ean: null,
    manufacturer: null,
    discountPercent: null,
    listPriceWithoutVat: null,
    priceBeforeDiscount: null,
    priceAfterDiscount: null,
    priceBaseQuantity: null,
    priceBaseUnit: null,
    feeType: null,
    isEnvironmentalFee: 0,
    environmentalFee: null,
    recyclingFee: null,
    relatedLineId: null,
    deliveryNoteNumber: null,
    orderNumber: null,
    supplierOrderNumber: null,
    sourceLineNumber: "1",
    confidence: null,
    jobId: null,
    activityId: null,
    allocationType: "stock",
    matchConfidence: null,
    matchConfirmed: 1,
    approved: 1,
    warehouseState: "assigned_to_stock",
    invoicedInvoiceId: null,
    sortOrder: 0,
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
  };
}

function file(documentId: number): BillingDocumentFile {
  return {
    id: 1,
    documentId,
    role: "primary",
    originalFileName: "receipt.pdf",
    mimeType: "application/pdf",
    objectPath: `/objects/cost/${documentId}.pdf`,
    sha256Hash: SOURCE_HASH,
    pageIndex: null,
    sizeBytes: 2048,
    createdAt: RECORDED_AT,
  };
}

function initialObservation(input: {
  warehouseItemId: number;
  observationId?: string;
  version: ReturnType<
    typeof buildApprovedCostDocumentAccountingEvidence
  >["version"];
  event: ReturnType<
    typeof buildApprovedCostDocumentAccountingEvidence
  >["event"];
}): AccountingWarehousePriceObservationV1 {
  return createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId:
      input.observationId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    warehouseItemId: String(input.warehouseItemId),
    sequence: "0",
    previousObservationSha256: null,
    supersedesObservationId: null,
    transition: "observed",
    source: {
      aggregateId: input.version.aggregate.id,
      accountingVersionId: input.version.versionId,
      accountingVersionSha256: input.version.integrity.versionSha256,
      lifecycleEventId: input.event.eventId,
      lifecycleEventSha256: input.event.integrity.entrySha256,
      sourceLineId: "501",
    },
    purchasePrice: "10",
    currency: "CZK",
    warehouseMatch: { mode: "code", evidenceSha256: MATCH_HASH },
    actor: input.event.actor,
    reasonCode: "document_approved",
    reasonDetailSha256: null,
    effectiveAt: input.event.effectiveAt,
    recordedAt: input.event.recordedAt,
  });
}

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
});

async function expectDatabaseCause(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected database operation to fail.");
  } catch (error) {
    const outer = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : "";
    expect(`${outer}\n${cause}`).toMatch(pattern);
  }
}

describe("warehouse-price persistence DB contract", () => {
  it("persists and replays exact canonical evidence while DB triggers reject tamper and chain drift", async () => {
    const [documentRow] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    const [warehouseItem] = await db
      .insert(warehouseItemsTable)
      .values({ name: `D9B-${Date.now()}`, purchasePrice: "10.00" })
      .returning({ id: warehouseItemsTable.id });
    const evidence = buildApprovedCostDocumentAccountingEvidence({
      document: document(documentRow!.id),
      lines: [line(documentRow!.id)],
      files: [file(documentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
    });
    const observation = initialObservation({
      warehouseItemId: warehouseItem!.id,
      version: evidence.version,
      event: evidence.event,
    });

    await db.transaction(async (tx) => {
      const adapter = createAccountingPersistenceDbAdapter(tx);
      await adapter.insertDocumentVersion(evidence.version);
      await adapter.insertLifecycleEvent(evidence.event);
      await expect(
        appendAccountingWarehousePriceObservationInTransaction(
          adapter,
          observation,
          evidence.version,
          evidence.event,
        ),
      ).resolves.toMatchObject({ replay: false });
    });

    await db.transaction(async (tx) => {
      await expect(
        appendAccountingWarehousePriceObservationInTransaction(
          createAccountingPersistenceDbAdapter(tx),
          observation,
          evidence.version,
          evidence.event,
        ),
      ).resolves.toMatchObject({ replay: true });
    });

    const [stored] = await db
      .select()
      .from(accountingWarehousePriceObservationsTable)
      .where(
        eq(
          accountingWarehousePriceObservationsTable.id,
          observation.observationId,
        ),
      );
    expect(accountingWarehousePriceObservationFromRow(stored!)).toEqual(
      observation,
    );
    const [storedIntent] = await db
      .select()
      .from(accountingExportOutboxTable)
      .where(
        eq(accountingExportOutboxTable.intentId, observation.observationId),
      );
    expect(storedIntent).toMatchObject({
      intentId: observation.observationId,
      operation: "warehouse-price-observation",
      state: "pending",
      canonicalJson: canonicalAccountingExportIntentJson(
        await db.transaction((tx) =>
          createAccountingPersistenceDbAdapter(tx).loadExportIntentById(
            observation.observationId,
          ),
        ),
      ),
    });
    await expect(
      accountingArchiveDbRepository.loadEntry({
        kind: "warehouse-price-observation",
        id: observation.observationId,
      }),
    ).resolves.toEqual({
      kind: "warehouse-price-observation",
      id: observation.observationId,
      canonicalJson:
        canonicalAccountingWarehousePriceObservationJson(observation),
    });

    await expectDatabaseCause(
      db
        .update(accountingWarehousePriceObservationsTable)
        .set({ purchasePrice: "11" })
        .where(
          eq(
            accountingWarehousePriceObservationsTable.id,
            observation.observationId,
          ),
        ),
      /immutable/i,
    );
    await expectDatabaseCause(
      db
        .delete(accountingWarehousePriceObservationsTable)
        .where(
          eq(
            accountingWarehousePriceObservationsTable.id,
            observation.observationId,
          ),
        ),
      /immutable/i,
    );

    const { integrity: _integrity, ...observationBody } = observation;
    const wrongSourcePrice = createAccountingWarehousePriceObservation({
      ...observationBody,
      observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sequence: "1",
      previousObservationSha256: observation.integrity.entrySha256,
      supersedesObservationId: observation.observationId,
      purchasePrice: "11",
    });
    await expectDatabaseCause(
      db.transaction((tx) =>
        createAccountingPersistenceDbAdapter(
          tx,
        ).insertWarehousePriceObservation(wrongSourcePrice),
      ),
      /source does not match accounting evidence/i,
    );

    const wrongPrevious = createAccountingWarehousePriceObservation({
      ...observationBody,
      observationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sequence: "1",
      previousObservationSha256: "0".repeat(64),
      supersedesObservationId: observation.observationId,
    });
    await expectDatabaseCause(
      db.transaction((tx) =>
        createAccountingPersistenceDbAdapter(
          tx,
        ).insertWarehousePriceObservation(wrongPrevious),
      ),
      /exact next chain step/i,
    );
  });

  it("allows a correction-created price to follow an unrelated existing item head", async () => {
    const [documentRow] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    const [warehouseItem] = await db
      .insert(warehouseItemsTable)
      .values({ name: `D9D-corrected-first-${Date.now()}` })
      .returning({ id: warehouseItemsTable.id });
    const [priorDocumentRow] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    const prior = buildApprovedCostDocumentAccountingEvidence({
      document: document(priorDocumentRow!.id),
      lines: [line(priorDocumentRow!.id)],
      files: [file(priorDocumentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
    });
    const priorObservation = initialObservation({
      warehouseItemId: warehouseItem!.id,
      observationId: "abababab-abab-4aba-8aba-abababababab",
      version: prior.version,
      event: prior.event,
    });
    const initial = buildApprovedCostDocumentAccountingEvidence({
      document: document(documentRow!.id),
      lines: [line(documentRow!.id)],
      files: [file(documentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
    });
    const reopen = buildCostDocumentReviewReopenEvidence({
      currentVersion: initial.version,
      nextLifecycleSequence: 1n,
      previousLifecycleEventSha256: initial.event.integrity.entrySha256,
      actor: { userId: 7, name: "Reviewer" },
      reason: "Přesun materiálu na jinou skladovou kartu",
      recordedAt: new Date("2042-08-01T11:00:00.000Z"),
    });
    const correctedLine = {
      ...line(documentRow!.id),
      unitPriceWithoutVat: "11.00",
      totalWithoutVat: "110.00",
      totalVat: "23.10",
      totalWithVat: "133.10",
      updatedAt: new Date("2042-08-01T12:00:00.000Z"),
    };
    const correctedDocument = {
      ...document(documentRow!.id),
      subtotalWithoutVat: "110.00",
      totalVat: "23.10",
      totalWithVat: "133.10",
      reviewedAt: new Date("2042-08-01T12:00:00.000Z"),
      updatedAt: new Date("2042-08-01T12:00:00.000Z"),
    };
    const corrected = buildCorrectedCostDocumentAccountingEvidence({
      document: correctedDocument,
      lines: [correctedLine],
      files: [file(documentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
      targetVersion: initial.version,
      reopenEvent: reopen.event,
    });
    const correctedObservation = createAccountingWarehousePriceObservation({
      schemaVersion: "site-logbook.warehouse-price-observation/v1",
      observationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      warehouseItemId: String(warehouseItem!.id),
      sequence: "1",
      previousObservationSha256: priorObservation.integrity.entrySha256,
      supersedesObservationId: priorObservation.observationId,
      transition: "corrected",
      source: {
        aggregateId: corrected.correctionVersion.aggregate.id,
        accountingVersionId: corrected.correctionVersion.versionId,
        accountingVersionSha256:
          corrected.correctionVersion.integrity.versionSha256,
        lifecycleEventId: corrected.event.eventId,
        lifecycleEventSha256: corrected.event.integrity.entrySha256,
        sourceLineId: "501",
      },
      purchasePrice: "11",
      currency: "CZK",
      warehouseMatch: { mode: "manual", evidenceSha256: MATCH_HASH },
      actor: corrected.event.actor,
      reasonCode: "correction_approved",
      reasonDetailSha256: corrected.event.reasonDetailSha256,
      effectiveAt: corrected.event.effectiveAt,
      recordedAt: corrected.event.recordedAt,
    });

    await db.transaction(async (tx) => {
      const adapter = createAccountingPersistenceDbAdapter(tx);
      await adapter.insertDocumentVersion(prior.version);
      await adapter.insertLifecycleEvent(prior.event);
      await appendAccountingWarehousePriceObservationInTransaction(
        adapter,
        priorObservation,
        prior.version,
        prior.event,
      );
      await adapter.insertDocumentVersion(initial.version);
      await adapter.insertLifecycleEvent(initial.event);
      await adapter.insertLifecycleEvent(reopen.event);
      await adapter.insertDocumentVersion(corrected.correctionVersion);
      await adapter.insertLifecycleEvent(corrected.event);
      await expect(
        appendAccountingWarehousePriceObservationInTransaction(
          adapter,
          correctedObservation,
          corrected.correctionVersion,
          corrected.event,
        ),
      ).resolves.toMatchObject({ replay: false });
    });

    const [stored] = await db
      .select({
        transition: accountingWarehousePriceObservationsTable.transition,
      })
      .from(accountingWarehousePriceObservationsTable)
      .where(
        eq(
          accountingWarehousePriceObservationsTable.id,
          correctedObservation.observationId,
        ),
      );
    expect(stored?.transition).toBe("corrected");
  });

  it("persists an explicit source-currency shadow projection without changing the legacy item column", async () => {
    const [documentRow] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    const [warehouseItem] = await db
      .insert(warehouseItemsTable)
      .values({ name: `D9F-projection-${Date.now()}`, purchasePrice: "10.00" })
      .returning({ id: warehouseItemsTable.id });
    const evidence = buildApprovedCostDocumentAccountingEvidence({
      document: document(documentRow!.id),
      lines: [line(documentRow!.id)],
      files: [file(documentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
    });
    const observation = initialObservation({
      warehouseItemId: warehouseItem!.id,
      observationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      version: evidence.version,
      event: evidence.event,
    });

    const first = await db.transaction(async (tx) => {
      const adapter = createAccountingPersistenceDbAdapter(tx);
      await adapter.insertDocumentVersion(evidence.version);
      await adapter.insertLifecycleEvent(evidence.event);
      return appendAccountingWarehousePriceWithProjectionInTransaction(
        adapter,
        observation,
        evidence.version,
        evidence.event,
      );
    });
    expect(first).toMatchObject({
      replay: false,
      projection: {
        replay: false,
        initialized: true,
        head: {
          effectivePrice: { purchasePrice: "10", currency: "CZK" },
          valuationPolicy: {
            mode: "source-currency",
            fxConversionApplied: false,
          },
        },
      },
    });

    const replay = await db.transaction((tx) =>
      appendAccountingWarehousePriceWithProjectionInTransaction(
        createAccountingPersistenceDbAdapter(tx),
        observation,
        evidence.version,
        evidence.event,
      ),
    );
    expect(replay).toMatchObject({
      replay: true,
      projection: { replay: true, initialized: false },
    });

    const [secondDocumentRow] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    const secondEvidence = buildApprovedCostDocumentAccountingEvidence({
      document: document(secondDocumentRow!.id),
      lines: [line(secondDocumentRow!.id)],
      files: [file(secondDocumentRow!.id)],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
    });
    const secondObservation = createAccountingWarehousePriceObservation({
      schemaVersion: "site-logbook.warehouse-price-observation/v1",
      observationId: "99999999-9999-4999-8999-999999999999",
      warehouseItemId: String(warehouseItem!.id),
      sequence: "1",
      previousObservationSha256: observation.integrity.entrySha256,
      supersedesObservationId: observation.observationId,
      transition: "observed",
      source: {
        aggregateId: secondEvidence.version.aggregate.id,
        accountingVersionId: secondEvidence.version.versionId,
        accountingVersionSha256: secondEvidence.version.integrity.versionSha256,
        lifecycleEventId: secondEvidence.event.eventId,
        lifecycleEventSha256: secondEvidence.event.integrity.entrySha256,
        sourceLineId: "501",
      },
      purchasePrice: "10",
      currency: "CZK",
      warehouseMatch: { mode: "code", evidenceSha256: MATCH_HASH },
      actor: secondEvidence.event.actor,
      reasonCode: "document_approved",
      reasonDetailSha256: null,
      effectiveAt: secondEvidence.event.effectiveAt,
      recordedAt: secondEvidence.event.recordedAt,
    });
    const advanced = await db.transaction(async (tx) => {
      const adapter = createAccountingPersistenceDbAdapter(tx);
      await adapter.insertDocumentVersion(secondEvidence.version);
      await adapter.insertLifecycleEvent(secondEvidence.event);
      return appendAccountingWarehousePriceWithProjectionInTransaction(
        adapter,
        secondObservation,
        secondEvidence.version,
        secondEvidence.event,
      );
    });
    expect(advanced).toMatchObject({
      replay: false,
      projection: {
        replay: false,
        initialized: false,
        head: {
          streamHead: {
            observationId: secondObservation.observationId,
            sequence: "1",
          },
          effectivePrice: { purchasePrice: "10", currency: "CZK" },
        },
      },
    });

    const [storedProjection] = await db
      .select()
      .from(accountingWarehousePriceProjectionHeadsTable)
      .where(
        eq(
          accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
          warehouseItem!.id,
        ),
      );
    expect(
      accountingWarehousePriceProjectionHeadFromRow(storedProjection!),
    ).toEqual(advanced.projection.head);
    const [storedItem] = await db
      .select({ purchasePrice: warehouseItemsTable.purchasePrice })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, warehouseItem!.id));
    expect(storedItem?.purchasePrice).toBe("10.00");

    const audit = runParityAudit();
    expect(audit.error).toBeUndefined();
    expect([0, 2, 3]).toContain(audit.status);
    expect(audit.stderr).toBe("");
    const parity = verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(
      audit.stdout.trimEnd(),
    );
    expect(
      parity.items.find(
        (item) => item.warehouseItemId === String(warehouseItem!.id),
      ),
    ).toMatchObject({
      storedPurchasePrice: "10",
      storedCurrency: "CZK",
      classification: "native_match",
      projectionHead: {
        streamHead: { observationId: secondObservation.observationId },
        effectivePrice: { purchasePrice: "10", currency: "CZK" },
      },
    });

    await expectDatabaseCause(
      db
        .update(accountingWarehousePriceProjectionHeadsTable)
        .set({ currency: "EUR" })
        .where(
          eq(
            accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
            warehouseItem!.id,
          ),
        ),
      /effective price|canonical binding|check constraint/i,
    );
    await expectDatabaseCause(
      db
        .delete(accountingWarehousePriceProjectionHeadsTable)
        .where(
          eq(
            accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
            warehouseItem!.id,
          ),
        ),
      /cannot be deleted/i,
    );
  });

  it("rolls back the observation when its export-intent insert fails", async () => {
    const functionName = "r13d9c_fail_price_outbox_insert";
    const triggerName = "r13d9c_fail_price_outbox_insert_trg";
    const observationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let primaryError: unknown = null;
    const cleanupErrors: unknown[] = [];
    try {
      await pool.query(`
        create or replace function ${functionName}()
        returns trigger language plpgsql as $body$
        begin
          if new.operation = 'warehouse-price-observation' then
            raise exception 'injected warehouse-price outbox fault';
          end if;
          return new;
        end
        $body$;
      `);
      await pool.query(
        `create trigger ${triggerName} before insert on accounting_export_outbox for each row execute function ${functionName}()`,
      );

      const [documentRow] = await db
        .insert(billingDocumentsTable)
        .values({ status: "uploaded" })
        .returning({ id: billingDocumentsTable.id });
      const [warehouseItem] = await db
        .insert(warehouseItemsTable)
        .values({ name: `D9C-rollback-${Date.now()}`, purchasePrice: "10.00" })
        .returning({ id: warehouseItemsTable.id });
      const evidence = buildApprovedCostDocumentAccountingEvidence({
        document: document(documentRow!.id),
        lines: [line(documentRow!.id)],
        files: [file(documentRow!.id)],
        references: [],
        latestCompletedExtractionJobId: null,
        actor: { userId: 7, name: "Reviewer" },
      });
      const observation = initialObservation({
        warehouseItemId: warehouseItem!.id,
        observationId,
        version: evidence.version,
        event: evidence.event,
      });

      await expectDatabaseCause(
        db.transaction(async (tx) => {
          const adapter = createAccountingPersistenceDbAdapter(tx);
          await adapter.insertDocumentVersion(evidence.version);
          await adapter.insertLifecycleEvent(evidence.event);
          await appendAccountingWarehousePriceObservationInTransaction(
            adapter,
            observation,
            evidence.version,
            evidence.event,
          );
        }),
        /injected warehouse-price outbox fault/i,
      );

      const observations = await db
        .select({ id: accountingWarehousePriceObservationsTable.id })
        .from(accountingWarehousePriceObservationsTable)
        .where(eq(accountingWarehousePriceObservationsTable.id, observationId));
      const intents = await db
        .select({ id: accountingExportOutboxTable.intentId })
        .from(accountingExportOutboxTable)
        .where(eq(accountingExportOutboxTable.intentId, observationId));
      expect(observations).toHaveLength(0);
      expect(intents).toHaveLength(0);
    } catch (error) {
      primaryError = error;
    } finally {
      for (const statement of [
        `drop trigger if exists ${triggerName} on accounting_export_outbox`,
        `drop function if exists ${functionName}()`,
      ]) {
        try {
          await pool.query(statement);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (primaryError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Warehouse-price rollback test and cleanup both failed.",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Warehouse-price rollback-test cleanup failed.",
      );
    }
  });
});
