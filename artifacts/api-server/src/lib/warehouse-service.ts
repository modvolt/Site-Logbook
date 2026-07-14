/**
 * Skladové hospodářství — stock-movement ledger engine.
 *
 * One place that knows how to turn "this source (a cost-document line / a job
 * material) should currently contribute N units of signed stock to item X" into
 * an APPEND-ONLY ledger of movements, while keeping `warehouse_items.quantity`
 * exactly equal to the signed sum of an item's movements.
 *
 * The central primitive is {@link reconcileSourceMovements}: given the *desired*
 * net contribution of one source, it appends a single delta movement so the
 * ledger matches — which naturally covers create (0→N), edit (N→M), storno /
 * delete / un-approve (N→0) and re-match to a different item (old→0, new→N).
 * Movements are never deleted, so history is preserved. Every write locks the
 * affected `warehouse_items` row FOR UPDATE so two concurrent operations on the
 * same item serialize and the quantity never drifts.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  billingDocumentsTable,
  billingDocumentLinesTable,
  jobsTable,
  warehouseItemsTable,
  warehouseMovementsTable,
  warehousePriceHistoryTable,
  type WarehouseMovement,
} from "@workspace/db";
import { num, round2 } from "./invoice-calc";
import { materialShouldIssueStock } from "./material-consumption-policy";

export type AppError = Error & { statusCode: number };
function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

export interface Actor {
  userId: number | null;
  name: string;
}

type AnyDb = typeof import("@workspace/db").db;
type DbTx = AnyDb | Parameters<Parameters<AnyDb["transaction"]>[0]>[0];

// Quantities below this are treated as zero (numeric(12,2) → 2 decimals).
const EPSILON = 0.005;

export type MovementSourceType =
  | "billing_document_line"
  | "material"
  | "activity_material"
  | "manual";

interface DesiredContribution {
  warehouseItemId: number;
  /** Signed: positive = receipt (in), negative = issue (out). */
  signedQty: number;
  unitPrice: number | null;
  billingDocumentId: number | null;
  jobId: number | null;
  note: string | null;
}

/**
 * Lock the warehouse item row, recompute its quantity from the full signed sum
 * of its movements, and persist it. Must run inside the caller's transaction
 * AFTER any new movement for the item has been inserted.
 */
async function recomputeItemQuantity(
  tx: DbTx,
  warehouseItemId: number,
): Promise<void> {
  const res = (await tx.execute(sql`
    select coalesce(sum(case when ${warehouseMovementsTable.direction} = 'in'
                              then ${warehouseMovementsTable.quantity}
                              else -${warehouseMovementsTable.quantity} end), 0) as qty
    from ${warehouseMovementsTable}
    where ${warehouseMovementsTable.warehouseItemId} = ${warehouseItemId}
  `)) as unknown as { rows: Array<{ qty: string | number }> };
  const qty = round2(num(res.rows[0]?.qty ?? 0));
  await tx
    .update(warehouseItemsTable)
    .set({ quantity: String(qty) })
    .where(eq(warehouseItemsTable.id, warehouseItemId));
}

/** Sum of a source's existing signed movements against one item. */
async function appliedSignedFor(
  tx: DbTx,
  sourceType: MovementSourceType,
  sourceId: number,
  warehouseItemId: number,
): Promise<number> {
  const res = (await tx.execute(sql`
    select coalesce(sum(case when ${warehouseMovementsTable.direction} = 'in'
                              then ${warehouseMovementsTable.quantity}
                              else -${warehouseMovementsTable.quantity} end), 0) as qty
    from ${warehouseMovementsTable}
    where ${warehouseMovementsTable.sourceType} = ${sourceType}
      and ${warehouseMovementsTable.sourceId} = ${sourceId}
      and ${warehouseMovementsTable.warehouseItemId} = ${warehouseItemId}
  `)) as unknown as { rows: Array<{ qty: string | number }> };
  return num(res.rows[0]?.qty ?? 0);
}

