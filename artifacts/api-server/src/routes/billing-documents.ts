import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import {
  UpdateCostDocumentBody,
  SetCostDocumentStatusBody,
  MarkCostDocumentDuplicateBody,
  UpdateCostDocumentLineBody,
  SplitCostDocumentLineBody,
  AddCostDocumentReferenceBody,
  UpdateCostDocumentReferenceBody,
} from "@workspace/api-zod";
import { requirePermission } from "../middlewares/permissions";
import {
  contentMatchesType,
  validateZipContents,
  BILLING_ALLOWED_MIME_TYPES,
} from "../lib/fileSignature";
import {
  ingestFile,
  ingestGroupFile,
  listDocuments,
  getDocument,
  updateDocument,
  updateLine,
  splitLine,
  approveDocument,
  setDocumentStatus,
  markDocumentAsDuplicate,
  unmarkDocumentDuplicate,
  requeueExtraction,
  requeueAllExtractions,
  reanalyzeJobAttachmentDocuments,
  deleteDocument,
  analyzeJobDocuments,
  getApprovedLinesForCustomer,
  addReference,
  updateReference,
  deleteReference,
  matchDocumentReferences,
  reconcileDocumentRelationships,
  suggestDocumentMatches,
  updateWarehousePricesFromDocument,
  listReviewQueue,
  bulkConfirmReviewLines,
  skipReviewLines,
  returnReviewLines,
  assignWarehouseItemToLine,
  mergeDocumentPages,
  mergeJobDocumentPages,
  reorderDocumentMerge,
  revertDocumentMerge,
  confirmDocumentType,
  type AppError,
  type Actor,
} from "../lib/cost-document-service";
import {
  resolveOpenAiConfig,
  testConfiguration as testAiConfiguration,
  DEFAULT_SYSTEM_PROMPT,
} from "../lib/openai-extraction";
import {
  db,
  openaiSettingsTable,
  documentLinkingSettingsTable,
  activitiesTable,
  jobsTable,
  attachmentsTable,
  billingDocumentFilesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAssignedJobWork } from "../middlewares/job-work-access";
import {
  UpdateDocumentExtractionBody,
  UpdateDocumentLinkingBody,
} from "@workspace/api-zod";
import {
  resolveDocumentLinkingConfig,
  DOCUMENT_LINKING_SETTINGS_ID,
} from "../lib/document-linking-config";

const router: IRouter = Router();

const MergeDocumentPagesBody = z.object({
  orderedDocumentIds: z.array(z.number().int().positive()).min(2).max(50),
});
const ReorderDocumentMergeBody = z.object({
  orderedDocumentIds: z.array(z.number().int().positive()).min(2).max(50),
});
const ConfirmDocumentTypeBody = z.object({
  docType: z.enum(["receipt", "delivery_note", "invoice", "credit_note"]),
});
const MergeJobDocumentPagesBody = z.object({
  orderedAttachmentIds: z.array(z.number().int().positive()).min(2).max(50),
});

// --- AI extraction (OpenAI) — optional, admin-only status + connectivity test ---

const OPENAI_SETTINGS_ID = 1;

function serializeExtractionStatus(cfg: {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  model: string;
  maxFileMb: number;
  timeoutMs: number;
  systemPrompt: string;
  confidenceThreshold: number;
  source: "db" | "env" | "none";
}) {
  return {
    configured: cfg.configured,
    enabled: cfg.enabled,
    ready: cfg.ready,
    model: cfg.model,
    maxFileMb: cfg.maxFileMb,
    requestTimeoutMs: cfg.timeoutMs,
    confidenceThreshold: cfg.confidenceThreshold,
    systemPrompt: cfg.systemPrompt,
    // The built-in default prompt, so the UI can offer "reset to default"
    // even when an operator has saved a custom prompt that hides new rules.
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    source: cfg.source,
  };
}

router.get("/billing/ai-extraction", async (_req, res): Promise<void> => {
  const cfg = await resolveOpenAiConfig();
  res.json(serializeExtractionStatus(cfg));
});

