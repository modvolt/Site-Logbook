import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  jobsTable,
  materialsTable,
  activityMaterialsTable,
  activitiesTable,
  warehouseItemsTable,
  warehouseMovementsTable,
} from "@workspace/db";
import {
  reconcileMaterialStockMovement,
  reconcileActivityMaterialStockMovement,
  reconcileSourceMovements,
  resolveWarehouseItemIdByName,
  resolveOrCreateWarehouseItemByName,
} from "../src/lib/warehouse-service";

/**
 * P1.4: Stable FK binding between job/activity materials and warehouse cards.
 *
 * Scenarios:
 * 1. Two items with the same name → resolveWarehouseItemIdByName returns null (ambiguous).
 * 2. Renaming the warehouse item: existing material still issues against the
 *    correct item by ID; a name-only lookup after rename finds nothing.
 * 3. Concurrent document approval doesn't create duplicate warehouse cards.
 * 4. Creating/editing/deleting a material: movements round-trip correctly.
 * 5. Storno (null desired) reverses the ledger; audit movement rows preserved.
 */

const TAG = `wfk-${Date.now()}`;
const ACTOR = { userId: null as null, name: "Test" };

// Cleanup ids
const jobIds: number[] = [];
const activityIds: number[] = [];
const materialIds: number[] = [];
const activityMaterialIds: number[] = [];
const warehouseItemIds: number[] = [];
let customerId: number;

async function makeJob(): Promise<number> {
  const [j] = await db
    .insert(jobsTable)
    .values({ title: `Job ${TAG}`, date: "2026-01-01", status: "planned" })
    .returning();
  jobIds.push(j.id);
  return j.id;
}

async function makeWarehouseItem(name: string, purchasePrice?: string): Promise<number> {
  const [item] = await db
    .insert(warehouseItemsTable)
    .values({ name, quantity: "0", purchasePrice: purchasePrice ?? null })
    .returning();
  warehouseItemIds.push(item.id);
  return item.id;
}

beforeAll(async () => {
  const [cust] = await db
    .insert(customersTable)
    .values({ companyName: `Cust ${TAG}` })
    .returning();
  customerId = cust.id;
});

afterAll(async () => {
  // Clean up in reverse-dependency order
  if (materialIds.length) {
    await db.delete(materialsTable).where(inArray(materialsTable.id, materialIds));
  }
  if (activityMaterialIds.length) {
    await db.delete(activityMaterialsTable).where(inArray(activityMaterialsTable.id, activityMaterialIds));
  }
  if (activityIds.length) {
    await db.delete(activitiesTable).where(inArray(activitiesTable.id, activityIds));
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  if (warehouseItemIds.length) {
    await db.delete(warehouseItemsTable).where(inArray(warehouseItemsTable.id, warehouseItemIds));
  }
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

// ---------------------------------------------------------------------------
// 1. Two items with the same name → resolveWarehouseItemIdByName returns null
// ---------------------------------------------------------------------------
describe("duplicate-name items", () => {
  it("resolveWarehouseItemIdByName returns null when two items share a name", async () => {
    const name = `Kabel ${TAG} dupe`;
    const id1 = await makeWarehouseItem(name);
    const id2 = await makeWarehouseItem(name);

    const resolved = await db.transaction((tx) => resolveWarehouseItemIdByName(tx, name));
    expect(resolved).toBeNull();

    // But an exact-unique name resolves correctly
    const unique = `Kabel ${TAG} unique`;
    const uid = await makeWarehouseItem(unique);
    const resolvedUnique = await db.transaction((tx) => resolveWarehouseItemIdByName(tx, unique));
    expect(resolvedUnique).toBe(uid);

    warehouseItemIds.push(id1, id2, uid);
  });

  it("reconcileMaterialLike with warehouseItemId uses ID, not name (immune to duplicates)", async () => {
    const name = `Materiál ${TAG} dupe2`;
    const id1 = await makeWarehouseItem(name, "100");
    const id2 = await makeWarehouseItem(name, "200");

    const jobId = await makeJob();
    const [m] = await db
      .insert(materialsTable)
      .values({ jobId, name, quantity: "3", pricePerUnit: "150", warehouseItemId: id1 })
      .returning();
    materialIds.push(m.id);

    // Reconcile: should issue against id1, not id2
    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m, ACTOR));

    const movements = await db
      .select()
      .from(warehouseMovementsTable)
      .where(
        and(
          eq(warehouseMovementsTable.sourceType, "material"),
          eq(warehouseMovementsTable.sourceId, m.id),
        ),
      );

    expect(movements.length).toBeGreaterThanOrEqual(1);
    // All movements must target id1, never id2
    for (const mov of movements) {
      expect(mov.warehouseItemId).toBe(id1);
    }

    warehouseItemIds.push(id1, id2);
  });
});

// ---------------------------------------------------------------------------
// 2. Renaming the warehouse item: ID-linked material still issues correctly
// ---------------------------------------------------------------------------
describe("item rename stability", () => {
  it("material linked by ID still issues correctly after warehouse item is renamed", async () => {
    const originalName = `Vodič ${TAG} orig`;
    const renamedName = `Vodič ${TAG} renamed`;
    const itemId = await makeWarehouseItem(originalName, "50");

    const jobId = await makeJob();
    const [m] = await db
      .insert(materialsTable)
      .values({ jobId, name: originalName, quantity: "2", warehouseItemId: itemId })
      .returning();
    materialIds.push(m.id);

    // Rename the warehouse item
    await db
      .update(warehouseItemsTable)
      .set({ name: renamedName })
      .where(eq(warehouseItemsTable.id, itemId));

    // A name-based lookup would now find nothing for originalName
    const byName = await db.transaction((tx) => resolveWarehouseItemIdByName(tx, originalName));
    expect(byName).toBeNull();

    // But reconcile by ID must still work (material.warehouseItemId = itemId)
    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m, ACTOR));

    const movements = await db
      .select()
      .from(warehouseMovementsTable)
      .where(
        and(
          eq(warehouseMovementsTable.sourceType, "material"),
          eq(warehouseMovementsTable.sourceId, m.id),
        ),
      );

    expect(movements.length).toBeGreaterThanOrEqual(1);
    for (const mov of movements) {
      expect(mov.warehouseItemId).toBe(itemId);
    }

    // Also check the item quantity was updated
    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBeLessThan(0); // issued → negative
  });
});

