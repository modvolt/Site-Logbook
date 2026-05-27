import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, attachmentsTable, jobsTable } from "@workspace/db";
import {
  ListAttachmentsParams,
  CreateAttachmentParams,
  CreateAttachmentBody,
  DeleteAttachmentParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeAttachment(att: typeof attachmentsTable.$inferSelect) {
  return {
    ...att,
    amount: att.amount != null ? Number(att.amount) : null,
    createdAt: att.createdAt.toISOString(),
  };
}

router.get("/jobs/:jobId/attachments", async (req, res): Promise<void> => {
  const params = ListAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const attachments = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.jobId, params.data.jobId))
    .orderBy(attachmentsTable.createdAt);

  res.json(attachments.map(serializeAttachment));
});

router.post("/jobs/:jobId/attachments", async (req, res): Promise<void> => {
  const params = CreateAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const parsed = CreateAttachmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [att] = await db
    .insert(attachmentsTable)
    .values({ jobId: params.data.jobId, ...parsed.data })
    .returning();

  res.status(201).json(serializeAttachment(att));
});

router.delete("/jobs/:jobId/attachments/:attachmentId", async (req, res): Promise<void> => {
  const params = DeleteAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [att] = await db
    .delete(attachmentsTable)
    .where(
      and(
        eq(attachmentsTable.id, params.data.attachmentId),
        eq(attachmentsTable.jobId, params.data.jobId)
      )
    )
    .returning();

  if (!att) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