// Save the OpenAI configuration (API key + model + master switch) into the DB
// singleton so it can be set from the Settings UI without redeploying. The key
// is write-only: a non-empty string sets it, "" clears it, null/omitted keeps it.
router.put("/billing/ai-extraction", async (req, res): Promise<void> => {
  const parsed = UpdateDocumentExtractionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;

  const [existing] = await db
    .select()
    .from(openaiSettingsTable)
    .where(eq(openaiSettingsTable.id, OPENAI_SETTINGS_ID));

  const apiKey =
    typeof d.apiKey === "string" ? d.apiKey.trim() || null : existing?.apiKey ?? null;

  const toIntOrNull = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

  const values: typeof openaiSettingsTable.$inferInsert = {
    id: OPENAI_SETTINGS_ID,
    enabled: d.enabled,
    apiKey,
    model: d.model?.trim() || null,
    systemPrompt: d.systemPrompt?.trim() || null,
    maxFileMb: toIntOrNull(d.maxFileMb),
    requestTimeoutMs: toIntOrNull(d.requestTimeoutMs),
    confidenceThreshold:
      typeof d.confidenceThreshold === "number" &&
      Number.isFinite(d.confidenceThreshold)
        ? Math.min(1, Math.max(0, d.confidenceThreshold))
        : null,
    updatedAt: new Date(),
  };

  await db
    .insert(openaiSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: openaiSettingsTable.id, set: values });

  const cfg = await resolveOpenAiConfig();
  res.json(serializeExtractionStatus(cfg));
});

// Verifies the API key + model are reachable. Sends NO real document.
router.post("/billing/ai-extraction/test", async (req, res): Promise<void> => {
  try {
    const result = await testAiConfiguration();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "OpenAI configuration test failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Test konfigurace OpenAI selhal.",
    });
  }
});

// --- Automatic document linking — admin-only status + config ---------------

// Returns the active config plus where it came from ("db" once saved, else the
// "env"/built-in defaults), mirroring the AI-extraction status shape.
router.get("/billing/document-linking", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(documentLinkingSettingsTable)
    .where(eq(documentLinkingSettingsTable.id, DOCUMENT_LINKING_SETTINGS_ID));
  const cfg = await resolveDocumentLinkingConfig();
  res.json({
    autoLinkEnabled: cfg.autoLinkEnabled,
    autoConfirmEnabled: cfg.autoConfirmEnabled,
    autoLinkMinScore: cfg.autoLinkMinScore,
    autoConfirmMinScore: cfg.autoConfirmMinScore,
    source: row ? "db" : "env",
  });
});

// Save the linking configuration into the DB singleton so an admin can toggle it
// from the Settings UI without redeploying. The two switches always win once a
// row exists; the thresholds are nullable and fall back per-field to env/default.
router.put("/billing/document-linking", async (req, res): Promise<void> => {
  const parsed = UpdateDocumentLinkingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;

  const toScoreOrNull = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

  const values: typeof documentLinkingSettingsTable.$inferInsert = {
    id: DOCUMENT_LINKING_SETTINGS_ID,
    autoLinkEnabled: d.autoLinkEnabled,
    autoConfirmEnabled: d.autoConfirmEnabled,
    autoLinkMinScore: toScoreOrNull(d.autoLinkMinScore),
    autoConfirmMinScore: toScoreOrNull(d.autoConfirmMinScore),
    updatedAt: new Date(),
  };

  await db
    .insert(documentLinkingSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: documentLinkingSettingsTable.id, set: values });

  const cfg = await resolveDocumentLinkingConfig();
  res.json({
    autoLinkEnabled: cfg.autoLinkEnabled,
    autoConfirmEnabled: cfg.autoConfirmEnabled,
    autoLinkMinScore: cfg.autoLinkMinScore,
    autoConfirmMinScore: cfg.autoConfirmMinScore,
    source: "db",
  });
});

