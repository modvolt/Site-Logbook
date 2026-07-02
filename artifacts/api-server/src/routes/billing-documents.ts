import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  UpdateCostDocumentBody,
  SetCostDocumentStatusBody,
  UpdateCostDocumentLineBody,
  SplitCostDocumentLineBody,
  AddCostDocumentReferenceBody,
  UpdateCostDocumentReferenceBody,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import {
  contentMatchesType,
  validateZipContents,
  BILLING_ALLOWED_MIME_TYPES,
} from "../lib/fileSignature";
import {
  ingestFile,
  listDocuments,
  getDocument,
  updateDocument,
  updateLine,
  splitLine,
  approveDocument,
  setDocumentStatus,
  requeueExtraction,
  deleteDocument,
  analyzeJobDocuments,
  getApprovedLinesForCustomer,
  addReference,
  updateReference,
  deleteReference,
  matchDocumentReferences,
  suggestDocumentMatches,
  updateWarehousePricesFromDocument,
  listReviewQueue,
  bulkConfirmReviewLines,
  skipReviewLines,
  returnReviewLines,
  assignWarehouseItemToLine,
  type AppError,
  type Actor,
} from "../lib/cost-document-service";
import {
  resolveOpenAiConfig,
  testConfiguration as testAiConfiguration,
  DEFAULT_SYSTEM_PROMPT,
} from "../lib/openai-extraction";
import { db, openaiSettingsTable, documentLinkingSettingsTable, activitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  UpdateDocumentExtractionBody,
  UpdateDocumentLinkingBody,
} from "@workspace/api-zod";
import {
  resolveDocumentLinkingConfig,
  DOCUMENT_LINKING_SETTINGS_ID,
} from "../lib/document-linking-config";

const router: IRouter = Router();

// Received cost documents (přijaté nákladové doklady) live under /billing and are
// admin-only. Path-scoped so the gate never leaks to downstream pathless routers.
router.use("/billing/documents", requireRole("admin"));
router.use("/billing/approved-lines", requireRole("admin"));
router.use("/billing/ai-extraction", requireRole("admin"));
router.use("/billing/document-linking", requireRole("admin"));
router.use("/billing/review-queue", requireRole("admin"));

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
      const result = await ingestFile(
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
    });
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
      });
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
      const detail = await updateReference(id, referenceId, parsed.data);
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
      const detail = await deleteReference(id, referenceId);
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
  requireRole("admin"),
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
