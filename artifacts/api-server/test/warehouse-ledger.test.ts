import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  cancelLastManualMovement,
  reconcileMaterialStockMovement,
  reconcileActivityMaterialStockMovement,
  reconcileSourceMovements,
  reconcileSourceMovementBatch,
  runUnambiguousWarehouseMaterialBackfill,
  resolveWarehouseItemIdByName,
  netSignedForSources,
  listItemMovements,
} from "../src/lib/warehouse-service";
import {
  approveDocument,
  setDocumentStatus,
  splitLine,
} from "../src/lib/cost-document-service";

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
  return Number(movements.reduce((s, m) => s + m.signedQuantity, 0).toFixed(2));
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
      deliveryNoteResolution: "not_required",
      deliveryNoteResolutionReason: `Testovací skladová faktura ${TAG} nemá dodací list`,
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

    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 50 },
      actor,
    );
    expect(await expectConsistent(itemId)).toBeCloseTo(50, 2);

    await createManualMovement(
      db,
      itemId,
      { direction: "out", quantity: 20 },
      actor,
    );
    expect(await expectConsistent(itemId)).toBeCloseTo(30, 2);

    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 5.5 },
      actor,
    );
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

  it("rejects a manual issue that would make authoritative stock negative", async () => {
    const itemId = await makeItem({ name: `Tmel ${TAG}` });
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 5 },
      actor,
    );

    await expect(
      createManualMovement(
        db,
        itemId,
        { direction: "out", quantity: 5.01 },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await expectConsistent(itemId)).toBeCloseTo(5, 2);
    expect(await listItemMovements(db, itemId)).toHaveLength(1);
  });

  it("serializes concurrent manual issues and permits only the available stock", async () => {
    const itemId = await makeItem({ name: `Kotva ${TAG}` });
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 10 },
      actor,
    );

    const results = await Promise.allSettled([
      createManualMovement(
        db,
        itemId,
        { direction: "out", quantity: 7 },
        actor,
      ),
      createManualMovement(
        db,
        itemId,
        { direction: "out", quantity: 7 },
        actor,
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ statusCode: 409 });
    expect(await expectConsistent(itemId)).toBeCloseTo(3, 2);
    expect(await listItemMovements(db, itemId)).toHaveLength(2);
  });

  it("permits exactly one concurrent cancellation of the latest manual movement", async () => {
    const itemId = await makeItem({ name: `Storno souběh ${TAG}` });
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 10, unitPrice: 25 },
      actor,
    );

    const results = await Promise.allSettled([
      db.transaction((tx) => cancelLastManualMovement(tx, itemId, actor)),
      db.transaction((tx) => cancelLastManualMovement(tx, itemId, actor)),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ statusCode: 409 });
    expect(await expectConsistent(itemId)).toBeCloseTo(0, 2);
    const movements = await listItemMovements(db, itemId);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      direction: "out",
      quantity: 10,
      costPriceAtTime: null,
    });
    expect(movements[0]?.note).toMatch(/^Storno pohybu #\d+$/);
  });

  it("refuses to cancel a consumed manual receipt into negative stock", async () => {
    const itemId = await makeItem({ name: `Storno spotřeby ${TAG}` });
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 10 },
      actor,
    );
    const jobId = await makeJob();
    const [material] = await db
      .insert(materialsTable)
      .values({
        jobId,
        name: `Storno spotřeby ${TAG}`,
        quantity: "7",
        pricePerUnit: "10",
        warehouseItemId: itemId,
        done: true,
      })
      .returning();
    await db.transaction((tx) =>
      reconcileSourceMovements(
        tx,
        "material",
        material.id,
        {
          warehouseItemId: itemId,
          signedQty: -7,
          unitPrice: 10,
          billingDocumentId: null,
          jobId,
          note: "Výdej na zakázku",
        },
        actor,
      ),
    );

    await expect(
      db.transaction((tx) => cancelLastManualMovement(tx, itemId, actor)),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await expectConsistent(itemId)).toBeCloseTo(3, 2);
    expect(await listItemMovements(db, itemId)).toHaveLength(2);
  });
});