// Same hard cap as the generic upload route (see routes/storage.ts). Keep nginx's
// client_max_body_size at/above this or large files are rejected at the proxy.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// The accepted MIME types are defined in fileSignature.ts so that the allowlist
// and the magic-byte validators share a single source of truth.
const ALLOWED_UPLOAD_TYPES = BILLING_ALLOWED_MIME_TYPES;

function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    typeof (err as Partial<AppError>).statusCode === "number"
  );
}

function handleError(err: unknown, fallback: string, res: Response): void {
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : fallback });
}

function actorOf(req: Request): Actor {
  // requireRole guarantees req.auth is present.
  return { userId: req.auth!.userId, name: req.auth!.name };
}

function parseId(raw: string | string[]): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(s);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optInt(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function optNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get("/billing/documents", async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const supplierIc =
    typeof req.query.supplierIc === "string" ? req.query.supplierIc : undefined;
  const aiOnly = req.query.aiOnly === "true";
  const sort = typeof req.query.sort === "string" ? req.query.sort : undefined;
  const docs = await listDocuments({
    status,
    supplierIc,
    jobId: optInt(req.query.jobId),
    customerId: optInt(req.query.customerId),
    aiOnly,
    sort,
  });
  res.json(docs);
});

// ---------------------------------------------------------------------------
// Upload (raw octet-stream → object storage → cost document)
// ---------------------------------------------------------------------------

router.post(
  "/jobs/:id/documents/upload",
  requireAssignedJobWork,
  (req: Request, res: Response, next: NextFunction) => {
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (error) => {
      const bodyError = error as { type?: string; status?: number } | undefined;
      if (bodyError?.type === "entity.too.large" || bodyError?.status === 413) {
        res.status(413).json({ error: `Soubor je prilis velky (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).` });
        return;
      }
      if (error) next(error);
      else next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const jobId = parseId(req.params.id);
    const name = typeof req.query.name === "string" ? req.query.name : "doklad";
    const contentType = typeof req.query.contentType === "string" ? req.query.contentType : "";
    const declaredDocType =
      typeof req.query.docType === "string" &&
      ["receipt", "delivery_note", "invoice", "credit_note"].includes(req.query.docType)
        ? req.query.docType
        : undefined;
    const groupToken =
      typeof req.query.groupToken === "string" && req.query.groupToken.trim()
        ? req.query.groupToken.trim()
        : "";
    const pageIndex = optNonNegativeInt(req.query.pageIndex);
    const pageCount = optInt(req.query.pageCount);
    const groupComplete = req.query.groupComplete === "true";
    if (
      jobId == null || !groupToken || groupToken.length > 100 ||
      pageIndex == null || pageCount == null || pageIndex < 0 || pageIndex >= pageCount || pageCount > 50
    ) {
      res.status(400).json({ error: "Chybí platná zakázka, skupina nebo pořadí stránky." });
      return;
    }
    if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
      res.status(415).json({ error: "Tento typ souboru není povolen." });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || !contentMatchesType(contentType, body)) {
      res.status(415).json({ error: "Obsah souboru neodpovídá podporovanému typu." });
      return;
    }
    try {
      const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
      if (!job) {
        res.status(404).json({ error: "Zakázka nebyla nalezena." });
        return;
      }
      const result = await ingestGroupFile(
        body,
        {
          fileName: name,
          contentType,
          source: "job_attachment",
          docType: declaredDocType,
          jobId,
          customerId: job.customerId ?? null,
          groupToken,
          groupComplete,
          pageIndex,
          pageCount,
        },
        actorOf(req),
      );
      if (result.status === "duplicate") {
        res.status(409).json({ error: "Tato stránka už byla nahrána.", duplicates: result.duplicates });
        return;
      }
      const [file] = await db
        .select()
        .from(billingDocumentFilesTable)
        .where(and(
          eq(billingDocumentFilesTable.documentId, result.document.id),
          eq(billingDocumentFilesTable.pageIndex, pageIndex),
        ));
      if (!file?.objectPath) throw new Error("Uložená stránka nemá objektovou cestu.");
      let [attachment] = await db
        .select()
        .from(attachmentsTable)
        .where(and(
          eq(attachmentsTable.jobId, jobId),
          eq(attachmentsTable.billingDocumentId, result.document.id),
          eq(attachmentsTable.pageIndex, pageIndex),
        ));
      if (!attachment) {
        [attachment] = await db
          .insert(attachmentsTable)
          .values({
            jobId,
            type: declaredDocType ?? "document",
            fileName: name,
            url: file.objectPath,
            billingDocumentId: result.document.id,
            pageIndex,
          })
          .returning();
      }
      res.status(201).json({
        documentId: result.document.id,
        status: result.document.status,
        docType: result.document.docType,
        pageIndex,
        pageCount,
        groupComplete,
        attachment: { id: attachment.id, fileName: attachment.fileName, url: attachment.url },
      });
    } catch (error) {
      handleError(error, "Stránku dokladu se nepodařilo nahrát.", res);
    }
  },
);

