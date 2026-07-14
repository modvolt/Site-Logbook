import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  jobsTable,
  materialsTable,
  warehouseItemsTable,
  materialMarkupRulesTable,
} from "@workspace/db";
import {
  createDraft,
  deleteDraft,
  upsertMaterialMarkupRule,
  deleteMaterialMarkupRule,
} from "../src/lib/invoice-service";
import { normalizeItemName } from "../src/lib/reference-extractor";

/**
 * Task #129 — material markup chain, exercised through the real DB pipeline.
 *
 * `buildProposedLines` is private, so it is tested via `createDraft` (which
 * calls it): create a done job with material(s), build a draft, and assert the
 * resulting MATERIAL invoice lines carry the marked-up unit price resolved by
 * the chain (per-line override → category default → invoice/settings default).
 *
 * Also covers the case-insensitive upsert of category markup rules.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-mms-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const itemIds: number[] = [];
const invoiceIds: number[] = [];
const ruleIds: number[] = [];

async function makeJob(): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: `Zakázka ${TAG}`,
      customerId,
      date: "2026-01-10",
      status: "done",
      price: "0",
    })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

/** Add a material line to a job; returns the material id. */
async function addMaterial(
  jobId: number,
  name: string,
  pricePerUnit: string,
  quantity = "1",
): Promise<number> {
  const [m] = await db
    .insert(materialsTable)
    .values({
      jobId,
      name,
      quantity,
      unit: "ks",
      pricePerUnit,
      priceSource: "manual",
      done: true,
    })
    .returning();
  return m.id;
}

/**
 * Register a warehouse catalogue item so a job material NAME resolves to a
 * `category` — that category is what the markup rules are keyed on.
 */
async function makeCatalogueItem(name: string, category: string): Promise<void> {
  const [item] = await db
    .insert(warehouseItemsTable)
    .values({ name, category, normalizedName: normalizeItemName(name) })
    .returning();
  itemIds.push(item.id);
}

function materialLines(detail: Awaited<ReturnType<typeof createDraft>>) {
  return detail.lines.filter((l) => l.sourceType === "material");
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

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = customer.id;
});