// ---------------------------------------------------------------------------
// 3. Create / edit / delete material — movements round-trip
// ---------------------------------------------------------------------------
describe("material lifecycle movements", () => {
  it("creating a material with warehouseItemId issues stock", async () => {
    const itemId = await makeWarehouseItem(`Spínač ${TAG}`, "30");
    const jobId = await makeJob();

    const [m] = await db
      .insert(materialsTable)
      .values({ jobId, name: `Spínač ${TAG}`, quantity: "5", warehouseItemId: itemId })
      .returning();
    materialIds.push(m.id);

    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m, ACTOR));

    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBe(-5);
  });

  it("editing quantity updates the ledger with a delta", async () => {
    const itemId = await makeWarehouseItem(`Relé ${TAG}`, "80");
    const jobId = await makeJob();

    // Create with qty 4
    const [m1] = await db
      .insert(materialsTable)
      .values({ jobId, name: `Relé ${TAG}`, quantity: "4", warehouseItemId: itemId })
      .returning();
    materialIds.push(m1.id);
    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m1, ACTOR));

    // Edit to qty 7
    const [m2] = await db
      .update(materialsTable)
      .set({ quantity: "7" })
      .where(eq(materialsTable.id, m1.id))
      .returning();
    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m2, ACTOR));

    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBe(-7);
  });

  it("deleting material reverses its stock issue (storno), preserving movement history", async () => {
    const itemId = await makeWarehouseItem(`Jistič ${TAG}`, "120");
    const jobId = await makeJob();

    const [m] = await db
      .insert(materialsTable)
      .values({ jobId, name: `Jistič ${TAG}`, quantity: "3", warehouseItemId: itemId })
      .returning();
    // Note: NOT adding to materialIds since we delete it below

    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m, ACTOR));

    // Delete + storno
    await db.transaction(async (tx) => {
      await tx.delete(materialsTable).where(eq(materialsTable.id, m.id));
      await reconcileSourceMovements(tx, "material", m.id, null, ACTOR);
    });

    // Quantity back to 0
    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBe(0);

    // Audit: movement rows must still exist (append-only ledger)
    const movements = await db
      .select()
      .from(warehouseMovementsTable)
      .where(
        and(
          eq(warehouseMovementsTable.sourceType, "material"),
          eq(warehouseMovementsTable.sourceId, m.id),
        ),
      );
    expect(movements.length).toBeGreaterThanOrEqual(2); // issue + storno
  });
});