router.post(
  "/jobs/:id/documents/merge-pages",
  requireAssignedJobWork,
  async (req, res): Promise<void> => {
    const jobId = parseId(req.params.id);
    const parsed = MergeJobDocumentPagesBody.safeParse(req.body);
    if (jobId == null || !parsed.success) {
      res.status(400).json({ error: "Neplatná zakázka nebo výběr stran." });
      return;
    }
    try {
      res.json(await mergeJobDocumentPages(jobId, parsed.data.orderedAttachmentIds, actorOf(req)));
    } catch (error) {
      handleError(error, "Stránky zakázkového dokladu se nepodařilo sloučit.", res);
    }
  },
);

router.post(
  "/billing/documents/upload",
  (req: Request, res: Response, next: NextFunction) => {
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err) => {
      if (err) {
        const e = err as { type?: string; status?: number };
        if (e.type === "entity.too.large" || e.status === 413) {
          res.status(413).json({
            error: `Soubor je příliš velký (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const name = typeof req.query.name === "string" ? req.query.name : "";
    const contentType =
      typeof req.query.contentType === "string" ? req.query.contentType : "";
    const docType =
      typeof req.query.docType === "string" ? req.query.docType : undefined;
    const force = req.query.force === "true";
    const jobId = optInt(req.query.jobId) ?? null;
    const customerId = optInt(req.query.customerId) ?? null;
    // Multi-page photo upload (task #679): the client generates one token and
    // sends it with every page of the same document, marking the last page
    // with groupComplete=true so extraction/merge only run once, on the full set.
    const groupToken =
      typeof req.query.groupToken === "string" && req.query.groupToken.trim()
        ? req.query.groupToken.trim()
        : undefined;
    const groupComplete = req.query.groupComplete === "true";
    const pageIndex = optNonNegativeInt(req.query.pageIndex);
    const pageCount = optInt(req.query.pageCount);
    if (groupToken && groupToken.length > 100) {
      res.status(400).json({ error: "Neplatný identifikátor skupiny stránek." });
      return;
    }
    if (
      groupToken &&
      (pageIndex == null || pageIndex < 0 || pageIndex >= 50 ||
        pageCount == null || pageCount < 1 || pageCount > 50)
    ) {
      res.status(400).json({ error: "Chybí platné pořadí nebo počet stránek dokladu." });
      return;
    }

    if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
      res.status(415).json({ error: "Tento typ souboru není povolen." });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Chybí obsah souboru." });
      return;
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `Soubor je příliš velký (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
      });
      return;
    }
    if (!contentMatchesType(contentType, body)) {
      res.status(415).json({ error: "Obsah souboru neodpovídá jeho typu." });
      return;
    }

    if (contentType === "application/zip") {
      const zipCheck = validateZipContents(body);
      if (!zipCheck.ok) {
        res.status(415).json({
          error: zipCheck.reason ?? "Obsah archivu není podporován.",
        });
        return;
      }
    }

    try {
      // Pre-create duplicate check on exact content hash. The admin can re-submit
      // with ?force=true to import anyway (near-duplicates are surfaced after
      // creation via the document's `duplicates` list).
      const result = groupToken
        ? await ingestGroupFile(
            body,
            {
              fileName: name || "doklad",
              contentType,
              source: "manual",
              docType,
              jobId,
              customerId,
              groupToken,
              groupComplete,
              pageIndex: pageIndex!,
              pageCount: pageCount!,
            },
            actorOf(req),
            force,
          )
        : await ingestFile(
            body,
            {
              fileName: name || "doklad",
              contentType,
              source: "manual",
              docType,
              jobId,
              customerId,
            },
            actorOf(req),
            force,
          );
      if (result.status === "duplicate") {
        res.status(409).json({
          message:
            "Tento soubor už pravděpodobně byl nahrán. Zkontrolujte duplicity níže.",
          duplicates: result.duplicates,
        });
        return;
      }
      const detail = await getDocument(result.document.id);
      res.json(detail);
    } catch (error) {
      req.log.error({ err: error }, "Error uploading cost document");
      handleError(error, "Doklad se nepodařilo vytvořit.", res);
    }
  },
);

// ---------------------------------------------------------------------------
// Detail / update / delete
// ---------------------------------------------------------------------------

router.post("/billing/documents/merge-pages", async (req, res): Promise<void> => {
  const parsed = MergeDocumentPagesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await mergeDocumentPages(parsed.data, actorOf(req)));
  } catch (error) {
    handleError(error, "Doklady se nepodařilo sloučit.", res);
  }
});