afterEach(async () => {
  for (const invId of invoiceIds.splice(0)) {
    await deleteDraft(invId).catch(() => {});
  }
  for (const ruleId of ruleIds.splice(0)) {
    await deleteMaterialMarkupRule(ruleId).catch(() => {});
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
  if (itemIds.length) {
    await db
      .delete(warehouseItemsTable)
      .where(inArray(warehouseItemsTable.id, itemIds));
    itemIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("buildProposedLines material markup (via createDraft)", () => {
  it("applies the invoice/settings default markup to material lines", async () => {
    const jobId = await makeJob();
    await addMaterial(jobId, `Materiál ${TAG} A`, "100");

    const detail = await createDraft(
      { customerId, jobIds: [jobId], materialMarkupPercent: 10 },
      actor,
    );
    invoiceIds.push(detail.id);

    const mats = materialLines(detail);
    expect(mats).toHaveLength(1);
    // 100 + 10% = 110
    expect(mats[0].unitPriceWithoutVat).toBe(110);
  });

  it("lets a per-line override win over the invoice default", async () => {
    const jobId = await makeJob();
    const matId = await addMaterial(jobId, `Materiál ${TAG} B`, "100");

    const detail = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        materialMarkupPercent: 10,
        materialMarkupOverrides: [{ materialId: matId, markupPercent: 30 }],
      },
      actor,
    );
    invoiceIds.push(detail.id);

    const mats = materialLines(detail);
    // override 30% wins over the 10% invoice default → 130
    expect(mats[0].unitPriceWithoutVat).toBe(130);
  });

  it("honours a per-line override of 0 as an opt-out of the default", async () => {
    const jobId = await makeJob();
    const matId = await addMaterial(jobId, `Materiál ${TAG} C`, "100");

    const detail = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        materialMarkupPercent: 25,
        materialMarkupOverrides: [{ materialId: matId, markupPercent: 0 }],
      },
      actor,
    );
    invoiceIds.push(detail.id);

    const mats = materialLines(detail);
    // explicit 0 override → no markup, price stays 100
    expect(mats[0].unitPriceWithoutVat).toBe(100);
  });

  it("uses the category-default markup when no per-line override is given", async () => {
    const name = `Kabel ${TAG}`;
    await makeCatalogueItem(name, `Kabeláž ${TAG}`);
    const rule = await upsertMaterialMarkupRule({
      category: `Kabeláž ${TAG}`,
      markupPercent: 20,
    });
    ruleIds.push(rule.id);

    const jobId = await makeJob();
    await addMaterial(jobId, name, "100");

    const detail = await createDraft(
      { customerId, jobIds: [jobId], materialMarkupPercent: 5 },
      actor,
    );
    invoiceIds.push(detail.id);

    const mats = materialLines(detail);
    // category default 20% wins over the 5% invoice default → 120
    expect(mats[0].unitPriceWithoutVat).toBe(120);
  });

  it("falls back to the invoice default when the material has no category rule", async () => {
    // Catalogue item with a category, but no markup rule for that category.
    const name = `Spojka ${TAG}`;
    await makeCatalogueItem(name, `Spojky ${TAG}`);

    const jobId = await makeJob();
    await addMaterial(jobId, name, "100");

    const detail = await createDraft(
      { customerId, jobIds: [jobId], materialMarkupPercent: 5 },
      actor,
    );
    invoiceIds.push(detail.id);

    const mats = materialLines(detail);
    // no category rule → 5% invoice default → 105
    expect(mats[0].unitPriceWithoutVat).toBe(105);
  });

  it("override beats category default beats invoice default within one draft", async () => {
    const overrideName = `MatOverride ${TAG}`;
    const categoryName = `MatCategory ${TAG}`;
    const plainName = `MatPlain ${TAG}`;
    await makeCatalogueItem(categoryName, `KatX ${TAG}`);
    const rule = await upsertMaterialMarkupRule({
      category: `KatX ${TAG}`,
      markupPercent: 20,
    });
    ruleIds.push(rule.id);

    const jobId = await makeJob();
    const overrideMatId = await addMaterial(jobId, overrideName, "100");
    await addMaterial(jobId, categoryName, "100");
    await addMaterial(jobId, plainName, "100");

    const detail = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        materialMarkupPercent: 5,
        materialMarkupOverrides: [{ materialId: overrideMatId, markupPercent: 50 }],
      },
      actor,
    );
    invoiceIds.push(detail.id);

    const byDesc = new Map(
      materialLines(detail).map((l) => [l.description, l.unitPriceWithoutVat]),
    );
    expect(byDesc.get(overrideName)).toBe(150); // override 50%
    expect(byDesc.get(categoryName)).toBe(120); // category 20%
    expect(byDesc.get(plainName)).toBe(105); // invoice default 5%
  });
});

describe("upsertMaterialMarkupRule case-insensitive upsert", () => {
  it("treats differently-cased category names as the same rule", async () => {
    const first = await upsertMaterialMarkupRule({
      category: `Kabeláž ${TAG}`,
      markupPercent: 15,
    });
    ruleIds.push(first.id);

    const second = await upsertMaterialMarkupRule({
      category: `kabeláž ${TAG}`,
      markupPercent: 25,
    });

    // Same row updated in place — one rule, not two.
    expect(second.id).toBe(first.id);
    expect(second.markupPercent).toBe(25);
    // The latest casing is persisted verbatim.
    expect(second.category).toBe(`kabeláž ${TAG}`);

    const rows = await db
      .select()
      .from(materialMarkupRulesTable)
      .where(inArray(materialMarkupRulesTable.id, [first.id]));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].markupPercent)).toBe(25);
  });
});
