import type { NextFunction, Request, Response } from "express";
import { eq, isNotNull, and } from "drizzle-orm";
import { db, jobsTable } from "@workspace/db";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const JOB_PATH = /^\/jobs\/(\d+)(?:\/|$)/;

export async function rejectArchivedJobMutations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const match = JOB_PATH.exec(req.path);
  if (!match) return next();

  const jobId = Number(match[1]);
  const exactJobPath = req.path === `/jobs/${jobId}`;
  const restorePath = req.path === `/jobs/${jobId}/restore`;
  if ((req.method === "DELETE" && exactJobPath) || restorePath) return next();

  const [archived] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), isNotNull(jobsTable.archivedAt)))
    .limit(1);

  if (archived) {
    res.status(409).json({
      error: "Archivovanou zakázku nelze měnit. Nejdříve ji obnovte v administraci.",
    });
    return;
  }

  next();
}