router.post("/billing/document-merges/:mergeId/order", async (req, res): Promise<void> => {
  const mergeId = parseId(req.params.mergeId);
  const parsed = ReorderDocumentMergeBody.safeParse(req.body);
  if (mergeId == null || !parsed.success) {
    res.status(400).json({ error: "Neplatné sloučení nebo pořadí stran." });
    return;
  }
  try {
    res.json(await reorderDocumentMerge(mergeId, parsed.data.orderedDocumentIds, actorOf(req)));
  } catch (error) {
    handleError(error, "Pořadí stran se nepodařilo změnit.", res);
  }
});

router.post("/billing/document-merges/:mergeId/revert", async (req, res): Promise<void> => {
  const mergeId = parseId(req.params.mergeId);
  if (mergeId == null) {
    res.status(400).json({ error: "Neplatné sloučení." });
    return;
  }
  try {
    res.json(await revertDocumentMerge(mergeId, actorOf(req)));
  } catch (error) {
    handleError(error, "Sloučení se nepodařilo rozdělit.", res);
  }
});

router.post("/billing/documents/:id/confirm-type", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const parsed = ConfirmDocumentTypeBody.safeParse(req.body);
  if (id == null || !parsed.success) {
    res.status(400).json({ error: "Neplatný doklad nebo typ." });
    return;
  }
  try {
    res.json(await confirmDocumentType(id, parsed.data.docType, actorOf(req)));
  } catch (error) {
    handleError(error, "Typ dokladu se nepodařilo potvrdit.", res);
  }
});

router.get("/billing/documents/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  const detail = await getDocument(id);
  if (!detail) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  res.json(detail);
});

router.patch("/billing/documents/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  const parsed = UpdateCostDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const detail = await updateDocument(id, {
      docType: d.docType,
      supplierName: d.supplierName,
      supplierIc: d.supplierIc,
      supplierDic: d.supplierDic,
      supplierAddress: d.supplierAddress,
      documentNumber: d.documentNumber,
      variableSymbol: d.variableSymbol,
      issueDate: d.issueDate,
      taxableSupplyDate: d.taxableSupplyDate,
      dueDate: d.dueDate,
      currency: d.currency,
      subtotalWithoutVat: d.subtotalWithoutVat,
      totalVat: d.totalVat,
      totalWithVat: d.totalWithVat,
      customerId: d.customerId,
      jobId: d.jobId,
      notes: d.notes,
    }, actorOf(req));
    res.json(detail);
  } catch (error) {
    handleError(error, "Doklad se nepodařilo upravit.", res);
  }
});

