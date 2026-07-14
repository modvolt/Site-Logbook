import type { NextFunction, Request, Response } from "express";
import { and, eq, ne } from "drizzle-orm";
import { db, jobAssigneesTable, jobsTable, jobVisitsTable } from "@workspace/db";

const ACTIVE_JOB_STATUSES = new Set(["planned", "in_progress"]);

function jobIdFromRequest(req: Request): number | null {
  const value = Number(req.params.jobId ?? req.params.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function assignedJob(jobId: number, personId: number) {
  const [job] = await db
    .select({ id: jobsTable.id, status: jobsTable.status, assignedPersonId: jobsTable.assignedPersonId })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) return { exists: false as const, assigned: false, active: false };

  if (job.assignedPersonId === personId) {
    return { exists: true as const, assigned: true, active: ACTIVE_JOB_STATUSES.has(job.status) };
  }

  const [[additional], [visit]] = await Promise.all([
    db
      .select({ id: jobAssigneesTable.id })
      .from(jobAssigneesTable)
      .where(and(eq(jobAssigneesTable.jobId, jobId), eq(jobAssigneesTable.personId, personId)))
      .limit(1),
    db
      .select({ id: jobVisitsTable.id })
      .from(jobVisitsTable)
      .where(and(
        eq(jobVisitsTable.jobId, jobId),
        eq(jobVisitsTable.personId, personId),
        ne(jobVisitsTable.status, "cancelled"),
      ))
      .limit(1),
  ]);
  return {
    exists: true as const,
    assigned: Boolean(additional || visit),
    active: ACTIVE_JOB_STATUSES.has(job.status),
  };
}

export async function listAssignedJobIds(personId: number): Promise<number[]> {
  const [primary, additional, visits] = await Promise.all([
    db
      .select({ jobId: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.assignedPersonId, personId)),
    db
      .select({ jobId: jobAssigneesTable.jobId })
      .from(jobAssigneesTable)
      .where(eq(jobAssigneesTable.personId, personId)),
    db
      .select({ jobId: jobVisitsTable.jobId })
      .from(jobVisitsTable)
      .where(and(eq(jobVisitsTable.personId, personId), ne(jobVisitsTable.status, "cancelled"))),
  ]);
  return Array.from(new Set([...primary, ...additional, ...visits].map((row) => row.jobId)));
}

async function enforceAssignedJobView(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isRestrictedFieldWorker(req.auth!.permissions)) {
    next();
    return;
  }
  if (req.auth!.personId == null) {
    res.status(403).json({ error: "Uživatelský účet není propojen se zaměstnancem.", code: "missing_person_link" });
    return;
  }
  const jobId = jobIdFromRequest(req);
  if (jobId == null) {
    res.status(400).json({ error: "Neplatné ID zakázky" });
    return;
  }
  const access = await assignedJob(jobId, req.auth!.personId);
  if (!access.exists) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!access.assigned) {
    res.status(403).json({ error: "Na tuto zakázku nejste přiřazen.", code: "job_not_assigned" });
    return;
  }
  next();
}

export function requireAssignedJobView(req: Request, res: Response, next: NextFunction): void {
  void enforceAssignedJobView(req, res, next).catch(next);
}

async function enforceAssignedJobWork(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.auth!.permissions.includes("jobs.manage")) {
    next();
    return;
  }
  if (!req.auth!.permissions.includes("jobs.work")) {
    res.status(403).json({ error: "Forbidden", requiredPermission: "jobs.work" });
    return;
  }
  if (req.auth!.personId == null) {
    res.status(403).json({ error: "Uživatelský účet není propojen se zaměstnancem.", code: "missing_person_link" });
    return;
  }
  const jobId = jobIdFromRequest(req);
  if (jobId == null) {
    res.status(400).json({ error: "Neplatné ID zakázky" });
    return;
  }
  const access = await assignedJob(jobId, req.auth!.personId);
  if (!access.exists) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!access.assigned) {
    res.status(403).json({ error: "Na tuto zakázku nejste přiřazen.", code: "job_not_assigned" });
    return;
  }
  if (!access.active) {
    res.status(409).json({ error: "Uzavřenou nebo zrušenou zakázku nelze měnit.", code: "job_not_active" });
    return;
  }
  next();
}

export function requireAssignedJobWork(req: Request, res: Response, next: NextFunction): void {
  void enforceAssignedJobWork(req, res, next).catch(next);
}

export function requireOwnJobTimer(req: Request, res: Response, next: NextFunction): void {
  if (req.auth!.permissions.includes("time.manage") || req.auth!.permissions.includes("jobs.manage")) {
    next();
    return;
  }
  const personId = Number(req.params.personId);
  if (req.auth!.personId == null || personId !== req.auth!.personId) {
    res.status(403).json({ error: "Můžete ovládat pouze vlastní časovač.", code: "timer_person_mismatch" });
    return;
  }
  requireAssignedJobWork(req, res, next);
}

export function isRestrictedFieldWorker(permissions: readonly string[]): boolean {
  return permissions.includes("jobs.work") && !permissions.includes("jobs.manage");
}
