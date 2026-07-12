import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, personHourlyRatesTable, workSessionsTable } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function lockPerson(tx: Tx, personId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(83422, ${personId})`);
}

async function rebuildWindows(tx: Tx, personId: number) {
  const rows = await tx
    .select({ id: personHourlyRatesTable.id, validFrom: personHourlyRatesTable.validFrom })
    .from(personHourlyRatesTable)
    .where(and(eq(personHourlyRatesTable.personId, personId), isNull(personHourlyRatesTable.voidedAt)))
    .orderBy(asc(personHourlyRatesTable.validFrom), asc(personHourlyRatesTable.id));
  for (let index = 0; index < rows.length; index += 1) {
    const next = rows[index + 1];
    await tx
      .update(personHourlyRatesTable)
      .set({ validTo: next ? previousDay(next.validFrom) : null })
      .where(eq(personHourlyRatesTable.id, rows[index].id));
  }
}

export async function listHourlyRates(personId: number) {
  return db
    .select()
    .from(personHourlyRatesTable)
    .where(eq(personHourlyRatesTable.personId, personId))
    .orderBy(asc(personHourlyRatesTable.validFrom), asc(personHourlyRatesTable.id));
}

export async function createHourlyRate(input: {
  personId: number;
  validFrom: string;
  costRate: number;
  saleRate: number;
  reason: string;
  actorUserId: number;
}) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, input.personId);
    const [row] = await tx
      .insert(personHourlyRatesTable)
      .values({
        personId: input.personId,
        validFrom: input.validFrom,
        costRate: String(input.costRate),
        saleRate: String(input.saleRate),
        reason: input.reason,
        createdByUserId: input.actorUserId,
      })
      .returning();
    await rebuildWindows(tx, input.personId);
    const [result] = await tx.select().from(personHourlyRatesTable).where(eq(personHourlyRatesTable.id, row.id));
    await tx
      .update(workSessionsTable)
      .set({
        hourlyRateId: result.id,
        costRateSnapshot: result.costRate,
        saleRateSnapshot: result.saleRate,
        updatedAt: new Date(),
      })
      .where(and(
        eq(workSessionsTable.personId, input.personId),
        eq(workSessionsTable.billingStatus, "unbilled"),
        sql`${workSessionsTable.startedAt}::date >= ${result.validFrom}::date`,
        result.validTo ? sql`${workSessionsTable.startedAt}::date <= ${result.validTo}::date` : undefined,
      ));
    return result;
  });
}

export async function voidHourlyRate(input: {
  personId: number;
  rateId: number;
  reason: string;
  actorUserId: number;
}) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, input.personId);
    const [row] = await tx
      .update(personHourlyRatesTable)
      .set({ voidedAt: new Date(), voidedByUserId: input.actorUserId, voidReason: input.reason })
      .where(and(
        eq(personHourlyRatesTable.id, input.rateId),
        eq(personHourlyRatesTable.personId, input.personId),
        isNull(personHourlyRatesTable.voidedAt),
      ))
      .returning();
    if (!row) return null;
    await rebuildWindows(tx, input.personId);
    return row;
  });
}

export async function resolveHourlyRate(personId: number, at: Date) {
  const date = at.toISOString().slice(0, 10);
  const [row] = await db
    .select()
    .from(personHourlyRatesTable)
    .where(and(
      eq(personHourlyRatesTable.personId, personId),
      isNull(personHourlyRatesTable.voidedAt),
      lte(personHourlyRatesTable.validFrom, date),
      or(isNull(personHourlyRatesTable.validTo), sql`${personHourlyRatesTable.validTo} >= ${date}`),
    ))
    .orderBy(asc(personHourlyRatesTable.validFrom));
  return row ?? null;
}