router.delete("/billing/documents/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  try {
    await deleteDocument(id, actorOf(req));
    res.status(204).end();
  } catch (error) {
    handleError(error, "Doklad se nepodařilo smazat.", res);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: approve / status / requeue
// ---------------------------------------------------------------------------

router.post("/billing/documents/:id/approve", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  try {
    const detail = await approveDocument(id, actorOf(req));
    res.json(detail);
  } catch (error) {
    handleError(error, "Doklad se nepodařilo schválit.", res);
  }
});

router.post("/billing/documents/:id/status", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  const parsed = SetCostDocumentStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const detail = await setDocumentStatus(
      id,
      parsed.data.status as "needs_review" | "reviewed" | "ignored" | "duplicate",
      actorOf(req),
    );
    res.json(detail);
  } catch (error) {
    handleError(error, "Stav dokladu se nepodařilo změnit.", res);
  }
});

router.post("/billing/documents/:id/mark-duplicate", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  const parsed = MarkCostDocumentDuplicateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const detail = await markDocumentAsDuplicate(
      id,
      parsed.data.primaryDocumentId,
      actorOf(req),
    );
    res.json(detail);
  } catch (error) {
    handleError(error, "Doklad se nepodařilo spárovat jako duplicitu.", res);
  }
});

router.post("/billing/documents/:id/unmark-duplicate", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  try {
    const detail = await unmarkDocumentDuplicate(id, actorOf(req));
    res.json(detail);
  } catch (error) {
    handleError(error, "Zrušení párování se nezdařilo.", res);
  }
});

router.post("/billing/documents/:id/extract", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(404).json({ error: "Doklad nenalezen." });
    return;
  }
  try {
    const detail = await requeueExtraction(id);
    res.json(detail);
  } catch (error) {
    handleError(error, "Zpracování se nepodařilo zařadit.", res);
  }
});

router.post("/billing/documents/extract-all", async (req, res): Promise<void> => {
  try {
    const result = await requeueAllExtractions(actorOf(req));
    res.json(result);
  } catch (error) {
    handleError(error, "Hromadnou AI analýzu se nepodařilo zařadit.", res);
  }
});

router.post("/billing/documents/reanalyze-job-attachments", async (req, res): Promise<void> => {
  try {
    const result = await reanalyzeJobAttachmentDocuments(actorOf(req));
    res.json(result);
  } catch (error) {
    handleError(error, "Zakázkové doklady se nepodařilo znovu analyzovat.", res);
  }
});

// ---------------------------------------------------------------------------
// Line operations (matching / splitting)
// ---------------------------------------------------------------------------

router.patch(
  "/billing/documents/:id/lines/:lineId",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    const lineId = parseId(req.params.lineId);
    if (id == null || lineId == null) {
      res.status(404).json({ error: "Položka nenalezena." });
      return;
    }
    const parsed = UpdateCostDocumentLineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const d = parsed.data;
    // Validate activity exists when provided.
    if (d.activityId != null) {
      const [act] = await db
        .select({ id: activitiesTable.id })
        .from(activitiesTable)
        .where(eq(activitiesTable.id, d.activityId));
      if (!act) {
        res.status(400).json({ error: `Akce #${d.activityId} nenalezena.` });
        return;
      }
    }
    try {
      const detail = await updateLine(
        id,
        lineId,
        {
          lineType: d.lineType,
          description: d.description,
          quantity: d.quantity,
          unit: d.unit,
          unitPriceWithoutVat: d.unitPriceWithoutVat,
          vatRate: d.vatRate,
          jobId: d.jobId,
          activityId: d.activityId,
          allocationType: d.allocationType,
          matchConfirmed: d.matchConfirmed,
          approved: d.approved,
        },
        actorOf(req),
      );
      res.json(detail);
    } catch (error) {
      handleError(error, "Položku se nepodařilo upravit.", res);
    }
  },
);

