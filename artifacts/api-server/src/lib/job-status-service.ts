import { and, eq, isNull, max, ne, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  invoiceSourceLinksTable,
  invoicesTable,
  jobsTable,
  materialsTable,
  peopleTable,
  tasksTable,
  workSessionsTable,
} from "@workspace/db";
import { evaluateJobCompletion } from "./job-completion-policy";

export type ClientJobStatus = "planned" | "in_progress" | "done" | "cancelled";
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface JobReadinessIssue {
  code: string;
  message: string;
  count?: number;
}

export interface JobCompletionReadiness {
  jobId: number;
  status: string;
  canComplete: boolean;
  blockers: JobReadinessIssue[];
  warnings: JobReadinessIssue[];
  activeSessions: Array<{
    id: number;
    personId: number;
    personName: string;
    startedAt: string;
  }>;
  unfinishedTaskCount: number;
  plannedMaterialCount: number;
  consumedMaterialCount: number;
  hoursSpent: number;
}

export class JobStatusTransitionError extends Error {
  statusCode = 409;

  constructor(
    message: string,
    public readonly code: string,
    public readonly readiness?: JobCompletionReadiness,
    public readonly jobId?: number,
  ) {
    super(message);
  }
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadActiveSessions(exec: DbOrTx, jobId: number) {
  return exec
    .select({
      id: workSessionsTable.id,
      personId: workSessionsTable.personId,
      personName: peopleTable.name,
      startedAt: workSessionsTable.startedAt,
    })
    .from(workSessionsTable)
    .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
    .where(and(eq(workSessionsTable.jobId, jobId), eq(workSessionsTable.status, "active")))
    .orderBy(workSessionsTable.startedAt);
}

async function buildReadiness(
  exec: DbOrTx,
  job: typeof jobsTable.$inferSelect,
): Promise<JobCompletionReadiness> {
  const [taskCounts] = await exec
    .select({
      unfinished: sql<number>`sum(case when ${tasksTable.done} then 0 else 1 end)`.mapWith(Number),
    })
    .from(tasksTable)
    .where(eq(tasksTable.jobId, job.id));
  const [materialCounts] = await exec
    .select({
      planned: sql<number>`sum(case when ${materialsTable.done} then 0 else 1 end)`.mapWith(Number),
      consumed: sql<number>`sum(case when ${materialsTable.done} then 1 else 0 end)`.mapWith(Number),
    })
    .from(materialsTable)
    .where(eq(materialsTable.jobId, job.id));
  const activeRows = await loadActiveSessions(exec, job.id);

  const unfinishedTaskCount = Number(taskCounts?.unfinished ?? 0);
  const plannedMaterialCount = Number(materialCounts?.planned ?? 0);
  const consumedMaterialCount = Number(materialCounts?.consumed ?? 0);
  const hoursSpent = Number(job.hoursSpent ?? 0);
  const { blockers, warnings } = evaluateJobCompletion({
    customerId: job.customerId,
    activeSessionCount: activeRows.length,
    unfinishedTaskCount,
    plannedMaterialCount,
    hoursSpent,
    pricingMode: job.pricingMode,
  });

  return {
    jobId: job.id,
    status: job.status,
    canComplete: blockers.length === 0,
    blockers,
    warnings,
    activeSessions: activeRows.map((session) => ({
      id: session.id,
      personId: session.personId,
      personName: session.personName,
      startedAt: session.startedAt.toISOString(),
    })),
    unfinishedTaskCount,
    plannedMaterialCount,
    consumedMaterialCount,
    hoursSpent,
  };
}

export async function getJobCompletionReadiness(jobId: number): Promise<JobCompletionReadiness | null> {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  return job ? buildReadiness(db, job) : null;
}

async function hasActiveInvoice(exec: DbOrTx, jobId: number): Promise<boolean> {
  const [row] = await exec
    .select({ id: invoiceSourceLinksTable.id })
    .from(invoiceSourceLinksTable)
    .innerJoin(invoicesTable, eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id))
    .where(and(eq(invoiceSourceLinksTable.jobId, jobId), ne(invoicesTable.status, "cancelled")))
    .limit(1);
  return !!row;
}