// ---------------------------------------------------------------------------
// 4. Activity materials also use ID-based routing
// ---------------------------------------------------------------------------
describe("activity material FK", () => {
  it("activity material linked by warehouseItemId issues stock correctly", async () => {
    const itemId = await makeWarehouseItem(`Konektor ${TAG}`, "15");

    const [act] = await db
      .insert(activitiesTable)
      .values({ name: `Akce ${TAG}`, createdByUserId: null })
      .returning();
    activityIds.push(act.id);

    const [am] = await db
      .insert(activityMaterialsTable)
      .values({ activityId: act.id, name: `Konektor ${TAG}`, quantity: "10", warehouseItemId: itemId })
      .returning();
    activityMaterialIds.push(am.id);

    await db.transaction((tx) =>
      reconcileActivityMaterialStockMovement(tx, { id: am.id, name: am.name, quantity: am.quantity, pricePerUnit: am.pricePerUnit, jobId: null, warehouseItemId: am.warehouseItemId }, ACTOR)
    );

    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBe(-10);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveWarehouseItemIdByName — case-insensitive, single match
// ---------------------------------------------------------------------------
describe("resolveWarehouseItemIdByName", () => {
  it("matches case-insensitively and returns the ID for a unique name", async () => {
    const name = `Proudová lišta ${TAG}`;
    const itemId = await makeWarehouseItem(name);

    const resolved = await db.transaction((tx) =>
      resolveWarehouseItemIdByName(tx, name.toUpperCase())
    );
    expect(resolved).toBe(itemId);
  });

  it("returns null for a name that doesn't match any item", async () => {
    const resolved = await db.transaction((tx) =>
      resolveWarehouseItemIdByName(tx, `NonExistent ${TAG} xyz`)
    );
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. NULL warehouseItemId → no movement issued (no silent name-fallback)
// ---------------------------------------------------------------------------
describe("null warehouseItemId guard", () => {
  it("does not issue stock when warehouseItemId is null even if a name-matching item exists", async () => {
    const name = `Ochrana ${TAG} null-guard`;
    const itemId = await makeWarehouseItem(name, "60");

    const jobId = await makeJob();
    // Insert material WITHOUT a warehouseItemId link (simulates a legacy row or
    // an ambiguous-name row that the backfill skipped).
    const [m] = await db
      .insert(materialsTable)
      .values({ jobId, name, quantity: "3", warehouseItemId: null })
      .returning();
    materialIds.push(m.id);

    // Reconcile should produce zero movements because warehouseItemId is null.
    await db.transaction((tx) => reconcileMaterialStockMovement(tx, m, ACTOR));

    const movements = await db
      .select()
      .from(warehouseMovementsTable)
      .where(
        and(
          eq(warehouseMovementsTable.sourceType, "material"),
          eq(warehouseMovementsTable.sourceId, m.id),
        ),
      );

    expect(movements.length).toBe(0);

    // The warehouse item quantity must remain at 0 (untouched).
    const [item] = await db
      .select({ quantity: warehouseItemsTable.quantity })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, itemId));
    expect(Number(item.quantity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Advisory-lock concurrency: resolveOrCreateWarehouseItemByName
//    Two concurrent transactions racing on the same name must produce exactly
//    one warehouse card, not two duplicates.
// ---------------------------------------------------------------------------
describe("advisory lock — no duplicate warehouse cards on concurrent creation", () => {
  it("produces exactly one warehouse item when two transactions race on the same name", async () => {
    const name = `Souběh ${TAG} lock-test`;

    // Fire two concurrent transactions. Because both call
    // resolveOrCreateWarehouseItemByName, the advisory lock serialises the
    // critical section: the second transaction to acquire the lock will find
    // the item already created by the first and return it instead of inserting.
    const [r1, r2] = await Promise.all([
      db.transaction((tx) =>
        resolveOrCreateWarehouseItemByName(tx, name, { purchasePrice: "10" }),
      ),
      db.transaction((tx) =>
        resolveOrCreateWarehouseItemByName(tx, name, { purchasePrice: "10" }),
      ),
    ]);

    // Both calls must return the same item ID.
    expect(r1.id).toBe(r2.id);

    // Exactly one row with this name must exist in the DB.
    const rows = await db
      .select({ id: warehouseItemsTable.id })
      .from(warehouseItemsTable)
      .where(sql`lower(${warehouseItemsTable.name}) = lower(${name})`);
    expect(rows.length).toBe(1);

    warehouseItemIds.push(r1.id);
  });
});