async function lockItem(
  tx: DbTx,
  warehouseItemId: number,
): Promise<{ purchasePrice: string | null }> {
  const res = (await tx.execute(sql`
    select purchase_price from ${warehouseItemsTable}
    where ${warehouseItemsTable.id} = ${warehouseItemId} for update
  `)) as unknown as { rows: Array<{ purchase_price: string | null }> };
  return { purchasePrice: res.rows[0]?.purchase_price ?? null };
}

/**
 * Returns the most recent purchase_price from price history for the given item,
 * or null if no history exists. Used as a fallback when the item has no current
 * purchase_price set but an OUT movement still needs a cost_price_at_time.
 */
async function latestHistoryPrice(
  tx: DbTx,
  warehouseItemId: number,
): Promise<string | null> {
  const [entry] = await tx
    .select({ purchasePrice: warehousePriceHistoryTable.purchasePrice })
    .from(warehousePriceHistoryTable)
    .where(eq(warehousePriceHistoryTable.warehouseItemId, warehouseItemId))
    .orderBy(desc(warehousePriceHistoryTable.createdAt), desc(warehousePriceHistoryTable.id))
    .limit(1);
  return entry?.purchasePrice ?? null;
}

async function appendDelta(
  tx: DbTx,
  params: {
    warehouseItemId: number;
    delta: number;
    sourceType: MovementSourceType;
    sourceId: number | null;
    unitPrice: number | null;
    billingDocumentId: number | null;
    jobId: number | null;
    note: string | null;
    actor: Actor;
  },
): Promise<void> {
  const { delta } = params;
  if (Math.abs(delta) < EPSILON) return;
  const { purchasePrice } = await lockItem(tx, params.warehouseItemId);
  const isOut = delta < 0;
  // Capture the purchase price at the time of issue for OUT movements so that
  // gross-profit statistics can be computed per period.
  // If the item has no current purchase_price, fall back to the most recent
  // price-history entry so fewer movements end up with a NULL cost_price_at_time.
  let costPriceAtTime: string | null = null;
  if (isOut) {
    const rawPrice = purchasePrice ?? await latestHistoryPrice(tx, params.warehouseItemId);
    if (rawPrice != null) costPriceAtTime = String(round2(num(rawPrice)));
  }
  await tx.insert(warehouseMovementsTable).values({
    warehouseItemId: params.warehouseItemId,
    direction: isOut ? "out" : "in",
    quantity: String(round2(Math.abs(delta))),
    unitPrice: params.unitPrice == null ? null : String(round2(params.unitPrice)),
    costPriceAtTime,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    billingDocumentId: params.billingDocumentId,
    jobId: params.jobId,
    note: params.note,
    createdByUserId: params.actor.userId,
    createdByName: params.actor.name,
  });
  await recomputeItemQuantity(tx, params.warehouseItemId);
}

/**
 * Make the ledger reflect `desired` for one source. Appends delta movements:
 * any item the source previously touched but no longer targets is reversed to
 * zero, and the target item is adjusted to the desired signed quantity.
 */
