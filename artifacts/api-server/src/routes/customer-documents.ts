import { Router, type IRouter } from "express";
import { and, count, eq, isNotNull, isNull, lt, lte, gte, inArray, ilike, or, min } from "drizzle-orm";
import { db, customerSiteAttachmentsTable, customerSitesTable, customersTable, auditLogTable } from "@workspace/db";
import {
  ListCustomerDocumentsParams,
  ListCustomerDocumentsQueryParams,
  CreateCustomerDocumentParams,
  CreateCustomerDocumentBody,
  GetCustomerDocumentsSummaryParams,
  UpdateCustomerDocumentParams,
  UpdateCustomerDocumentBody,
  DeleteCustomerDocumentParams,
  ArchiveCustomerDocumentParams,
  ReplaceCustomerDocumentParams,
  ReplaceCustomerDocumentBody,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const EXPIRING_SOON_DAYS = 60;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type AttachmentRow = typeof customerSiteAttachmentsTable.$inferSelect;

function computeDocStatus(
  row: Pick<AttachmentRow, "docStatus" | "archivedAt" | "validUntil">,
  today: string,
): "current" | "expiring" | "expired" | "replaced" | "archived" {
  if (row.archivedAt) return "archived";
  if (row.docStatus === "replaced") return "replaced";
  if (!row.validUntil) return "current";
  if (row.validUntil < today) return "expired";
  if (row.validUntil < addDaysIso(today, EXPIRING_SOON_DAYS)) return "expiring";
  return "current";
}

function serializeDoc(
  row: AttachmentRow & { siteName?: string | null },
  today: string,
) {
  return {
    id: row.id,
    siteId: row.siteId ?? null,
    siteName: row.siteName ?? null,
    customerId: row.customerId ?? null,
    type: row.type,
    fileName: row.fileName ?? null,
    url: row.url ?? null,
    description: row.description ?? null,
    title: row.title ?? null,
    documentNumber: row.documentNumber ?? null,
    revision: row.revision ?? null,
    issuedAt: row.issuedAt ?? null,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    docStatus: computeDocStatus(row, today),
    replacesAttachmentId: row.replacesAttachmentId ?? null,
    tags: row.tags ?? null,
    mimeType: row.mimeType ?? null,
    fileSize: row.fileSize ?? null,
    sha256: row.sha256 ?? null,
    uploadedByUserId: row.uploadedByUserId ?? null,
    uploadedByNameSnapshot: row.uploadedByNameSnapshot ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

router.get("/customers/:customerId/documents", async (req, res): Promise<void> => {
  const pathParams = ListCustomerDocumentsParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const query = ListCustomerDocumentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { customerId } = pathParams.data;
  const { siteId, type, status, validity, search } = query.data;

  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const rows = await db
    .select({
      id: customerSiteAttachmentsTable.id,
      siteId: customerSiteAttachmentsTable.siteId,
      siteName: customerSitesTable.name,
      customerId: customerSiteAttachmentsTable.customerId,
      type: customerSiteAttachmentsTable.type,
      fileName: customerSiteAttachmentsTable.fileName,
      url: customerSiteAttachmentsTable.url,
      description: customerSiteAttachmentsTable.description,
      title: customerSiteAttachmentsTable.title,
      documentNumber: customerSiteAttachmentsTable.documentNumber,
      revision: customerSiteAttachmentsTable.revision,
      issuedAt: customerSiteAttachmentsTable.issuedAt,
      validFrom: customerSiteAttachmentsTable.validFrom,
      validUntil: customerSiteAttachmentsTable.validUntil,
      docStatus: customerSiteAttachmentsTable.docStatus,
      replacesAttachmentId: customerSiteAttachmentsTable.replacesAttachmentId,
      tags: customerSiteAttachmentsTable.tags,
      mimeType: customerSiteAttachmentsTable.mimeType,
      fileSize: customerSiteAttachmentsTable.fileSize,
      sha256: customerSiteAttachmentsTable.sha256,
      uploadedByUserId: customerSiteAttachmentsTable.uploadedByUserId,
      uploadedByNameSnapshot: customerSiteAttachmentsTable.uploadedByNameSnapshot,
      createdAt: customerSiteAttachmentsTable.createdAt,
      updatedAt: customerSiteAttachmentsTable.updatedAt,
      archivedAt: customerSiteAttachmentsTable.archivedAt,
    })
    .from(customerSiteAttachmentsTable)
    .leftJoin(customerSitesTable, eq(customerSiteAttachmentsTable.siteId, customerSitesTable.id))
    .where(
      and(
        eq(customerSiteAttachmentsTable.customerId, customerId),
        siteId != null ? eq(customerSiteAttachmentsTable.siteId, siteId) : undefined,
        type ? eq(customerSiteAttachmentsTable.type, type) : undefined,
        search
          ? or(
              ilike(customerSiteAttachmentsTable.title, `%${search}%`),
              ilike(customerSiteAttachmentsTable.fileName, `%${search}%`),
              ilike(customerSiteAttachmentsTable.documentNumber, `%${search}%`),
            )
          : undefined,
      ),
    )
    .orderBy(customerSiteAttachmentsTable.createdAt);

  const today = todayIso();

  let results = rows.map((r) => serializeDoc(r as AttachmentRow & { siteName?: string | null }, today));

  if (status) {
    results = results.filter((d) => d.docStatus === status);
  }

  if (validity === "current") {
    results = results.filter((d) => d.docStatus === "current");
  } else if (validity === "expiring") {
    results = results.filter((d) => d.docStatus === "expiring");
  } else if (validity === "expired") {
    results = results.filter((d) => d.docStatus === "expired");
  } else if (validity === "noexpiry") {
    results = results.filter((d) => d.validUntil == null && d.docStatus !== "archived");
  }

  res.json(results);
});

router.post("/customers/:customerId/documents", async (req, res): Promise<void> => {
  const pathParams = CreateCustomerDocumentParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const body = CreateCustomerDocumentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { customerId } = pathParams.data;

  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  if (body.data.siteId != null) {
    const [site] = await db
      .select({ id: customerSitesTable.id })
      .from(customerSitesTable)
      .where(
        and(
          eq(customerSitesTable.id, body.data.siteId),
          eq(customerSitesTable.customerId, customerId),
        ),
      );
    if (!site) {
      res.status(400).json({ error: "Site not found or does not belong to this customer" });
      return;
    }
  }

  const [doc] = await db
    .insert(customerSiteAttachmentsTable)
    .values({
      customerId,
      siteId: body.data.siteId ?? null,
      type: body.data.type,
      title: body.data.title,
      fileName: body.data.fileName ?? null,
      url: body.data.url ?? null,
      description: body.data.description ?? null,
      documentNumber: body.data.documentNumber ?? null,
      revision: body.data.revision ?? null,
      issuedAt: body.data.issuedAt ?? null,
      validFrom: body.data.validFrom ?? null,
      validUntil: body.data.validUntil ?? null,
      tags: body.data.tags ?? null,
      mimeType: body.data.mimeType ?? null,
      fileSize: body.data.fileSize ?? null,
      sha256: body.data.sha256 ?? null,
      uploadedByUserId: req.auth?.userId ?? null,
      uploadedByNameSnapshot: req.auth?.name ?? req.auth?.username ?? null,
      docStatus: "current",
    })
    .returning();

  const today = todayIso();
  res.status(201).json(serializeDoc({ ...doc, siteName: null } as AttachmentRow & { siteName?: string | null }, today));
});

router.get("/customers/:customerId/documents/summary", async (req, res): Promise<void> => {
  const pathParams = GetCustomerDocumentsSummaryParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const { customerId } = pathParams.data;

  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const rows = await db
    .select({
      docStatus: customerSiteAttachmentsTable.docStatus,
      validUntil: customerSiteAttachmentsTable.validUntil,
      archivedAt: customerSiteAttachmentsTable.archivedAt,
    })
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.customerId, customerId));

  const today = todayIso();
  const expirySoon = addDaysIso(today, EXPIRING_SOON_DAYS);

  let current = 0;
  let expiringSoon = 0;
  let expired = 0;
  let noExpiry = 0;
  let nextExpiry: string | null = null;

  for (const r of rows) {
    const computed = computeDocStatus(r, today);
    if (computed === "archived" || computed === "replaced") continue;
    if (computed === "current" && !r.validUntil) {
      noExpiry++;
    } else if (computed === "current") {
      current++;
    } else if (computed === "expiring") {
      expiringSoon++;
      if (!nextExpiry || r.validUntil! < nextExpiry) {
        nextExpiry = r.validUntil!;
      }
    } else if (computed === "expired") {
      expired++;
    }
  }

  const total = current + expiringSoon + expired + noExpiry;

  res.json({ current, expiringSoon, expired, noExpiry, total, nextExpiry });
});

router.patch("/customer-documents/:id", async (req, res): Promise<void> => {
  const pathParams = UpdateCustomerDocumentParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const body = UpdateCustomerDocumentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select({ id: customerSiteAttachmentsTable.id, siteId: customerSiteAttachmentsTable.siteId, customerId: customerSiteAttachmentsTable.customerId })
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id));
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const updateData: Partial<typeof customerSiteAttachmentsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.data.type !== undefined) updateData.type = body.data.type;
  if (body.data.title !== undefined) updateData.title = body.data.title;
  if (body.data.fileName !== undefined) updateData.fileName = body.data.fileName;
  if (body.data.description !== undefined) updateData.description = body.data.description;
  if (body.data.documentNumber !== undefined) updateData.documentNumber = body.data.documentNumber;
  if (body.data.revision !== undefined) updateData.revision = body.data.revision;
  if (body.data.issuedAt !== undefined) updateData.issuedAt = body.data.issuedAt;
  if (body.data.validFrom !== undefined) updateData.validFrom = body.data.validFrom;
  if (body.data.validUntil !== undefined) updateData.validUntil = body.data.validUntil;
  if (body.data.tags !== undefined) updateData.tags = body.data.tags;
  if (body.data.docStatus !== undefined) updateData.docStatus = body.data.docStatus;

  const [updated] = await db
    .update(customerSiteAttachmentsTable)
    .set(updateData)
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id))
    .returning();

  const [siteRow] = updated.siteId
    ? await db
        .select({ name: customerSitesTable.name })
        .from(customerSitesTable)
        .where(eq(customerSitesTable.id, updated.siteId))
    : [{ name: null }];

  const today = todayIso();
  res.json(serializeDoc({ ...updated, siteName: siteRow?.name ?? null } as AttachmentRow & { siteName?: string | null }, today));
});

