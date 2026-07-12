import { and, eq, gte, lte, ne } from "drizzle-orm";
import { db, peopleTable, workSessionsTable } from "@workspace/db";
import { round2 } from "./invoice-calc";

export type WorkFinancialFilters = {
  from?: string;
  to?: string;
  personId?: number;
  jobId?: number;
  activityId?: number;
  billingStatus?: "unbilled" | "ready" | "billed" | "non_billable";
};

export async function getWorkFinancialSummary(filters: WorkFinancialFilters) {
  const conditions = [eq(workSessionsTable.status, "completed"), ne(workSessionsTable.status, "voided")];
  if (filters.from) conditions.push(gte(workSessionsTable.startedAt, new Date(`${filters.from}T00:00:00`)));
  if (filters.to) conditions.push(lte(workSessionsTable.startedAt, new Date(`${filters.to}T23:59:59.999`)));
  if (filters.personId) conditions.push(eq(workSessionsTable.personId, filters.personId));
  if (filters.jobId) conditions.push(eq(workSessionsTable.jobId, filters.jobId));
  if (filters.activityId) conditions.push(eq(workSessionsTable.activityId, filters.activityId));
  if (filters.billingStatus) conditions.push(eq(workSessionsTable.billingStatus, filters.billingStatus));

  const rows = await db
    .select({ session: workSessionsTable, personName: peopleTable.name })
    .from(workSessionsTable)
    .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
    .where(and(...conditions));

  type Bucket = { hours: number; cost: number; sale: number; missingCostRateCount: number; missingSaleRateCount: number; sessionCount: number };
  const empty = (): Bucket => ({ hours: 0, cost: 0, sale: 0, missingCostRateCount: 0, missingSaleRateCount: 0, sessionCount: 0 });
  const total = empty();
  const byStatus = new Map<string, Bucket>();
  const byPerson = new Map<number, Bucket & { personId: number; personName: string }>();
  for (const { session, personName } of rows) {
    const hours = round2((session.durationSeconds ?? 0) / 3600);
    const costRate = session.costRateSnapshot == null ? null : Number(session.costRateSnapshot);
    const saleRate = session.saleRateSnapshot == null ? null : Number(session.saleRateSnapshot);
    const apply = (bucket: Bucket) => {
      bucket.hours += hours;
      bucket.sessionCount += 1;
      if (costRate == null) bucket.missingCostRateCount += 1;
      else bucket.cost += round2(hours * costRate);
      if (saleRate == null) bucket.missingSaleRateCount += 1;
      else bucket.sale += round2(hours * saleRate);
    };
    apply(total);
    const status = byStatus.get(session.billingStatus) ?? empty();
    apply(status);
    byStatus.set(session.billingStatus, status);
    const person = byPerson.get(session.personId) ?? { ...empty(), personId: session.personId, personName };
    apply(person);
    byPerson.set(session.personId, person);
  }
  const serialize = (bucket: Bucket) => ({
    hours: round2(bucket.hours),
    cost: round2(bucket.cost),
    sale: round2(bucket.sale),
    margin: round2(bucket.sale - bucket.cost),
    marginPercent: bucket.sale !== 0 ? round2(((bucket.sale - bucket.cost) / bucket.sale) * 100) : null,
    missingCostRateCount: bucket.missingCostRateCount,
    missingSaleRateCount: bucket.missingSaleRateCount,
    sessionCount: bucket.sessionCount,
  });
  return {
    ...serialize(total),
    byBillingStatus: [...byStatus.entries()].map(([billingStatus, bucket]) => ({ billingStatus, ...serialize(bucket) })),
    byPerson: [...byPerson.values()].map((person) => ({ personId: person.personId, personName: person.personName, ...serialize(person) }))
      .sort((a, b) => b.hours - a.hours),
  };
}
