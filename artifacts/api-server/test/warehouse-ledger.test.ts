import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  jobsTable,
  materialsTable,
  activitiesTable,
  activityMaterialsTable,
  warehouseItemsTable,
  warehouseMovementsTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "@workspace/db";
import {
  createManualMovement,
  reconcileMaterialStockMovement,
  reconcileActivityMaterialStockMovement,
  reconcileSourceMovements,
  resolveWarehouseItemIdByName,
  netSignedForSources,
  listItemMovements,
} from "../src/lib/warehouse-service";
import { approveDocument, setDocumentStatus, splitLine } from "../src/lib/cost-document-service";

/**
 * Stock-movement ledger engine (DB-backed).
 *
 * Locks in the core invariant from .agents/memory/warehouse-ledger.md:
 * `warehouse_items.quantity` always equals the signed sum of that item's
 * append-only movements (in − out), across every mutation path — manual
 * corrections, cost-document approve → receipt → un-approve → reversal, and a
 * job material issue → edit → delete → re-match-to-a-different-item. Movements
 * are never deleted; storno/un-approve/delete append a reversing delta, so the
 * net contribution of a finished/removed source must end at exactly zero.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures are created with a
 * unique tag and torn down afterwards. NOTE: the isolated dev DB lags the
 * schema — `warehouse_movements` must be synced via direct psql before running
 * (see .agents/memory/test-db-schema-drift.md).
 */