router.post(
  "/billing/documents/:id/lines/:lineId/split",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    const lineId = parseId(req.params.lineId);
    if (id == null || lineId == null) {
      res.status(404).json({ error: "Položka nenalezena." });
      return;
    }
    const parsed = SplitCostDocumentLineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const detail = await splitLine(
        id,
        lineId,
        parsed.data.parts.map((p) => ({
          quantity: p.quantity,
          jobId: p.jobId,
          activityId: p.activityId,
          allocationType: p.allocationType,
        })),
        actorOf(req),
      );
      res.json(detail);
    } catch (error) {
      handleError(error, "Položku se nepodařilo rozdělit.", res);
    }
  },
);

// ---------------------------------------------------------------------------
// References (delivery notes / orders / sibling documents)
//
// Admin only via the path-scoped gate on /billing/documents above. The matcher
// only produces SUGGESTIONS — an admin confirms/changes/rejects each link.
// ---------------------------------------------------------------------------

router.post(
  "/billing/documents/:id/references",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Doklad nenalezen." });
      return;
    }
    const parsed = AddCostDocumentReferenceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const detail = await addReference(id, {
        referenceType: parsed.data.referenceType,
        referenceNumber: parsed.data.referenceNumber,
        source: parsed.data.source ?? undefined,
        confidence: parsed.data.confidence,
      }, actorOf(req));
      res.json(detail);
    } catch (error) {
      handleError(error, "Referenci se nepodařilo přidat.", res);
    }
  },
);

router.patch(
  "/billing/documents/:id/references/:referenceId",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    const referenceId = parseId(req.params.referenceId);
    if (id == null || referenceId == null) {
      res.status(404).json({ error: "Reference nenalezena." });
      return;
    }
    const parsed = UpdateCostDocumentReferenceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const detail = await updateReference(
        id,
        referenceId,
        parsed.data,
        actorOf(req),
      );
      res.json(detail);
    } catch (error) {
      handleError(error, "Referenci se nepodařilo upravit.", res);
    }
  },
);

router.delete(
  "/billing/documents/:id/references/:referenceId",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    const referenceId = parseId(req.params.referenceId);
    if (id == null || referenceId == null) {
      res.status(404).json({ error: "Reference nenalezena." });
      return;
    }
    try {
      const detail = await deleteReference(id, referenceId, actorOf(req));
      res.json(detail);
    } catch (error) {
      handleError(error, "Referenci se nepodařilo odstranit.", res);
    }
  },
);

router.post(
  "/billing/documents/:id/match-references",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Doklad nenalezen." });
      return;
    }
    try {
      await reconcileDocumentRelationships(id, actorOf(req));
      const result = await matchDocumentReferences(id);
      res.json(result);
    } catch (error) {
      handleError(error, "Párování se nepodařilo provést.", res);
    }
  },
);

router.get(
  "/billing/documents/:id/suggested-matches",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Doklad nenalezen." });
      return;
    }
    try {
      const result = await suggestDocumentMatches(id);
      res.json(result);
    } catch (error) {
      handleError(error, "Návrhy párování se nepodařilo načíst.", res);
    }
  },
);

router.post(
  "/billing/documents/:id/apply-warehouse-prices",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Doklad nenalezen." });
      return;
    }
    try {
      const result = await updateWarehousePricesFromDocument(id, actorOf(req));
      res.json(result);
    } catch (error) {
      handleError(error, "Ceny do skladu se nepodařilo přenést.", res);
    }
  },
);

// ---------------------------------------------------------------------------
// Approved lines → outgoing invoice builder
// ---------------------------------------------------------------------------