router.delete("/customer-documents/:id", requireRole("master"), async (req, res): Promise<void> => {
  const pathParams = DeleteCustomerDocumentParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const [doc] = await db
    .select({ id: customerSiteAttachmentsTable.id, url: customerSiteAttachmentsTable.url, customerId: customerSiteAttachmentsTable.customerId })
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.update(customerSiteAttachmentsTable)
      .set({ replacesAttachmentId: null })
      .where(eq(customerSiteAttachmentsTable.replacesAttachmentId, doc.id));

    await tx.delete(customerSiteAttachmentsTable).where(eq(customerSiteAttachmentsTable.id, doc.id));

    await tx.insert(auditLogTable).values({
      actorUserId: req.auth?.userId ?? null,
      actorName: req.auth?.name ?? req.auth?.username ?? null,
      action: "delete",
      entityType: "customer_document",
      entityId: doc.id,
      summary: `Smazán zákaznický dokument #${doc.id} (zákazník #${doc.customerId})`,
      method: "DELETE",
      path: req.path,
    });
  });

  if (doc.url) {
    try {
      await objectStorage.deletePrivateObject(doc.url);
    } catch (err) {
      req.log.warn({ err, url: doc.url }, "customer-documents: failed to delete object from storage");
    }
  }

  res.sendStatus(204);
});