const TAG = `test-whl-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

const itemIds: number[] = [];
const jobIds: number[] = [];
const docIds: number[] = [];
const activityIds: number[] = [];

/** Read the cached quantity column for an item. */
async function itemQty(itemId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: warehouseItemsTable.quantity })
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, itemId));
  return row ? Number(row.quantity) : NaN;
}

/** Recompute the signed sum of an item's movements straight from the ledger. */
async function ledgerSum(itemId: number): Promise<number> {
  const movements = await listItemMovements(db, itemId);
  return Number(
    movements.reduce((s, m) => s + m.signedQuantity, 0).toFixed(2),
  );
}

/** Assert the cached quantity equals the signed sum of the ledger. */
async function expectConsistent(itemId: number): Promise<number> {
  const cached = await itemQty(itemId);
  const ledger = await ledgerSum(itemId);
  expect(cached).toBeCloseTo(ledger, 2);
  return cached;
}

async function makeItem(opts: {
  name: string;
  code?: string | null;
}): Promise<number> {
  const [item] = await db
    .insert(warehouseItemsTable)
    .values({ name: opts.name, code: opts.code ?? null, quantity: "0" })
    .returning();
  itemIds.push(item.id);
  return item.id;
}

async function makeJob(): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({ title: `Zakázka ${TAG}`, type: "other", date: "2026-06-21" })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

/** A stock-allocated cost document with one material line (status needs_review). */
async function makeStockDoc(opts: {
  description: string;
  quantity: string;
  unitPrice?: string | null;
  supplierSku?: string | null;
}): Promise<{ docId: number; lineId: number }> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "needs_review",
      docType: "invoice",
      source: "manual",
      supplierName: `Dodavatel ${TAG}`,
      documentNumber: `FV-${TAG}-${docIds.length + 1}`,
    })
    .returning();
  docIds.push(doc.id);

  const [line] = await db
    .insert(billingDocumentLinesTable)
    .values({
      documentId: doc.id,
      description: opts.description,
      supplierSku: opts.supplierSku ?? null,
      quantity: opts.quantity,
      unit: "ks",
      unitPriceWithoutVat: opts.unitPrice ?? "100",
      vatRate: "21",
      vatMode: "standard",
      lineType: "material",
      allocationType: "stock",
    })
    .returning();
  return { docId: doc.id, lineId: line.id };
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: "x",
      name: "Test Runner",
      role: "admin",
    })
    .returning();
  actor.userId = user.id;
});

afterEach(async () => {
  // Tear down per-test fixtures. Movements cascade from items (FK on delete
  // cascade); materials cascade from jobs; doc lines cascade from documents.
  if (docIds.length) {
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
  if (activityIds.length) {
    await db
      .delete(activitiesTable)
      .where(inArray(activitiesTable.id, activityIds));
    activityIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
  if (itemIds.length) {
    await db
      .delete(warehouseMovementsTable)
      .where(inArray(warehouseMovementsTable.warehouseItemId, itemIds));
    await db
      .delete(warehouseItemsTable)
      .where(inArray(warehouseItemsTable.id, itemIds));
    itemIds.length = 0;
  }
});

afterAll(async () => {
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("manual movements", () => {
  it("accumulates signed in/out movements into the cached quantity", async () => {
    const itemId = await makeItem({ name: `Cement ${TAG}` });

    await createManualMovement(db, itemId, { direction: "in", quantity: 50 }, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(50, 2);

    await createManualMovement(db, itemId, { direction: "out", quantity: 20 }, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(30, 2);

    await createManualMovement(db, itemId, { direction: "in", quantity: 5.5 }, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(35.5, 2);

    // Three immutable rows, nothing deleted.
    const movements = await listItemMovements(db, itemId);
    expect(movements).toHaveLength(3);
  });

  it("rejects a non-positive manual quantity", async () => {
    const itemId = await makeItem({ name: `Písek ${TAG}` });
    await expect(
      createManualMovement(db, itemId, { direction: "in", quantity: 0 }, actor),
    ).rejects.toThrow();
    expect(await itemQty(itemId)).toBeCloseTo(0, 2);
  });
});

describe("cost-document receipt lifecycle", () => {
  it("approve receives stock, un-approve reverses it back to zero", async () => {
    const itemId = await makeItem({ name: `Hřebíky ${TAG}`, code: `SKU-${TAG}` });
    const { docId, lineId } = await makeStockDoc({
      description: `Hřebíky ${TAG}`,
      quantity: "40",
      supplierSku: `SKU-${TAG}`,
    });

    // Approve → příjem: the matched item gains the line quantity.
    await approveDocument(docId, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(40, 2);
    expect(await netSignedForSources(db, "billing_document_line", [lineId])).toBeCloseTo(40, 2);

    // Un-approve → storno: contribution reverses to zero, history preserved.
    await setDocumentStatus(docId, "needs_review", actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(0, 2);
    expect(await netSignedForSources(db, "billing_document_line", [lineId])).toBeCloseTo(0, 2);

    // The reversal is an appended row, not a deletion: 2 movements remain.
    const movements = await listItemMovements(db, itemId);
    expect(movements).toHaveLength(2);
  });

  it("auto-creates a warehouse item for an unmatched approved stock line", async () => {
    const uniqueName = `Neznámý materiál ${TAG}`;
    const { docId, lineId } = await makeStockDoc({
      description: uniqueName,
      quantity: "12",
    });

    await approveDocument(docId, actor);

    const [created] = await db
      .select()
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.name, uniqueName));
    expect(created).toBeTruthy();
    itemIds.push(created.id);

    expect(await expectConsistent(created.id)).toBeCloseTo(12, 2);
    expect(await netSignedForSources(db, "billing_document_line", [lineId])).toBeCloseTo(12, 2);
  });
});

describe("job material issue lifecycle", () => {
  // Mirrors the production create/update routes (routes/materials.ts): the
  // name→item match happens ONCE at save time and the resulting FK is stored
  // on the row. `reconcileMaterialStockMovement` itself is strictly ID-based
  // by design (see warehouse-service.ts), so any helper that inserts/updates
  // rows directly (bypassing the route) must resolve `warehouseItemId` itself
  // — that's the piece these test helpers were missing.
  async function insertMaterial(
    jobId: number,
    name: string,
    quantity: string,
  ): Promise<number> {
    const [m] = await db.transaction(async (tx) => {
      const warehouseItemId = await resolveWarehouseItemIdByName(tx, name);
      return tx
        .insert(materialsTable)
        .values({ jobId, name, quantity, pricePerUnit: "10", warehouseItemId, done: true })
        .returning();
    });
    return m.id;
  }

  it("issue → edit → delete keeps stock consistent and nets to zero on delete", async () => {
    const itemId = await makeItem({ name: `Kabel ${TAG}` });
    // Opening balance of 100 via a manual receipt.
    await createManualMovement(db, itemId, { direction: "in", quantity: 100 }, actor);
    const jobId = await makeJob();

    // Issue 10 → −10.
    const materialId = await insertMaterial(jobId, `Kabel ${TAG}`, "10");
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(materialsTable)
        .where(eq(materialsTable.id, materialId));
      await reconcileMaterialStockMovement(tx, m, actor);
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(90, 2);

    // Edit to 15 → only the −5 delta is appended.
    await db.transaction(async (tx) => {
      const [m] = await tx
        .update(materialsTable)
        .set({ quantity: "15" })
        .where(eq(materialsTable.id, materialId))
        .returning();
      await reconcileMaterialStockMovement(tx, m, actor);
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(85, 2);

    // Delete → reverse the issue; stock returns to the opening balance.
    await db.transaction(async (tx) => {
      await tx.delete(materialsTable).where(eq(materialsTable.id, materialId));
      await reconcileSourceMovements(tx, "material", materialId, null, actor);
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(100, 2);
    expect(await netSignedForSources(db, "material", [materialId])).toBeCloseTo(0, 2);
  });

  it("re-matching a material to a different item moves stock between both", async () => {
    const itemA = await makeItem({ name: `Šroub A ${TAG}` });
    const itemB = await makeItem({ name: `Šroub B ${TAG}` });
    await createManualMovement(db, itemA, { direction: "in", quantity: 100 }, actor);
    await createManualMovement(db, itemB, { direction: "in", quantity: 100 }, actor);
    const jobId = await makeJob();

    // Issue 30 against A (matched by name).
    const materialId = await insertMaterial(jobId, `Šroub A ${TAG}`, "30");
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(materialsTable)
        .where(eq(materialsTable.id, materialId));
      await reconcileMaterialStockMovement(tx, m, actor);
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(70, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(100, 2);

    // Rename the material to match B: A is restored, B is drawn down. The
    // route re-resolves warehouseItemId whenever the name changes (see
    // routes/materials.ts) — mirror that here before reconciling.
    await db.transaction(async (tx) => {
      const warehouseItemId = await resolveWarehouseItemIdByName(tx, `Šroub B ${TAG}`);
      const [m] = await tx
        .update(materialsTable)
        .set({ name: `Šroub B ${TAG}`, warehouseItemId })
        .where(eq(materialsTable.id, materialId))
        .returning();
      await reconcileMaterialStockMovement(tx, m, actor);
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(70, 2);

    // The source's net contribution is fully on B now.
    expect(await netSignedForSources(db, "material", [materialId])).toBeCloseTo(-30, 2);
  });
});

describe("activity material issue lifecycle", () => {
  async function makeActivity(): Promise<number> {
    const [activity] = await db
      .insert(activitiesTable)
      .values({ name: `Činnost ${TAG}` })
      .returning();
    activityIds.push(activity.id);
    return activity.id;
  }

  // Mirrors the production create/update routes (routes/activities.ts) —
  // see the comment on `insertMaterial` above for why this matters.
  async function insertActivityMaterial(
    activityId: number,
    name: string,
    quantity: string,
  ): Promise<number> {
    const [m] = await db.transaction(async (tx) => {
      const warehouseItemId = await resolveWarehouseItemIdByName(tx, name);
      return tx
        .insert(activityMaterialsTable)
        .values({ activityId, name, quantity, pricePerUnit: "10", warehouseItemId })
        .returning();
    });
    return m.id;
  }

  it("issue → edit → delete keeps stock consistent and nets to zero on delete", async () => {
    const itemId = await makeItem({ name: `Trubka ${TAG}` });
    // Opening balance of 100 via a manual receipt.
    await createManualMovement(db, itemId, { direction: "in", quantity: 100 }, actor);
    const activityId = await makeActivity();

    // Issue 10 → −10. The route always passes jobId: null for activity materials.
    const materialId = await insertActivityMaterial(activityId, `Trubka ${TAG}`, "10");
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(activityMaterialsTable)
        .where(eq(activityMaterialsTable.id, materialId));
      await reconcileActivityMaterialStockMovement(
        tx,
        { id: m.id, name: m.name, quantity: m.quantity, pricePerUnit: m.pricePerUnit, jobId: null, warehouseItemId: m.warehouseItemId },
        actor,
      );
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(90, 2);

    // Edit to 15 → only the −5 delta is appended.
    await db.transaction(async (tx) => {
      const [m] = await tx
        .update(activityMaterialsTable)
        .set({ quantity: "15" })
        .where(eq(activityMaterialsTable.id, materialId))
        .returning();
      await reconcileActivityMaterialStockMovement(
        tx,
        { id: m.id, name: m.name, quantity: m.quantity, pricePerUnit: m.pricePerUnit, jobId: null, warehouseItemId: m.warehouseItemId },
        actor,
      );
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(85, 2);

    // Delete → reverse the issue; stock returns to the opening balance and the
    // source's net contribution ends at exactly zero.
    await db.transaction(async (tx) => {
      await tx
        .delete(activityMaterialsTable)
        .where(eq(activityMaterialsTable.id, materialId));
      await reconcileSourceMovements(tx, "activity_material", materialId, null, actor);
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(100, 2);
    expect(await netSignedForSources(db, "activity_material", [materialId])).toBeCloseTo(0, 2);
  });

  it("re-matching an activity material to a different item moves stock between both", async () => {
    const itemA = await makeItem({ name: `Spojka A ${TAG}` });
    const itemB = await makeItem({ name: `Spojka B ${TAG}` });
    await createManualMovement(db, itemA, { direction: "in", quantity: 100 }, actor);
    await createManualMovement(db, itemB, { direction: "in", quantity: 100 }, actor);
    const activityId = await makeActivity();

    // Issue 30 against A (matched by name).
    const materialId = await insertActivityMaterial(activityId, `Spojka A ${TAG}`, "30");
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(activityMaterialsTable)
        .where(eq(activityMaterialsTable.id, materialId));
      await reconcileActivityMaterialStockMovement(
        tx,
        { id: m.id, name: m.name, quantity: m.quantity, pricePerUnit: m.pricePerUnit, jobId: null, warehouseItemId: m.warehouseItemId },
        actor,
      );
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(70, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(100, 2);

    // Rename the material to match B: A is restored, B is drawn down. The
    // route re-resolves warehouseItemId whenever the name changes (see
    // routes/activities.ts) — mirror that here before reconciling.
    await db.transaction(async (tx) => {
      const warehouseItemId = await resolveWarehouseItemIdByName(tx, `Spojka B ${TAG}`);
      const [m] = await tx
        .update(activityMaterialsTable)
        .set({ name: `Spojka B ${TAG}`, warehouseItemId })
        .where(eq(activityMaterialsTable.id, materialId))
        .returning();
      await reconcileActivityMaterialStockMovement(
        tx,
        { id: m.id, name: m.name, quantity: m.quantity, pricePerUnit: m.pricePerUnit, jobId: null, warehouseItemId: m.warehouseItemId },
        actor,
      );
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(70, 2);

    // The source's net contribution is fully on B now.
    expect(await netSignedForSources(db, "activity_material", [materialId])).toBeCloseTo(-30, 2);
  });
});

describe("cost-document line split", () => {
  /** The current line ids of a document, in sort order. */
  async function docLineIds(documentId: number): Promise<number[]> {
    const rows = await db
      .select({ id: billingDocumentLinesTable.id })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, documentId))
      .orderBy(billingDocumentLinesTable.sortOrder, billingDocumentLinesTable.id);
    return rows.map((r) => r.id);
  }

  it("splitting an approved stock line keeps the item quantity and ledger intact", async () => {
    const itemId = await makeItem({ name: `Trubka ${TAG}`, code: `SKU-SPLIT-${TAG}` });
    const { docId, lineId } = await makeStockDoc({
      description: `Trubka ${TAG}`,
      quantity: "40",
      supplierSku: `SKU-SPLIT-${TAG}`,
    });

    // Approve → příjem: the matched item gains the whole line quantity.
    await approveDocument(docId, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(40, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(40, 2);

    // Split 40 → 25 + 15. The original line id is destroyed and replaced by
    // two sibling part lines. Stock must not change: the old line's receipt is
    // reversed and the two new parts naskladní the same total.
    await splitLine(docId, lineId, [{ quantity: 25 }, { quantity: 15 }], actor);

    // The matched item's cached quantity is unchanged AND equals the signed
    // ledger sum — no double-receipt, no drift.
    expect(await expectConsistent(itemId)).toBeCloseTo(40, 2);

    // The original line's contribution is fully reversed (it no longer exists),
    // so it must net to zero — nothing orphaned against the dead id.
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(0, 2);

    // The replacement part lines now carry the full +40 between them.
    const partIds = await docLineIds(docId);
    expect(partIds).toHaveLength(2);
    expect(partIds).not.toContain(lineId);
    expect(
      await netSignedForSources(db, "billing_document_line", partIds),
    ).toBeCloseTo(40, 2);

    // The whole ledger for the item still nets to exactly +40 across every
    // source (old receipt + its storno + the two new part receipts).
    expect(await ledgerSum(itemId)).toBeCloseTo(40, 2);
  });

  it("splitting into three parts with uneven quantities stays consistent", async () => {
    const itemId = await makeItem({ name: `Kabel3 ${TAG}`, code: `SKU-3-${TAG}` });
    const { docId, lineId } = await makeStockDoc({
      description: `Kabel3 ${TAG}`,
      quantity: "12.5",
      supplierSku: `SKU-3-${TAG}`,
    });

    await approveDocument(docId, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(12.5, 2);

    await splitLine(
      docId,
      lineId,
      [{ quantity: 5 }, { quantity: 4.5 }, { quantity: 3 }],
      actor,
    );

    expect(await expectConsistent(itemId)).toBeCloseTo(12.5, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(0, 2);

    const partIds = await docLineIds(docId);
    expect(partIds).toHaveLength(3);
    expect(
      await netSignedForSources(db, "billing_document_line", partIds),
    ).toBeCloseTo(12.5, 2);
  });
});