router.get("/billing/approved-lines", async (req, res): Promise<void> => {
  const customerId = optInt(req.query.customerId);
  if (customerId == null) {
    res.status(400).json({ error: "Chybí ID zákazníka." });
    return;
  }
  const lines = await getApprovedLinesForCustomer(customerId);
  res.json(lines);
});

// ---------------------------------------------------------------------------
// Review Queue — line-level "K vyřízení" work queue
// ---------------------------------------------------------------------------

router.get("/billing/review-queue", async (req, res): Promise<void> => {
  const page = optInt(req.query.page) ?? 1;
  const pageSize = optInt(req.query.pageSize) ?? 50;
  const reason = typeof req.query.reason === "string" && req.query.reason.length > 0
    ? req.query.reason
    : undefined;
  try {
    const result = await listReviewQueue({ page, pageSize, reason });
    res.json(result);
  } catch (err) {
    handleError(err, "Načtení fronty K vyřízení selhalo.", res);
  }
});

router.post("/billing/review-queue/bulk-confirm", async (req, res): Promise<void> => {
  const body = req.body;
  const lineIds: unknown = body?.lineIds;
  if (!Array.isArray(lineIds) || lineIds.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: "Neplatný seznam ID řádků." });
    return;
  }
  const dryRun = body?.dryRun === true;
  try {
    const diff = await bulkConfirmReviewLines(lineIds as number[], actorOf(req), dryRun);
    res.json(diff);
  } catch (err) {
    handleError(err, "Hromadné potvrzení selhalo.", res);
  }
});

router.post("/billing/review-queue/skip", async (req, res): Promise<void> => {
  const body = req.body;
  const lineIds: unknown = body?.lineIds;
  if (!Array.isArray(lineIds) || lineIds.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: "Neplatný seznam ID řádků." });
    return;
  }
  const reason = typeof body?.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim()
    : "bez důvodu";
  const dryRun = body?.dryRun === true;
  try {
    const result = await skipReviewLines(lineIds as number[], reason, actorOf(req), dryRun);
    res.json(result);
  } catch (err) {
    handleError(err, "Přeskočení řádků selhalo.", res);
  }
});

router.post("/billing/review-queue/return", async (req, res): Promise<void> => {
  const body = req.body;
  const lineIds: unknown = body?.lineIds;
  if (!Array.isArray(lineIds) || lineIds.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: "Neplatný seznam ID řádků." });
    return;
  }
  try {
    const result = await returnReviewLines(lineIds as number[], actorOf(req));
    res.json(result);
  } catch (err) {
    handleError(err, "Vrácení řádků k opravě selhalo.", res);
  }
});

router.post("/billing/review-queue/:lineId/assign-warehouse", async (req, res): Promise<void> => {
  const lineId = parseId(req.params.lineId);
  if (lineId == null) {
    res.status(400).json({ error: "Neplatné ID řádku." });
    return;
  }
  const warehouseItemId = typeof req.body?.warehouseItemId === "number" ? req.body.warehouseItemId : null;
  if (!warehouseItemId || !Number.isInteger(warehouseItemId) || warehouseItemId <= 0) {
    res.status(400).json({ error: "Chybí warehouseItemId." });
    return;
  }
  try {
    const result = await assignWarehouseItemToLine(lineId, warehouseItemId, actorOf(req));
    res.json(result);
  } catch (err) {
    handleError(err, "Přiřazení skladové položky selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Analyze a job's doklady attachments → cost documents
//
// Lives outside the /billing prefix (under /jobs), so the path-scoped admin gate
// above does not apply — guard this route explicitly.
// ---------------------------------------------------------------------------

router.post(
  "/jobs/:id/analyze-documents",
  requirePermission("billing.view"),
  requirePermission("billing.manage"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Zakázka nenalezena." });
      return;
    }
    try {
      const result = await analyzeJobDocuments(id, actorOf(req));
      res.json(result);
    } catch (error) {
      handleError(error, "Doklady se nepodařilo zpracovat.", res);
    }
  },
);

export default router;
