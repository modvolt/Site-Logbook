import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, customerSiteAttachmentsTable, customerSitesTable } from "@workspace/db";
import {
  ListCustomerSiteAttachmentsParams,
  CreateCustomerSiteAttachmentParams,
  CreateCustomerSiteAttachmentBody,
  DeleteCustomerSiteAttachmentParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeAttachment(att: typeof customerSiteAttachmentsTable.$inferSelect) {
  return {
    ...att,
    createdAt: att.createdAt.toISOString(),
  };
}

router.get("/customer-sites/:siteId/attachments", async (req, res): Promise<void> => {
  const params = ListCustomerSiteAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const attachments = await db
    .select()
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.siteId, params.data.siteId))
    .orderBy(customerSiteAttachmentsTable.createdAt);

  res.json(attachments.map(serializeAttachment));
});

router.post("/customer-sites/:siteId/attachments", async (req, res): Promise<void> => {
  const params = CreateCustomerSiteAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [site] = await db
    .select({ id: customerSitesTable.id })
    .from(customerSitesTable)
    .where(eq(customerSitesTable.id, params.data.siteId));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const parsed = CreateCustomerSiteAttachmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [att] = await db
    .insert(customerSiteAttachmentsTable)
    .values({ siteId: params.data.siteId, ...parsed.data } as any)
    .returning();

  res.status(201).json(serializeAttachment(att));
});

router.delete("/customer-sites/:siteId/attachments/:attachmentId", async (req, res): Promise<void> => {
  const params = DeleteCustomerSiteAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [att] = await db
    .delete(customerSiteAttachmentsTable)
    .where(
      and(
        eq(customerSiteAttachmentsTable.id, params.data.attachmentId),
        eq(customerSiteAttachmentsTable.siteId, params.data.siteId)
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
