import { Router, type IRouter } from "express";
import { eq, and, asc } from "drizzle-orm";
import { db, jobVisitsTable, jobsTable, peopleTable } from "@workspace/db";
import {
  ListJobVisitsParams,
  CreateJobVisitParams,
  CreateJobVisitBody,
  UpdateJobVisitParams,
  UpdateJobVisitBody,
  DeleteJobVisitParams,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

async function serializeVisit(v: typeof jobVisitsTable.$inferSelect) {
  let personName: string | null = null;
  if (v.personId) {
    const [p] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, v.personId));
    personName = p?.name ?? null;
  }
  return {
    ...v,
    personName,
    createdAt: v.createdAt.toISOString(),
  };
}

router.get("/jobs/:jobId/visits", async (req, res): Promise<void> => {
  const params = ListJobVisitsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const visits = await db
    .select()
    .from(jobVisitsTable)
    .where(eq(jobVisitsTable.jobId, params.data.jobId))
    .orderBy(asc(jobVisitsTable.date), asc(jobVisitsTable.id));

  res.json(await Promise.all(visits.map(serializeVisit)));
});

router.post(
  "/jobs/:jobId/visits",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = CreateJobVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateJobVisitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [job] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const [visit] = await db
      .insert(jobVisitsTable)
      .values({ ...parsed.data, jobId: params.data.jobId })
      .returning();

    res.status(201).json(await serializeVisit(visit));
  },
);

router.patch(
  "/jobs/:jobId/visits/:visitId",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = UpdateJobVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateJobVisitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [visit] = await db
      .update(jobVisitsTable)
      .set(parsed.data)
      .where(
        and(
          eq(jobVisitsTable.id, params.data.visitId),
          eq(jobVisitsTable.jobId, params.data.jobId),
        ),
      )
      .returning();

    if (!visit) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

    res.json(await serializeVisit(visit));
  },
);

router.delete(
  "/jobs/:jobId/visits/:visitId",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = DeleteJobVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const deleted = await db
      .delete(jobVisitsTable)
      .where(
        and(
          eq(jobVisitsTable.id, params.data.visitId),
          eq(jobVisitsTable.jobId, params.data.jobId),
        ),
      )
      .returning({ id: jobVisitsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