export async function reconcileSourceMovements(
  tx: DbTx,
  sourceType: MovementSourceType,
  sourceId: number,
  desired: DesiredContribution | null,
  actor: Actor,
): Promise<void> {
  // Items this source has already moved (so we can reverse stale targets).
  const existingRows = await tx
    .select({
      warehouseItemId: warehouseMovementsTable.warehouseItemId,
      billingDocumentId: warehouseMovementsTable.billingDocumentId,
      jobId: warehouseMovementsTable.jobId,
    })
    .from(warehouseMovementsTable)
    .where(
      and(
        eq(warehouseMovementsTable.sourceType, sourceType),
        eq(warehouseMovementsTable.sourceId, sourceId),
      ),
    );

  // Keep the original business-document links on reversal rows. Without this,
  // the stock total is correct but the storno disappears from job/document
  // history views that filter movements by these foreign keys.
  const existing = new Map<
    number,
    { warehouseItemId: number; billingDocumentId: number | null; jobId: number | null }
  >();
  for (const row of existingRows) {
    const current = existing.get(row.warehouseItemId);
    existing.set(row.warehouseItemId, {
      warehouseItemId: row.warehouseItemId,
      billingDocumentId: current?.billingDocumentId ?? row.billingDocumentId,
      jobId: current?.jobId ?? row.jobId,
    });
  }

  for (const { warehouseItemId, billingDocumentId, jobId } of existing.values()) {
    if (desired && desired.warehouseItemId === warehouseItemId) continue;
    const applied = await appliedSignedFor(tx, sourceType, sourceId, warehouseItemId);
    await appendDelta(tx, {
      warehouseItemId,
      delta: -applied,
      sourceType,
      sourceId,
      unitPrice: null,
      billingDocumentId,
      jobId,
      note: "Storno pohybu",
      actor,
    });
  }

  if (desired) {
    const applied = await appliedSignedFor(
      tx,
      sourceType,
      sourceId,
      desired.warehouseItemId,
    );
    await appendDelta(tx, {
      warehouseItemId: desired.warehouseItemId,
      delta: round2(desired.signedQty) - round2(applied),
      sourceType,
      sourceId,
      unitPrice: desired.unitPrice,
      billingDocumentId: desired.billingDocumentId,
      jobId: desired.jobId,
      note: desired.note,
      actor,
    });
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

type WarehouseItemRow = typeof warehouseItemsTable.$inferSelect;

async function loadItemMaps(tx: DbTx): Promise<{
  byCode: Map<string, WarehouseItemRow>;
  byName: Map<string, WarehouseItemRow>;
}> {
  const items = await tx.select().from(warehouseItemsTable);
  const byCode = new Map<string, WarehouseItemRow>();
  const byName = new Map<string, WarehouseItemRow>();
  for (const it of items) {
    if (it.code) byCode.set(it.code.trim().toLowerCase(), it);
    byName.set(it.name.trim().toLowerCase(), it);
  }
  return { byCode, byName };
}

// ---------------------------------------------------------------------------
// Cost-document receipts (příjem / naskladnění)
// ---------------------------------------------------------------------------

/**
 * Reconcile all of a cost document's stock-allocated lines against the warehouse.
 *
 * When the document is approved, every material line with allocationType="stock"
 * receives its quantity into the matching warehouse item (matched by SKU/EAN,
 * else name; an unmatched line auto-creates a new warehouse item so receiving
 * never fails). When the document is anything other than approved (un-approved,
 * ignored, …) every line's contribution is reversed back to zero. Must run
 * inside the caller's transaction.
 */
export async function reconcileDocumentStockMovements(
  tx: DbTx,
  documentId: number,
  actor: Actor,
): Promise<void> {
  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) return;

  const lines = await tx
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, documentId));

  const approved = doc.status === "approved";
  const maps = approved ? await loadItemMaps(tx) : null;

  for (const line of lines) {
    const isStockReceipt =
      approved &&
      !line.feeType &&
      line.lineType === "material" &&
      line.allocationType === "stock";

    if (!isStockReceipt) {
      await reconcileSourceMovements(tx, "billing_document_line", line.id, null, actor);
      continue;
    }

    const item = await resolveOrCreateItemForLine(tx, line, maps!);
    const qty = round2(num(line.quantity));
    await reconcileSourceMovements(tx, "billing_document_line", line.id, {
      warehouseItemId: item.id,
      signedQty: qty, // receipt → +
      unitPrice: line.unitPriceWithoutVat == null ? null : num(line.unitPriceWithoutVat),
      billingDocumentId: documentId,
      jobId: line.jobId ?? doc.jobId ?? null,
      note: doc.documentNumber ? `Příjem z dokladu ${doc.documentNumber}` : "Příjem z dokladu",
    }, actor);
  }
}