describe("warehouse material backfill", () => {
  it("fails closed before any legacy bulk assignment can mutate stock", async () => {
    const targetName = `Backfill target ${TAG}`;
    const ambiguousName = `Backfill ambiguous ${TAG}`;
    const targetItemId = await makeItem({ name: targetName });
    await createManualMovement(
      db,
      targetItemId,
      { direction: "in", quantity: 20 },
      actor,
    );
    await makeItem({ name: ambiguousName });
    await makeItem({ name: ambiguousName });

    const jobId = await makeJob();
    const [jobMaterial] = await db
      .insert(materialsTable)
      .values({
        jobId,
        name: targetName,
        quantity: "5",
        pricePerUnit: "10",
        warehouseItemId: null,
        done: true,
      })
      .returning();
    const [ambiguousMaterial] = await db
      .insert(materialsTable)
      .values({
        jobId,
        name: ambiguousName,
        quantity: "1",
        pricePerUnit: "10",
        warehouseItemId: null,
        done: true,
      })
      .returning();
    const [activity] = await db
      .insert(activitiesTable)
      .values({ name: `Backfill activity ${TAG}` })
      .returning();
    activityIds.push(activity.id);
    const [activityMaterial] = await db
      .insert(activityMaterialsTable)
      .values({
        activityId: activity.id,
        name: targetName,
        quantity: "4",
        pricePerUnit: "10",
        warehouseItemId: null,
      })
      .returning();

    await expect(
      runUnambiguousWarehouseMaterialBackfill(db, actor),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [storedJobMaterial] = await db
      .select({ warehouseItemId: materialsTable.warehouseItemId })
      .from(materialsTable)
      .where(eq(materialsTable.id, jobMaterial.id));
    const [storedActivityMaterial] = await db
      .select({ warehouseItemId: activityMaterialsTable.warehouseItemId })
      .from(activityMaterialsTable)
      .where(eq(activityMaterialsTable.id, activityMaterial.id));
    const [storedAmbiguousMaterial] = await db
      .select({ warehouseItemId: materialsTable.warehouseItemId })
      .from(materialsTable)
      .where(eq(materialsTable.id, ambiguousMaterial.id));
    expect(storedJobMaterial?.warehouseItemId).toBeNull();
    expect(storedActivityMaterial?.warehouseItemId).toBeNull();
    expect(storedAmbiguousMaterial?.warehouseItemId).toBeNull();
    expect(await expectConsistent(targetItemId)).toBeCloseTo(20, 2);
    expect(await listItemMovements(db, targetItemId)).toHaveLength(1);
  });

  it("fails closed without linking rows or creating movements", async () => {
    const targetName = `Backfill no stock ${TAG}`;
    const targetItemId = await makeItem({ name: targetName });
    const jobId = await makeJob();
    const [material] = await db
      .insert(materialsTable)
      .values({
        jobId,
        name: targetName,
        quantity: "2",
        pricePerUnit: "10",
        warehouseItemId: null,
        done: true,
      })
      .returning();

    await expect(
      runUnambiguousWarehouseMaterialBackfill(db, actor),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [stored] = await db
      .select({ warehouseItemId: materialsTable.warehouseItemId })
      .from(materialsTable)
      .where(eq(materialsTable.id, material.id));
    expect(stored?.warehouseItemId).toBeNull();
    expect(await expectConsistent(targetItemId)).toBeCloseTo(0, 2);
    expect(await listItemMovements(db, targetItemId)).toHaveLength(0);
  });
});

describe("cost-document receipt lifecycle", () => {
  it("approve receives stock, un-approve reverses it back to zero", async () => {
    const itemId = await makeItem({
      name: `Hřebíky ${TAG}`,
      code: `SKU-${TAG}`,
    });
    const { docId, lineId } = await makeStockDoc({
      description: `Hřebíky ${TAG}`,
      quantity: "40",
      supplierSku: `SKU-${TAG}`,
    });

    // Approve → příjem: the matched item gains the line quantity.
    await approveDocument(docId, actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(40, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(40, 2);

    // Un-approve → storno: contribution reverses to zero, history preserved.
    await setDocumentStatus(docId, "needs_review", actor);
    expect(await expectConsistent(itemId)).toBeCloseTo(0, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(0, 2);

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
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(12, 2);
  });

  it("rolls back un-approval when reversing the receipt would make stock negative", async () => {
    const itemId = await makeItem({
      name: `Spotřebovaný příjem ${TAG}`,
      code: `SKU-CONSUMED-${TAG}`,
    });
    const { docId, lineId } = await makeStockDoc({
      description: `Spotřebovaný příjem ${TAG}`,
      quantity: "40",
      supplierSku: `SKU-CONSUMED-${TAG}`,
    });
    await approveDocument(docId, actor);
    await createManualMovement(
      db,
      itemId,
      { direction: "out", quantity: 30 },
      actor,
    );

    await expect(
      setDocumentStatus(docId, "needs_review", actor),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [document] = await db
      .select({ status: billingDocumentsTable.status })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, docId));
    expect(document?.status).toBe("approved");
    expect(await expectConsistent(itemId)).toBeCloseTo(10, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(40, 2);
    expect(await listItemMovements(db, itemId)).toHaveLength(2);
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
        .values({
          jobId,
          name,
          quantity,
          pricePerUnit: "10",
          warehouseItemId,
          done: true,
        })
        .returning();
    });
    return m.id;
  }

  it("rolls back a material and its movement when the issue exceeds stock", async () => {
    const materialName = `Nedostupný kabel ${TAG}`;
    const itemId = await makeItem({ name: materialName });
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 5 },
      actor,
    );
    const jobId = await makeJob();

    await expect(
      db.transaction(async (tx) => {
        const [material] = await tx
          .insert(materialsTable)
          .values({
            jobId,
            name: materialName,
            quantity: "8",
            pricePerUnit: "10",
            warehouseItemId: itemId,
            done: true,
          })
          .returning();
        await reconcileMaterialStockMovement(tx, material, actor);
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const storedMaterials = await db
      .select({ id: materialsTable.id })
      .from(materialsTable)
      .where(
        and(
          eq(materialsTable.jobId, jobId),
          eq(materialsTable.name, materialName),
        ),
      );
    expect(storedMaterials).toHaveLength(0);
    expect(await expectConsistent(itemId)).toBeCloseTo(5, 2);
    expect(await listItemMovements(db, itemId)).toHaveLength(1);
  });

  it("issue → edit → delete keeps stock consistent and nets to zero on delete", async () => {
    const itemId = await makeItem({ name: `Kabel ${TAG}` });
    // Opening balance of 100 via a manual receipt.
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 100 },
      actor,
    );
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
    expect(await netSignedForSources(db, "material", [materialId])).toBeCloseTo(
      0,
      2,
    );
  });

  it("re-matching a material to a different item moves stock between both", async () => {
    const itemA = await makeItem({ name: `Šroub A ${TAG}` });
    const itemB = await makeItem({ name: `Šroub B ${TAG}` });
    await createManualMovement(
      db,
      itemA,
      { direction: "in", quantity: 100 },
      actor,
    );
    await createManualMovement(
      db,
      itemB,
      { direction: "in", quantity: 100 },
      actor,
    );
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
      const warehouseItemId = await resolveWarehouseItemIdByName(
        tx,
        `Šroub B ${TAG}`,
      );
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
    expect(await netSignedForSources(db, "material", [materialId])).toBeCloseTo(
      -30,
      2,
    );
  });
  it("serializes opposite A→B and B→A rematches without a lock-order deadlock", async () => {
    const itemA = await makeItem({ name: `Souběh A ${TAG}` });
    const itemB = await makeItem({ name: `Souběh B ${TAG}` });
    await createManualMovement(
      db,
      itemA,
      { direction: "in", quantity: 100 },
      actor,
    );
    await createManualMovement(
      db,
      itemB,
      { direction: "in", quantity: 100 },
      actor,
    );
    const jobId = await makeJob();
    const sourceA = await insertMaterial(jobId, `Souběh A ${TAG}`, "30");
    const sourceB = await insertMaterial(jobId, `Souběh B ${TAG}`, "30");

    for (const sourceId of [sourceA, sourceB]) {
      await db.transaction(async (tx) => {
        const [material] = await tx
          .select()
          .from(materialsTable)
          .where(eq(materialsTable.id, sourceId));
        await reconcileMaterialStockMovement(tx, material, actor);
      });
    }

    let arrived = 0;
    let barrierSettled = false;
    let releaseBarrier!: () => void;
    let rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      releaseBarrier = () => {
        if (barrierSettled) return;
        barrierSettled = true;
        resolve();
      };
      rejectBarrier = (error) => {
        if (barrierSettled) return;
        barrierSettled = true;
        reject(error);
      };
    });
    const barrierTimeout = setTimeout(
      () =>
        rejectBarrier(new Error("Warehouse rematch test barrier timed out.")),
      3_000,
    );
    const synchronize = async () => {
      arrived += 1;
      if (arrived === 2) releaseBarrier();
      await barrier;
    };
    const releaseBarrierOnFailure = async (worker: () => Promise<void>) => {
      try {
        await worker();
      } catch (error) {
        releaseBarrier();
        throw error;
      }
    };

    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_warehouse_storno_delay()
        returns trigger language plpgsql as $$
        begin
          if new.note = 'Storno pohybu' then
            perform pg_sleep(0.20);
          end if;
          return new;
        end;
        $$;
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_warehouse_storno_delay_trg on warehouse_movements",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_warehouse_storno_delay_trg
        before insert on warehouse_movements
        for each row execute function test_warehouse_storno_delay()
      `),
      );

      const results = await Promise.allSettled([
        releaseBarrierOnFailure(() =>
          db.transaction(async (tx) => {
            await tx.execute(sql.raw("set local statement_timeout = '5s'"));
            const [material] = await tx
              .update(materialsTable)
              .set({ name: `Souběh B ${TAG}`, warehouseItemId: itemB })
              .where(eq(materialsTable.id, sourceA))
              .returning();
            await synchronize();
            await reconcileMaterialStockMovement(tx, material, actor);
          }),
        ),
        releaseBarrierOnFailure(() =>
          db.transaction(async (tx) => {
            await tx.execute(sql.raw("set local statement_timeout = '5s'"));
            const [material] = await tx
              .update(materialsTable)
              .set({ name: `Souběh A ${TAG}`, warehouseItemId: itemA })
              .where(eq(materialsTable.id, sourceB))
              .returning();
            await synchronize();
            await reconcileMaterialStockMovement(tx, material, actor);
          }),
        ),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
    } catch (error) {
      primaryError = error;
    } finally {
      clearTimeout(barrierTimeout);
      releaseBarrier();
      try {
        await db.execute(
          sql.raw(
            "drop trigger if exists test_warehouse_storno_delay_trg on warehouse_movements",
          ),
        );
        await db.execute(
          sql.raw("drop function if exists test_warehouse_storno_delay()"),
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError && cleanupError) {
      throw new AggregateError([primaryError, cleanupError]);
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;

    expect(await expectConsistent(itemA)).toBeCloseTo(70, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(70, 2);
    expect(await netSignedForSources(db, "material", [sourceA])).toBeCloseTo(
      -30,
      2,
    );
    expect(await netSignedForSources(db, "material", [sourceB])).toBeCloseTo(
      -30,
      2,
    );

    const movementsA = await listItemMovements(db, itemA);
    const movementsB = await listItemMovements(db, itemB);
    const signedFor = (sourceId: number, movements: typeof movementsA) =>
      movements
        .filter(
          (movement) =>
            movement.sourceType === "material" &&
            movement.sourceId === sourceId,
        )
        .reduce((sum, movement) => sum + movement.signedQuantity, 0);
    expect(signedFor(sourceA, movementsB)).toBeCloseTo(-30, 2);
    expect(signedFor(sourceB, movementsA)).toBeCloseTo(-30, 2);
  });

  it("fails closed when two first reconciles of an empty source target disjoint items", async () => {
    const itemA = await makeItem({ name: `Prázdný zdroj A ${TAG}` });
    const itemB = await makeItem({ name: `Prázdný zdroj B ${TAG}` });
    await createManualMovement(
      db,
      itemA,
      { direction: "in", quantity: 100 },
      actor,
    );
    await createManualMovement(
      db,
      itemB,
      { direction: "in", quantity: 100 },
      actor,
    );
    const jobId = await makeJob();
    const sourceId = await insertMaterial(jobId, `Prázdný zdroj ${TAG}`, "30");
    const desiredFor = (warehouseItemId: number) => ({
      warehouseItemId,
      signedQty: -30,
      unitPrice: 10,
      billingDocumentId: null,
      jobId,
      note: "Výdej na zakázku",
    });

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstReady!: () => void;
    let rejectFirstReady!: (error: unknown) => void;
    const firstReady = new Promise<void>((resolve, reject) => {
      signalFirstReady = resolve;
      rejectFirstReady = reject;
    });
    const first = db.transaction(async (tx) => {
      try {
        await reconcileSourceMovements(
          tx,
          "material",
          sourceId,
          desiredFor(itemA),
          actor,
        );
        signalFirstReady();
        await holdFirst;
      } catch (error) {
        rejectFirstReady(error);
        throw error;
      }
    });
    const readyTimeout = setTimeout(
      () => rejectFirstReady(new Error("Empty-source reconcile timed out.")),
      3_000,
    );

    let secondResult: PromiseSettledResult<void>;
    try {
      await firstReady.finally(() => clearTimeout(readyTimeout));
      secondResult = (
        await Promise.allSettled([
          db.transaction(async (tx) => {
            await tx.execute(sql.raw("set local statement_timeout = '3s'"));
            return reconcileSourceMovements(
              tx,
              "material",
              sourceId,
              desiredFor(itemB),
              actor,
            );
          }),
        ])
      )[0];
    } finally {
      clearTimeout(readyTimeout);
      releaseFirst();
    }
    await first;

    expect(secondResult).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409 },
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(70, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(100, 2);
    expect(await netSignedForSources(db, "material", [sourceId])).toBeCloseTo(
      -30,
      2,
    );

    await db.transaction((tx) =>
      reconcileSourceMovements(
        tx,
        "material",
        sourceId,
        desiredFor(itemB),
        actor,
      ),
    );
    expect(await expectConsistent(itemA)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(70, 2);
    expect(await netSignedForSources(db, "material", [sourceId])).toBeCloseTo(
      -30,
      2,
    );
  });

  it("fails closed on a concurrent same-source rematch and converges after retry", async () => {
    const itemA = await makeItem({ name: `Stejný zdroj A ${TAG}` });
    const itemB = await makeItem({ name: `Stejný zdroj B ${TAG}` });
    const itemC = await makeItem({ name: `Stejný zdroj C ${TAG}` });
    for (const itemId of [itemA, itemB, itemC]) {
      await createManualMovement(
        db,
        itemId,
        { direction: "in", quantity: 100 },
        actor,
      );
    }
    const jobId = await makeJob();
    const sourceId = await insertMaterial(jobId, `Stejný zdroj A ${TAG}`, "30");
    const desiredFor = (warehouseItemId: number) => ({
      warehouseItemId,
      signedQty: -30,
      unitPrice: 10,
      billingDocumentId: null,
      jobId,
      note: "Výdej na zakázku",
    });

    await db.transaction((tx) =>
      reconcileSourceMovements(
        tx,
        "material",
        sourceId,
        desiredFor(itemA),
        actor,
      ),
    );

    let releaseFirstCommit!: () => void;
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let resolveFirstReady!: () => void;
    let rejectFirstReady!: (error: unknown) => void;
    const firstReady = new Promise<void>((resolve, reject) => {
      resolveFirstReady = resolve;
      rejectFirstReady = reject;
    });

    const first = db.transaction(async (tx) => {
      try {
        await reconcileSourceMovements(
          tx,
          "material",
          sourceId,
          desiredFor(itemB),
          actor,
        );
        resolveFirstReady();
        await firstCommitGate;
      } catch (error) {
        rejectFirstReady(error);
        throw error;
      }
    });

    const firstReadyTimeout = setTimeout(
      () =>
        rejectFirstReady(new Error("First same-source reconcile timed out.")),
      3_000,
    );
    await firstReady.finally(() => clearTimeout(firstReadyTimeout));

    let secondResult: PromiseSettledResult<void> | undefined;
    try {
      [secondResult] = await Promise.allSettled([
        db.transaction(async (tx) => {
          await tx.execute(sql.raw("set local statement_timeout = '3s'"));
          return reconcileSourceMovements(
            tx,
            "material",
            sourceId,
            desiredFor(itemC),
            actor,
          );
        }),
      ]);
    } finally {
      releaseFirstCommit();
    }

    await expect(first).resolves.toBeUndefined();
    expect(secondResult).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409 },
    });

    await db.transaction((tx) =>
      reconcileSourceMovements(
        tx,
        "material",
        sourceId,
        desiredFor(itemC),
        actor,
      ),
    );

    expect(await expectConsistent(itemA)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemC)).toBeCloseTo(70, 2);
    expect(await netSignedForSources(db, "material", [sourceId])).toBeCloseTo(
      -30,
      2,
    );
    const movementsC = await listItemMovements(db, itemC);
    const sourceNetOnC = movementsC
      .filter(
        (movement) =>
          movement.sourceType === "material" && movement.sourceId === sourceId,
      )
      .reduce((sum, movement) => sum + movement.signedQuantity, 0);
    expect(sourceNetOnC).toBeCloseTo(-30, 2);
  });
});

describe("multi-source batch lock planning", () => {
  it("locks the full item union before opposite-order source batches write", async () => {
    const itemA = await makeItem({ name: `Batch A ${TAG}` });
    const itemB = await makeItem({ name: `Batch B ${TAG}` });
    await createManualMovement(
      db,
      itemA,
      { direction: "in", quantity: 100 },
      actor,
    );
    await createManualMovement(
      db,
      itemB,
      { direction: "in", quantity: 100 },
      actor,
    );
    const jobId = await makeJob();
    const sources = await db
      .insert(materialsTable)
      .values([
        {
          jobId,
          name: `Batch A1 ${TAG}`,
          quantity: "8",
          pricePerUnit: "10",
          warehouseItemId: itemA,
          done: true,
        },
        {
          jobId,
          name: `Batch B1 ${TAG}`,
          quantity: "8",
          pricePerUnit: "10",
          warehouseItemId: itemB,
          done: true,
        },
        {
          jobId,
          name: `Batch B2 ${TAG}`,
          quantity: "8",
          pricePerUnit: "10",
          warehouseItemId: itemB,
          done: true,
        },
        {
          jobId,
          name: `Batch A2 ${TAG}`,
          quantity: "8",
          pricePerUnit: "10",
          warehouseItemId: itemA,
          done: true,
        },
      ])
      .returning({ id: materialsTable.id });

    const request = (sourceId: number, warehouseItemId: number) => ({
      sourceType: "material" as const,
      sourceId,
      desired: {
        warehouseItemId,
        signedQty: -8,
        unitPrice: 10,
        billingDocumentId: null,
        jobId,
        note: "Batch výdej",
      },
    });

    let arrived = 0;
    let barrierSettled = false;
    let releaseBarrier!: () => void;
    let rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      releaseBarrier = () => {
        if (barrierSettled) return;
        barrierSettled = true;
        resolve();
      };
      rejectBarrier = (error) => {
        if (barrierSettled) return;
        barrierSettled = true;
        reject(error);
      };
    });
    const barrierTimeout = setTimeout(
      () => rejectBarrier(new Error("Warehouse batch barrier timed out.")),
      3_000,
    );
    const synchronize = async () => {
      arrived += 1;
      if (arrived === 2) releaseBarrier();
      await barrier;
    };
    const runWorker = async (
      requests: Parameters<typeof reconcileSourceMovementBatch>[1],
    ) => {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw("set local statement_timeout = '5s'"));
          await synchronize();
          await reconcileSourceMovementBatch(tx, requests, actor);
        });
      } catch (error) {
        releaseBarrier();
        throw error;
      }
    };

    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_warehouse_batch_delay()
        returns trigger language plpgsql as $$
        begin
          if new.note = 'Batch výdej' then
            perform pg_sleep(0.25);
          end if;
          return new;
        end;
        $$;
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_warehouse_batch_delay_trg on warehouse_movements",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_warehouse_batch_delay_trg
        before insert on warehouse_movements
        for each row execute function test_warehouse_batch_delay()
      `),
      );

      const results = await Promise.allSettled([
        runWorker([
          request(sources[0].id, itemA),
          request(sources[1].id, itemB),
        ]),
        runWorker([
          request(sources[2].id, itemB),
          request(sources[3].id, itemA),
        ]),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
    } catch (error) {
      primaryError = error;
    } finally {
      clearTimeout(barrierTimeout);
      releaseBarrier();
      try {
        await db.execute(
          sql.raw(
            "drop trigger if exists test_warehouse_batch_delay_trg on warehouse_movements",
          ),
        );
        await db.execute(
          sql.raw("drop function if exists test_warehouse_batch_delay()"),
        );
      } catch (error) {
        cleanupError = error;
      }
    }

    if (primaryError && cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Warehouse batch test and cleanup both failed.",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;

    expect(await expectConsistent(itemA)).toBeCloseTo(84, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(84, 2);
    expect(
      await netSignedForSources(
        db,
        "material",
        sources.map((source) => source.id),
      ),
    ).toBeCloseTo(-32, 2);
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
        .values({
          activityId,
          name,
          quantity,
          pricePerUnit: "10",
          warehouseItemId,
        })
        .returning();
    });
    return m.id;
  }

  it("issue → edit → delete keeps stock consistent and nets to zero on delete", async () => {
    const itemId = await makeItem({ name: `Trubka ${TAG}` });
    // Opening balance of 100 via a manual receipt.
    await createManualMovement(
      db,
      itemId,
      { direction: "in", quantity: 100 },
      actor,
    );
    const activityId = await makeActivity();

    // Issue 10 → −10. The route always passes jobId: null for activity materials.
    const materialId = await insertActivityMaterial(
      activityId,
      `Trubka ${TAG}`,
      "10",
    );
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(activityMaterialsTable)
        .where(eq(activityMaterialsTable.id, materialId));
      await reconcileActivityMaterialStockMovement(
        tx,
        {
          id: m.id,
          name: m.name,
          quantity: m.quantity,
          pricePerUnit: m.pricePerUnit,
          jobId: null,
          warehouseItemId: m.warehouseItemId,
        },
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
        {
          id: m.id,
          name: m.name,
          quantity: m.quantity,
          pricePerUnit: m.pricePerUnit,
          jobId: null,
          warehouseItemId: m.warehouseItemId,
        },
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
      await reconcileSourceMovements(
        tx,
        "activity_material",
        materialId,
        null,
        actor,
      );
    });
    expect(await expectConsistent(itemId)).toBeCloseTo(100, 2);
    expect(
      await netSignedForSources(db, "activity_material", [materialId]),
    ).toBeCloseTo(0, 2);
  });

  it("re-matching an activity material to a different item moves stock between both", async () => {
    const itemA = await makeItem({ name: `Spojka A ${TAG}` });
    const itemB = await makeItem({ name: `Spojka B ${TAG}` });
    await createManualMovement(
      db,
      itemA,
      { direction: "in", quantity: 100 },
      actor,
    );
    await createManualMovement(
      db,
      itemB,
      { direction: "in", quantity: 100 },
      actor,
    );
    const activityId = await makeActivity();

    // Issue 30 against A (matched by name).
    const materialId = await insertActivityMaterial(
      activityId,
      `Spojka A ${TAG}`,
      "30",
    );
    await db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(activityMaterialsTable)
        .where(eq(activityMaterialsTable.id, materialId));
      await reconcileActivityMaterialStockMovement(
        tx,
        {
          id: m.id,
          name: m.name,
          quantity: m.quantity,
          pricePerUnit: m.pricePerUnit,
          jobId: null,
          warehouseItemId: m.warehouseItemId,
        },
        actor,
      );
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(70, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(100, 2);

    // Rename the material to match B: A is restored, B is drawn down. The
    // route re-resolves warehouseItemId whenever the name changes (see
    // routes/activities.ts) — mirror that here before reconciling.
    await db.transaction(async (tx) => {
      const warehouseItemId = await resolveWarehouseItemIdByName(
        tx,
        `Spojka B ${TAG}`,
      );
      const [m] = await tx
        .update(activityMaterialsTable)
        .set({ name: `Spojka B ${TAG}`, warehouseItemId })
        .where(eq(activityMaterialsTable.id, materialId))
        .returning();
      await reconcileActivityMaterialStockMovement(
        tx,
        {
          id: m.id,
          name: m.name,
          quantity: m.quantity,
          pricePerUnit: m.pricePerUnit,
          jobId: null,
          warehouseItemId: m.warehouseItemId,
        },
        actor,
      );
    });
    expect(await expectConsistent(itemA)).toBeCloseTo(100, 2);
    expect(await expectConsistent(itemB)).toBeCloseTo(70, 2);

    // The source's net contribution is fully on B now.
    expect(
      await netSignedForSources(db, "activity_material", [materialId]),
    ).toBeCloseTo(-30, 2);
  });
});

describe("cost-document line split", () => {
  /** The current line ids of a document, in sort order. */
  async function docLineIds(documentId: number): Promise<number[]> {
    const rows = await db
      .select({ id: billingDocumentLinesTable.id })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, documentId))
      .orderBy(
        billingDocumentLinesTable.sortOrder,
        billingDocumentLinesTable.id,
      );
    return rows.map((r) => r.id);
  }

  it("rejects splitting an approved stock line without changing its ledger", async () => {
    const itemId = await makeItem({
      name: `Trubka ${TAG}`,
      code: `SKU-SPLIT-${TAG}`,
    });
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

    await expect(
      splitLine(docId, lineId, [{ quantity: 25 }, { quantity: 15 }], actor),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await expectConsistent(itemId)).toBeCloseTo(40, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(40, 2);
    const partIds = await docLineIds(docId);
    expect(partIds).toEqual([lineId]);
    expect(await ledgerSum(itemId)).toBeCloseTo(40, 2);
  });

  it("allows splitting an unapproved line into three parts", async () => {
    const itemId = await makeItem({
      name: `Kabel3 ${TAG}`,
      code: `SKU-3-${TAG}`,
    });
    const { docId, lineId } = await makeStockDoc({
      description: `Kabel3 ${TAG}`,
      quantity: "12.5",
      supplierSku: `SKU-3-${TAG}`,
    });

    await splitLine(
      docId,
      lineId,
      [{ quantity: 5 }, { quantity: 4.5 }, { quantity: 3 }],
      actor,
    );

    expect(await expectConsistent(itemId)).toBeCloseTo(0, 2);
    expect(
      await netSignedForSources(db, "billing_document_line", [lineId]),
    ).toBeCloseTo(0, 2);

    const partIds = await docLineIds(docId);
    expect(partIds).toHaveLength(3);
    expect(
      await netSignedForSources(db, "billing_document_line", partIds),
    ).toBeCloseTo(0, 2);
  });
});
