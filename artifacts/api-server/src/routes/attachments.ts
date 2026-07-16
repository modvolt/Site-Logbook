import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, attachmentsTable, jobsTable, billingDocumentsTable } from "@workspace/db";
import {
  ListAttachmentsParams,
  CreateAttachmentParams,
  CreateAttachmentBody,
  DeleteAttachmentParams,
} from "@workspace/api-zod";
import { isRestrictedFieldWorker, requireAssignedJobView, requireAssignedJobWork } from "../middlewares/job-work-access";

const router: IRouter = Router();
const DOCUMENT_TYPES = new Set(["document", "invoice", "receipt", "delivery_note", "credit_note"]);

function serializeAttachment(att: typeof attachmentsTable.$inferSelect) {
  return {
    ...att,
    amount: att.amount != null ? Number(att.amount) : null,
    createdAt: att.createdAt.toISOString(),
  };
}

router.get("/jobs/:jobId/attachments", requireAssignedJobView, async (req, res): Promise<void> => {
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

  const visibleAttachments = isRestrictedFieldWorker(req.auth!.permissions)
    ? attachments.filter((attachment) => attachment.type === "photo")
    : attachments;
  res.json(visibleAttachments.map(serializeAttachment));
});

router.get("/jobs/:jobId/documents", requireAssignedJobView, async (req, res): Promise<void> => {
  const params = ListAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const pages = (await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.jobId, params.data.jobId)))
    .filter((attachment) => DOCUMENT_TYPES.has(attachment.type));
  const documentIds = Array.from(new Set(
    pages.map((page) => page.billingDocumentId).filter((id): id is number => id != null),
  ));
  const documents = documentIds.length
    ? await db
        .select({
          id: billingDocumentsTable.id,
          status: billingDocumentsTable.status,
          docType: billingDocumentsTable.docType,
          declaredDocType: billingDocumentsTable.declaredDocType,
          detectedDocType: billingDocumentsTable.detectedDocType,
          detectedDocTypeConfidence: billingDocumentsTable.detectedDocTypeConfidence,
          docTypeSource: billingDocumentsTable.docTypeSource,
          createdAt: billingDocumentsTable.createdAt,
        })
        .from(billingDocumentsTable)
        .where(inArray(billingDocumentsTable.id, documentIds))
    : [];
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const groups = new Map<string, typeof pages>();
  for (const page of pages) {
    const key = page.billingDocumentId != null ? `document:${page.billingDocumentId}` : `attachment:${page.id}`;
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }
  res.json(Array.from(groups.values()).map((group) => {
    const ordered = group.slice().sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || a.id - b.id);
    const billingDocumentId = ordered[0]?.billingDocumentId ?? null;
    const document = billingDocumentId == null ? null : documentById.get(billingDocumentId) ?? null;
    return {
      documentId: billingDocumentId,
      status: document?.status ?? "not_analyzed",
      docType: document?.docType ?? ordered[0]?.type ?? "unknown",
      declaredDocType: document?.declaredDocType ?? null,
      detectedDocType: document?.detectedDocType ?? null,
      docTypeSource: document?.docTypeSource ?? "legacy",
      detectedDocTypeConfidence:
        document?.detectedDocTypeConfidence == null ? null : Number(document.detectedDocTypeConfidence),
      pageCount: ordered.length,
      createdAt: (document?.createdAt ?? ordered[0]!.createdAt).toISOString(),
      pages: ordered.map((page, index) => ({
        id: page.id,
        pageIndex: page.pageIndex ?? index,
        fileName: page.fileName,
        url: page.url,
      })),
    };
  }));
});

router.post("/jobs/:jobId/attachments", requireAssignedJobWork, async (req, res): Promise<void> => {
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
    .values({ jobId: params.data.jobId, ...parsed.data } as any)
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