/**
 * Find-or-create a warehouse item by name under a transaction-scoped advisory
 * lock so that two concurrent transactions racing on the same name cannot each
 * see "no match" and both insert a duplicate card.
 *
 * - Acquires `pg_advisory_xact_lock(hashtext(normalizedName))` before the
 *   re-check INSERT so the critical section is serialised at the DB level.
 * - Returns the existing item (possibly created by a concurrent transaction
 *   that just committed) or the freshly-created one.
 * - Exported so the advisory-lock + re-check behaviour can be tested directly.
 */
export async function resolveOrCreateWarehouseItemByName(
  tx: DbTx,
  name: string,
  opts: { code?: string | null; unit?: string | null; purchasePrice?: string | null },
): Promise<WarehouseItemRow> {
  const normalizedName = name.trim().toLowerCase();

  // Acquire advisory lock before the re-check to prevent concurrent duplicates.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${normalizedName}))`);

  const [existing] = await tx
    .select()
    .from(warehouseItemsTable)
    .where(sql`lower(${warehouseItemsTable.name}) = ${normalizedName}`)
    .limit(1);
  if (existing) return existing;

  const [created] = await tx
    .insert(warehouseItemsTable)
    .values({
      name: name.trim(),
      code: opts.code ?? null,
      unit: opts.unit ?? null,
      quantity: "0",
      purchasePrice: opts.purchasePrice ?? null,
    })
    .returning();
  return created;
}

async function resolveOrCreateItemForLine(
  tx: DbTx,
  line: typeof billingDocumentLinesTable.$inferSelect,
  maps: { byCode: Map<string, WarehouseItemRow>; byName: Map<string, WarehouseItemRow> },
): Promise<WarehouseItemRow> {
  const codeKeys = [line.supplierSku, line.ean]
    .filter((c): c is string => !!c)
    .map((c) => c.trim().toLowerCase());
  let item = codeKeys.map((k) => maps.byCode.get(k)).find(Boolean);
  if (!item) item = maps.byName.get(line.description.trim().toLowerCase());
  if (item) return item;

  const code = (line.supplierSku ?? line.ean ?? "")?.trim() || null;
  const created = await resolveOrCreateWarehouseItemByName(tx, line.description, {
    code,
    unit: line.unit ?? null,
    purchasePrice:
      line.unitPriceWithoutVat == null ? null : String(round2(num(line.unitPriceWithoutVat))),
  });
  if (code) maps.byCode.set(code.toLowerCase(), created);
  maps.byName.set(created.name.trim().toLowerCase(), created);
  return created;
}

// ---------------------------------------------------------------------------
// Job / activity material issues (výdej / odpis)
// ---------------------------------------------------------------------------

interface MaterialLike {
  id: number;
  name: string;
  quantity: string | null;
  pricePerUnit: string | null;
  jobId: number | null;
  /** Job materials affect stock only after explicit consumption. Activity
   * materials keep their existing immediate-issue behaviour. */
  done?: boolean;
  /** Stable FK to a warehouse card, set on the DB row. When non-null the lookup
   *  is ID-based so renames and name duplicates never mis-route the issue. */
  warehouseItemId?: number | null;
}

/**
 * Resolve which warehouse item should receive an issue movement for a given
 * material.
 *
 * Resolution is strictly ID-based: if `warehouseItemId` is set the
 * corresponding warehouse card is fetched; if it is null/undefined, no item is
 * returned and reconcile will not issue any stock movement.
 *
 * Name-based resolution happens only at *save time* (via
 * `resolveWarehouseItemIdByName` in the routes / import flow) so that the ID
 * is persisted on the material row before reconcile is ever called. This
 * design is immune to renames and duplicate names — once the FK is stored the
 * movement target never changes unless the row is explicitly re-saved with a
 * new ID.
 */
