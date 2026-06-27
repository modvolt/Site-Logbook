import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  jobsTable,
  materialsTable,
  activitiesTable,
  activityMaterialsTable,
} from "@workspace/db";
import { createDraft, deleteDraft } from "../src/lib/invoice-service";

/**
 * Regression: per-material markup overrides must be namespaced by source type.
 *
 * Job materials (`materials`) and activity materials (`activity_materials`) are
 * separate tables with independent id sequences, so their ids collide. An
 * override keyed by a bare numeric id would therefore bleed across the two — a
 * job override applying to an activity line and vice versa, producing wrong
 * invoice amounts. The fix namespaces overrides with `sourceType`.
 *
 * This test forces the worst case: a job material and an activity material that
 * share the exact same numeric id, each given a distinct override. Each line
 * must receive only its own override.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-mmidc-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const activityIds: number[] = [];
const invoiceIds: number[] = [];

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
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
  if (activityIds.length) {
    await db
      .delete(activitiesTable)
      .where(inArray(activitiesTable.id, activityIds));
    activityIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("createDraft material markup override id-collision", () => {
  it("keeps job and activity overrides independent when ids collide", async () => {
    // Job with a material.
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

    const [jobMaterial] = await db
      .insert(materialsTable)
      .values({
        jobId: job.id,
        name: `Job materiál ${TAG}`,
        quantity: "1",
        unit: "ks",
        pricePerUnit: "100",
        priceSource: "manual",
      })
      .returning();
    const sharedId = jobMaterial.id;

    // Completed activity whose material is forced to the SAME numeric id.
    const [activity] = await db
      .insert(activitiesTable)
      .values({
        name: `Akce ${TAG}`,
        customerId,
        completedAt: new Date(),
      })
      .returning();
    activityIds.push(activity.id);

    await db.insert(activityMaterialsTable).values({
      id: sharedId,
      activityId: activity.id,
      name: `Akce materiál ${TAG}`,
      quantity: "1",
      unit: "ks",
      pricePerUnit: "100",
    });

    const detail = await createDraft(
      {
        customerId,
        jobIds: [job.id],
        activityIds: [activity.id],
        materialMarkupPercent: 0,
        materialMarkupOverrides: [
          { materialId: sharedId, markupPercent: 10, sourceType: "material" },
          {
            materialId: sharedId,
            markupPercent: 50,
            sourceType: "activity_material",
          },
        ],
      },
      actor,
    );
    invoiceIds.push(detail.id);

    const jobLine = detail.lines.find(
      (l) => l.sourceType === "material" && l.sourceId === sharedId,
    );
    const activityLine = detail.lines.find(
      (l) => l.sourceType === "activity_material" && l.sourceId === sharedId,
    );

    expect(jobLine).toBeDefined();
    expect(activityLine).toBeDefined();
    // Job override (10%) only on the job line: 100 → 110.
    expect(jobLine!.unitPriceWithoutVat).toBe(110);
    // Activity override (50%) only on the activity line: 100 → 150.
    expect(activityLine!.unitPriceWithoutVat).toBe(150);
  });
});
