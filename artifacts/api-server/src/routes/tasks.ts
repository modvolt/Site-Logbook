import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, tasksTable, jobsTable } from "@workspace/db";
import {
  ListTasksParams,
  CreateTaskParams,
  CreateTaskBody,
  UpdateTaskParams,
  UpdateTaskBody,
  DeleteTaskParams,
} from "@workspace/api-zod";
import { requireAssignedJobView, requireAssignedJobWork } from "../middlewares/job-work-access";

const router: IRouter = Router();

function serializeTask(task: typeof tasksTable.$inferSelect) {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
  };
}

router.get("/jobs/:jobId/tasks", requireAssignedJobView, async (req, res): Promise<void> => {
  const params = ListTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.jobId, params.data.jobId))
    .orderBy(tasksTable.createdAt);

  res.json(tasks.map(serializeTask));
});

router.post("/jobs/:jobId/tasks", requireAssignedJobWork, async (req, res): Promise<void> => {
  const params = CreateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Verify job exists
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [task] = await db
    .insert(tasksTable)
    .values({ jobId: params.data.jobId, ...parsed.data })
    .returning();

  res.status(201).json(serializeTask(task));
});

router.patch("/jobs/:jobId/tasks/:taskId", requireAssignedJobWork, async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!req.auth!.permissions.includes("jobs.manage") && Object.keys(parsed.data).some((field) => field !== "done")) {
    res.status(403).json({ error: "Pracovník může u úkolu měnit pouze stav hotovo.", code: "field_task_update_restricted" });
    return;
  }

  const [task] = await db
    .update(tasksTable)
    .set(parsed.data)
    .where(and(eq(tasksTable.id, params.data.taskId), eq(tasksTable.jobId, params.data.jobId)))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(serializeTask(task));
});

router.delete("/jobs/:jobId/tasks/:taskId", async (req, res): Promise<void> => {
  const params = DeleteTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db
    .delete(tasksTable)
    .where(and(eq(tasksTable.id, params.data.taskId), eq(tasksTable.jobId, params.data.jobId)))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