async function resolveItemForMaterial(
  tx: DbTx,
  material: MaterialLike,
): Promise<WarehouseItemRow | undefined> {
  if (material.warehouseItemId == null) return undefined;
  const [row] = await tx
    .select()
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, material.warehouseItemId));
  return row;
}

/**
 * Given a material name, find the warehouse item ID for an unambiguous name
 * match (exactly one item with that name). Returns null when there is no match
 * or when there are two or more items with the same name (to avoid silent
 * mis-linking).
 *
 * Callers (create/update routes) use this to populate `warehouseItemId` on the
 * material row so future reconcile calls are ID-based.
 */
export async function resolveWarehouseItemIdByName(
  tx: DbTx,
  name: string,
): Promise<number | null> {
  const key = name.trim().toLowerCase();
  const rows = await tx
    .select({ id: warehouseItemsTable.id })
    .from(warehouseItemsTable)
    .where(sql`lower(${warehouseItemsTable.name}) = ${key}`);
  return rows.length === 1 ? rows[0].id : null;
}

async function reconcileMaterialLike(
  tx: DbTx,
  sourceType: "material" | "activity_material",
  material: MaterialLike | null,
  actor: Actor,
): Promise<void> {
  if (!material) return;
  const item = await resolveItemForMaterial(tx, material);
  const qty = material.quantity == null ? 0 : round2(num(material.quantity));
  const shouldIssue = materialShouldIssueStock(sourceType, material);
  const desired: DesiredContribution | null =
    shouldIssue && item && qty > 0
      ? {
          warehouseItemId: item.id,
          signedQty: -qty, // issue → −
          unitPrice: material.pricePerUnit == null ? null : num(material.pricePerUnit),
          billingDocumentId: null,
          jobId: material.jobId,
          note: "Výdej na zakázku",
        }
      : null;
  await reconcileSourceMovements(tx, sourceType, material.id, desired, actor);
}

/** Reconcile a single job material's issue movement. */
export async function reconcileMaterialStockMovement(
  tx: DbTx,
  material: MaterialLike | null,
  actor: Actor,
): Promise<void> {
  await reconcileMaterialLike(tx, "material", material, actor);
}

/** Reconcile a single activity material's issue movement. */
export async function reconcileActivityMaterialStockMovement(
  tx: DbTx,
  material: MaterialLike | null,
  actor: Actor,
): Promise<void> {
  await reconcileMaterialLike(tx, "activity_material", material, actor);
}

// ---------------------------------------------------------------------------
// Backfill cost prices on existing OUT movements (called on document approval)
// ---------------------------------------------------------------------------

/**
 * Backfill `costPriceAtTime` on OUT movements that were created on or after
 * `sinceDate` and still have the field set to null. Called as part of document
 * approval after the catalogue prices have been updated; idempotent — only
 * touches rows where `costPriceAtTime` is still null.
 *
 * Each updated row gets the backfill source appended to its `note` column so
 * the audit trail makes it clear the price was filled retroactively, not at
 * movement creation time.
 *
 * Returns the total number of movement rows updated.
 */