async function createNextRecurringJob(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  job: typeof jobsTable.$inferSelect,
) {
  if (job.type !== "service_call" || !job.recurrenceIntervalDays || job.recurrenceIntervalDays <= 0) return;

  const nextDate = addDaysIso(job.date, job.recurrenceIntervalDays);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`job-recurrence:${job.id}:${nextDate}`}))`);
  const [duplicate] = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(
      eq(jobsTable.type, "service_call"),
      eq(jobsTable.date, nextDate),
      eq(jobsTable.title, job.title),
      job.customerId == null ? isNull(jobsTable.customerId) : eq(jobsTable.customerId, job.customerId),
    ))
    .limit(1);
  if (duplicate) return;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`jobs-sort:${nextDate}`}))`);
  const [aggregate] = await tx
    .select({ maxSort: max(jobsTable.sortOrder) })
    .from(jobsTable)
    .where(eq(jobsTable.date, nextDate));
  await tx.insert(jobsTable).values({
    title: job.title,
    type: job.type,
    clientSite: job.clientSite,
    date: nextDate,
    startTime: job.startTime,
    endTime: job.endTime,
    status: "planned",
    assignedPersonId: job.assignedPersonId,
    customerId: job.customerId,
    notes: job.notes,
    address: job.address,
    recurrenceIntervalDays: job.recurrenceIntervalDays,
    sortOrder: (aggregate?.maxSort ?? -1) + 1,
  });
}

async function transitionOne(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  jobId: number,
  status: ClientJobStatus,
  actor: { userId: number; name: string },
  acknowledgeWarnings: boolean,
) {
  const [existing] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .for("update");
  if (!existing) throw new JobStatusTransitionError("Zakázka nebyla nalezena.", "job_not_found", undefined, jobId);
  if (existing.archivedAt) throw new JobStatusTransitionError("Archivovanou zakázku nelze měnit.", "job_archived", undefined, jobId);
  if (existing.status === status) return existing;
  if (existing.status === "vyfakturovano") {
    throw new JobStatusTransitionError(
      "Stav vyfakturované zakázky lze změnit pouze stornem příslušné faktury.",
      "invoiced_job_locked",
      undefined,
      jobId,
    );
  }

  let readiness: JobCompletionReadiness | undefined;
  if (status === "done") {
    readiness = await buildReadiness(tx, existing);
    if (readiness.blockers.length > 0) {
      throw new JobStatusTransitionError(
        "Zakázku zatím nelze dokončit.",
        "completion_blocked",
        readiness,
        jobId,
      );
    }
    if (readiness.warnings.length > 0 && !acknowledgeWarnings) {
      throw new JobStatusTransitionError(
        "Dokončení vyžaduje potvrzení upozornění.",
        "completion_warnings",
        readiness,
        jobId,
      );
    }
  } else if (status === "cancelled") {
    const activeSessions = await loadActiveSessions(tx, jobId);
    if (activeSessions.length > 0) {
      throw new JobStatusTransitionError(
        "Zakázku nelze zrušit, dokud na ní běží měření času.",
        "active_work_sessions",
        undefined,
        jobId,
      );
    }
  }

  if (existing.status === "done" && status !== "done" && await hasActiveInvoice(tx, jobId)) {
    throw new JobStatusTransitionError(
      "Zakázku nelze znovu otevřít ani zrušit, protože je navázaná na platnou fakturu.",
      "active_invoice_link",
      undefined,
      jobId,
    );
  }

  const [updated] = await tx
    .update(jobsTable)
    .set({ status })
    .where(eq(jobsTable.id, jobId))
    .returning();

  const action = status === "done"
    ? "job_completed"
    : existing.status === "done"
      ? "job_reopened"
      : status === "cancelled"
        ? "job_cancelled"
        : "job_status_changed";
  await tx.insert(auditLogTable).values({
    actorUserId: actor.userId,
    actorName: actor.name,
    action,
    entityType: "job",
    entityId: jobId,
    method: "PATCH",
    path: `/jobs/${jobId}/status`,
    summary: JSON.stringify({
      from: existing.status,
      to: status,
      acknowledgedWarnings: readiness?.warnings.map((warning) => warning.code) ?? [],
    }),
  });

  if (status === "done") await createNextRecurringJob(tx, updated);
  return updated;
}

export async function transitionJobStatuses(
  jobIds: number[],
  status: ClientJobStatus,
  actor: { userId: number; name: string },
  options: { acknowledgeWarnings?: boolean } = {},
) {
  const ids = Array.from(new Set(jobIds)).sort((a, b) => a - b);
  return db.transaction(async (tx) => {
    const jobs = [];
    for (const jobId of ids) {
      jobs.push(await transitionOne(tx, jobId, status, actor, options.acknowledgeWarnings === true));
    }
    return jobs;
  });
}

export async function transitionJobStatus(
  jobId: number,
  status: ClientJobStatus,
  actor: { userId: number; name: string },
  options: { acknowledgeWarnings?: boolean } = {},
) {
  const [job] = await transitionJobStatuses([jobId], status, actor, options);
  return job;
}