router.post("/customer-documents/:id/archive", async (req, res): Promise<void> => {
  const pathParams = ArchiveCustomerDocumentParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const [doc] = await db
    .select()
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const [updated] = await db
    .update(customerSiteAttachmentsTable)
    .set({ docStatus: "archived", archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id))
    .returning();

  const [siteRow] = updated.siteId
    ? await db
        .select({ name: customerSitesTable.name })
        .from(customerSitesTable)
        .where(eq(customerSitesTable.id, updated.siteId))
    : [{ name: null }];

  const today = todayIso();
  res.json(serializeDoc({ ...updated, siteName: siteRow?.name ?? null } as AttachmentRow & { siteName?: string | null }, today));
});

router.post("/customer-documents/:id/replace", async (req, res): Promise<void> => {
  const pathParams = ReplaceCustomerDocumentParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const body = ReplaceCustomerDocumentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [oldDoc] = await db
    .select()
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.id, pathParams.data.id));
  if (!oldDoc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (!oldDoc.customerId) {
    res.status(400).json({ error: "Document has no associated customer" });
    return;
  }

  const [newDoc] = await db.transaction(async (tx) => {
    await tx
      .update(customerSiteAttachmentsTable)
      .set({ docStatus: "replaced", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(customerSiteAttachmentsTable.id, oldDoc.id));

    return tx
      .insert(customerSiteAttachmentsTable)
      .values({
        customerId: oldDoc.customerId!,
        siteId: body.data.siteId ?? oldDoc.siteId ?? null,
        type: body.data.type,
        title: body.data.title,
        fileName: body.data.fileName ?? null,
        url: body.data.url ?? null,
        description: body.data.description ?? null,
        documentNumber: body.data.documentNumber ?? null,
        revision: body.data.revision ?? null,
        issuedAt: body.data.issuedAt ?? null,
        validFrom: body.data.validFrom ?? null,
        validUntil: body.data.validUntil ?? null,
        tags: body.data.tags ?? null,
        mimeType: body.data.mimeType ?? null,
        fileSize: body.data.fileSize ?? null,
        sha256: body.data.sha256 ?? null,
        replacesAttachmentId: oldDoc.id,
        uploadedByUserId: req.auth?.userId ?? null,
        uploadedByNameSnapshot: req.auth?.name ?? req.auth?.username ?? null,
        docStatus: "current",
      })
      .returning();
  });

  const [siteRow] = newDoc.siteId
    ? await db
        .select({ name: customerSitesTable.name })
        .from(customerSitesTable)
        .where(eq(customerSitesTable.id, newDoc.siteId))
    : [{ name: null }];

  const today = todayIso();
  res.status(201).json(serializeDoc({ ...newDoc, siteName: siteRow?.name ?? null } as AttachmentRow & { siteName?: string | null }, today));
});

export default router;
