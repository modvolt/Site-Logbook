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
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { contentMatchesType } from "../lib/fileSignature";
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
  type AppError,
  type Actor,
} from "../lib/cost-document-service";
import {
  getOpenAiConfig,
  testConfiguration as testAiConfiguration,
} from "../lib/openai-extraction";

const router: IRouter = Router();

// Received cost documents (přijaté nákladové doklady) live under /billing and are
// admin-only. Path-scoped so the gate never leaks to downstream pathless routers.
router.use("/billing/documents", requireRole("admin"));
router.use("/billing/approved-lines", requireRole("admin"));
router.use("/billing/ai-extraction", requireRole("admin"));

// --- AI extraction (OpenAI) — optional, admin-only status + connectivity test ---

router.get("/billing/ai-extraction", (_req, res): void => {
  const cfg = getOpenAiConfig();
  res.json({
    configured: cfg.configured,
    enabled: cfg.enabled,
    ready: cfg.ready,
    model: cfg.model,
    maxFileMb: cfg.maxFileMb,
  });
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

// Same hard cap as the generic upload route (see routes/storage.ts). Keep nginx's
// client_max_body_size at/above this or large files are rejected at the proxy.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Content types accepted for cost documents. Broader than the generic uploader:
// also allows ISDOC/XML (machine-parsable) and its zipped .isdocx container.
const ALLOWED_UPLOAD_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/xml",
  "text/xml",
  "application/zip",
  "text/plain",
  "text/csv",
]);

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
    try {
      const detail = await updateLine(id, lineId, {
        lineType: d.lineType,
        description: d.description,
        quantity: d.quantity,
        unit: d.unit,
        unitPriceWithoutVat: d.unitPriceWithoutVat,
        vatRate: d.vatRate,
        jobId: d.jobId,
        allocationType: d.allocationType,
        matchConfirmed: d.matchConfirmed,
        approved: d.approved,
      });
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
          allocationType: p.allocationType,
        })),
      );
      res.json(detail);
    } catch (error) {
      handleError(error, "Položku se nepodařilo rozdělit.", res);
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