export async function backfillOutMovementCostPrices(
  tx: DbTx,
  updates: Array<{ warehouseItemId: number; purchasePrice: number }>,
  sinceDate: Date,
  documentLabel: string,
): Promise<number> {
  let total = 0;
  const flag = `Zpětně doplněna nák. cena z ${documentLabel}`;
  for (const { warehouseItemId, purchasePrice } of updates) {
    if (!(purchasePrice > 0)) continue;
    const result = await tx
      .update(warehouseMovementsTable)
      .set({
        costPriceAtTime: String(round2(purchasePrice)),
        note: sql<string>`CASE
          WHEN ${warehouseMovementsTable.note} IS NULL OR ${warehouseMovementsTable.note} = ''
          THEN ${flag}
          ELSE ${warehouseMovementsTable.note} || ' · ' || ${flag}
        END`,
      })
      .where(
        and(
          eq(warehouseMovementsTable.warehouseItemId, warehouseItemId),
          eq(warehouseMovementsTable.direction, "out"),
          isNull(warehouseMovementsTable.costPriceAtTime),
          gte(warehouseMovementsTable.createdAt, sinceDate),
        ),
      );
    total += result.rowCount ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Manual correction movements
// ---------------------------------------------------------------------------

export async function createManualMovement(
  db: typeof import("@workspace/db").db,
  warehouseItemId: number,
  input: {
    direction: "in" | "out";
    quantity: number;
    unitPrice?: number | null;
    note?: string | null;
    idempotencyKey?: string | null;
  },
  actor: Actor,
): Promise<WarehouseMovement> {
  const qty = round2(input.quantity);
  if (!(qty > 0)) throw appError(400, "Množství musí být kladné.");
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, warehouseItemId));
    if (!item) throw appError(404, "Skladová položka nenalezena.");
    await lockItem(tx, warehouseItemId);
    const isOut = input.direction === "out";
    // If the item has no current purchase_price, fall back to the most recent
    // price-history entry so fewer OUT movements end up with a NULL cost_price_at_time.
    let costPriceAtTime: string | null = null;
    if (isOut) {
      const rawPrice = item.purchasePrice ?? await latestHistoryPrice(tx, warehouseItemId);
      if (rawPrice != null) costPriceAtTime = String(round2(num(rawPrice)));
    }
    const [movement] = await tx
      .insert(warehouseMovementsTable)
      .values({
        warehouseItemId,
        direction: input.direction,
        quantity: String(qty),
        unitPrice:
          input.unitPrice == null ? null : String(round2(input.unitPrice)),
        costPriceAtTime,
        sourceType: "manual",
        sourceId: null,
        idempotencyKey: input.idempotencyKey ?? null,
        note: input.note?.trim() || "Ruční korekce",
        createdByUserId: actor.userId,
        createdByName: actor.name,
      })
      .returning();
    await recomputeItemQuantity(tx, warehouseItemId);

    // For IN movements with a unit price, record a purchase-price history entry
    // if the price differs from the most recent history row (or no history exists).
    // Also keep warehouse_items.purchase_price in sync so future OUT movements
    // capture the latest known cost.
    if (!isOut && input.unitPrice != null) {
      const newPrice = round2(input.unitPrice);
      const [lastEntry] = await tx
        .select({ purchasePrice: warehousePriceHistoryTable.purchasePrice })
        .from(warehousePriceHistoryTable)
        .where(eq(warehousePriceHistoryTable.warehouseItemId, warehouseItemId))
        .orderBy(desc(warehousePriceHistoryTable.createdAt), desc(warehousePriceHistoryTable.id))
        .limit(1);
      const lastPrice = lastEntry ? num(lastEntry.purchasePrice) : null;
      if (lastPrice === null || Math.abs(lastPrice - newPrice) >= EPSILON) {
        await tx.insert(warehousePriceHistoryTable).values({
          warehouseItemId,
          purchasePrice: String(newPrice),
          note: input.note?.trim() || "Ruční příjem",
          createdByUserId: actor.userId,
          createdByName: actor.name,
        });
        await tx
          .update(warehouseItemsTable)
          .set({ purchasePrice: String(newPrice) })
          .where(eq(warehouseItemsTable.id, warehouseItemId));
      }
    }

    return movement;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SerializedMovement {
  id: number;
  warehouseItemId: number;
  warehouseItemName: string | null;
  direction: string;
  quantity: number;
  signedQuantity: number;
  unitPrice: number | null;
  costPriceAtTime: number | null;
  sourceType: string;
  sourceId: number | null;
  billingDocumentId: number | null;
  documentNumber: string | null;
  jobId: number | null;
  jobTitle: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

type MovementJoinRow = {
  movement: WarehouseMovement;
  itemName: string | null;
  documentNumber: string | null;
  jobTitle: string | null;
};

function serializeMovement(row: MovementJoinRow): SerializedMovement {
  const m = row.movement;
  const qty = num(m.quantity);
  return {
    id: m.id,
    warehouseItemId: m.warehouseItemId,
    warehouseItemName: row.itemName,
    direction: m.direction,
    quantity: qty,
    signedQuantity: m.direction === "in" ? qty : -qty,
    unitPrice: m.unitPrice == null ? null : num(m.unitPrice),
    costPriceAtTime: m.costPriceAtTime == null ? null : num(m.costPriceAtTime),
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    billingDocumentId: m.billingDocumentId,
    documentNumber: row.documentNumber,
    jobId: m.jobId,
    jobTitle: row.jobTitle,
    note: m.note,
    createdByName: m.createdByName,
    createdAt: m.createdAt.toISOString(),
  };
}

export interface MovementFilters {
  warehouseItemId?: number;
  jobId?: number;
  billingDocumentId?: number;
  direction?: "in" | "out";
  from?: string; // ISO date YYYY-MM-DD (inclusive)
  to?: string; // ISO date YYYY-MM-DD (inclusive)
  limit?: number;
}

export async function listMovements(
  db: typeof import("@workspace/db").db,
  filters: MovementFilters,
): Promise<SerializedMovement[]> {
  const conds = [];
  if (filters.warehouseItemId != null)
    conds.push(eq(warehouseMovementsTable.warehouseItemId, filters.warehouseItemId));
  if (filters.jobId != null) conds.push(eq(warehouseMovementsTable.jobId, filters.jobId));
  if (filters.billingDocumentId != null)
    conds.push(eq(warehouseMovementsTable.billingDocumentId, filters.billingDocumentId));
  if (filters.direction) conds.push(eq(warehouseMovementsTable.direction, filters.direction));
  if (filters.from) conds.push(gte(warehouseMovementsTable.createdAt, new Date(`${filters.from}T00:00:00`)));
  if (filters.to) conds.push(lte(warehouseMovementsTable.createdAt, new Date(`${filters.to}T23:59:59.999`)));

  const rows = await db
    .select({
      movement: warehouseMovementsTable,
      itemName: warehouseItemsTable.name,
      documentNumber: billingDocumentsTable.documentNumber,
      jobTitle: jobsTable.title,
    })
    .from(warehouseMovementsTable)
    .leftJoin(
      warehouseItemsTable,
      eq(warehouseMovementsTable.warehouseItemId, warehouseItemsTable.id),
    )
    .leftJoin(
      billingDocumentsTable,
      eq(warehouseMovementsTable.billingDocumentId, billingDocumentsTable.id),
    )
    .leftJoin(jobsTable, eq(warehouseMovementsTable.jobId, jobsTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(warehouseMovementsTable.createdAt), desc(warehouseMovementsTable.id))
    .limit(Math.min(filters.limit ?? 500, 1000));

  return rows.map(serializeMovement);
}

export async function listItemMovements(
  db: typeof import("@workspace/db").db,
  warehouseItemId: number,
): Promise<SerializedMovement[]> {
  return listMovements(db, { warehouseItemId, limit: 1000 });
}

/** Net stock contributions still recorded for a set of source ids (for tests). */
export async function netSignedForSources(
  db: typeof import("@workspace/db").db,
  sourceType: MovementSourceType,
  sourceIds: number[],
): Promise<number> {
  if (!sourceIds.length) return 0;
  const rows = await db
    .select({ direction: warehouseMovementsTable.direction, quantity: warehouseMovementsTable.quantity })
    .from(warehouseMovementsTable)
    .where(
      and(
        eq(warehouseMovementsTable.sourceType, sourceType),
        inArray(warehouseMovementsTable.sourceId, sourceIds),
      ),
    );
  return round2(
    rows.reduce((s, r) => s + (r.direction === "in" ? num(r.quantity) : -num(r.quantity)), 0),
  );
}
