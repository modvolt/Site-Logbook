/**
 * One-shot backfill: recompute hours_vasek / hours_jonas / hours_spent on every
 * job that already has time_entries, using the same logic as
 * syncJobHoursFromEntries (artifacts/api-server/src/routes/time-entries.ts).
 *
 * Jobs with NO time entries are left untouched, so manual "Uložit souhrn"
 * edits on jobs that never had tracked time are preserved.
 *
 * Usage: pnpm --filter @workspace/scripts run backfill-job-hours
 */
import { db, jobsTable, timeEntriesTable, peopleTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

async function main() {
  const jobIds = await db
    .selectDistinct({ jobId: timeEntriesTable.jobId })
    .from(timeEntriesTable)
    .where(sql`${timeEntriesTable.jobId} is not null`);

  console.log(`Found ${jobIds.length} job(s) with time entries to backfill.`);

  let updated = 0;
  for (const { jobId } of jobIds) {
    if (jobId == null) continue;

    const rows = await db
      .select({ name: peopleTable.name, hours: timeEntriesTable.hours })
      .from(timeEntriesTable)
      .innerJoin(peopleTable, eq(timeEntriesTable.personId, peopleTable.id))
      .where(eq(timeEntriesTable.jobId, jobId));

    let hoursVasek = 0;
    let hoursJonas = 0;
    let hoursSpent = 0;

    for (const row of rows) {
      const h = Math.round(Number(row.hours) * 100) / 100;
      if (!h) continue;
      hoursSpent += h;
      const nameLower = row.name.toLowerCase();
      if (nameLower.includes("vašek") || nameLower.includes("vasek")) hoursVasek += h;
      if (nameLower.includes("jonáš") || nameLower.includes("jonas")) hoursJonas += h;
    }

    const round2 = (n: number) => String(Math.round(n * 100) / 100);

    await db
      .update(jobsTable)
      .set({
        hoursVasek: hoursVasek > 0 ? round2(hoursVasek) : null,
        hoursJonas: hoursJonas > 0 ? round2(hoursJonas) : null,
        hoursSpent: hoursSpent > 0 ? round2(hoursSpent) : null,
      })
      .where(eq(jobsTable.id, jobId));

    updated++;
    console.log(
      `job ${jobId}: hours_vasek=${hoursVasek || "-"} hours_jonas=${hoursJonas || "-"} hours_spent=${hoursSpent || "-"}`,
    );
  }

  console.log(`Backfill complete. Updated ${updated} job(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
