import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  CreateQuoteBody,
  ConvertQuoteToJobBody,
  UpdateQuoteBody,
  SendQuoteEmailBody,
} from "@workspace/api-zod";
import { requirePermission } from "../middlewares/permissions";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { PublicOriginConfigError } from "../lib/public-origin";
import {
  PublicAccessTokenError,
  publicAccessTokenHttpStatus,
} from "../lib/public-access-token";
import {
  listQuotes,
  getQuoteDetail,
  createQuote,
  updateQuote,
  deleteQuote,
  sendQuote,
  acceptQuote,
  rejectQuote,
  expireQuote,
  convertQuoteToJob,
  generateAndStorePdf,
  getQuoteByShareToken,
  acceptQuoteByToken,
  rejectQuoteByToken,
  isValidToken,
  appError,
} from "../lib/quote-service";
import {
  listQuoteEvidence,
  reopenQuoteRevision,
} from "../lib/quote-version-service";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAppError(err: unknown): err is ReturnType<typeof appError> {
  return err instanceof Error && typeof (err as any).statusCode === "number";
}

function handleError(err: unknown, fallback: string, res: import("express").Response): void {
  if (err instanceof PublicAccessTokenError) {
    const status = publicAccessTokenHttpStatus(err);
    const message = err.code === "expired"
      ? "Platnost odkazu nabídky vypršela."
      : err.code === "consumed"
        ? "Tento odkaz nabídky již byl použit."
        : "Odkaz nabídky nebyl nalezen, byl zrušen nebo již není platný.";
    res.status(status).json({ error: message, code: `public_token_${err.code}` });
    return;
  }
  if (err instanceof PublicOriginConfigError) {
    res.status(503).json({
      error: "Veřejný odkaz nyní nelze bezpečně vytvořit.",
      code: "public_origin_unavailable",
    });
    return;
  }
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: fallback, code: "unexpected_error" });
}

// ---------------------------------------------------------------------------
// Public share-link routes (no auth — gated by token only)
// These MUST be declared before the requireRole("admin") middleware below.
// ---------------------------------------------------------------------------

router.get("/quotes/public/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token || !isValidToken(token)) {
    res.status(400).json({ error: "Neplatný token nabídky." });
    return;
  }
  try {
    const quote = await getQuoteByShareToken(token);
    if (!quote) {
      res.status(404).json({ error: "Nabídka nenalezena nebo odkaz vypršel." });
      return;
    }
    res.json(quote);
  } catch (err) {
    handleError(err, "Načtení nabídky selhalo.", res);
  }
});

router.post("/quotes/public/:token/accept", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token || !isValidToken(token)) {
    res.status(400).json({ error: "Neplatný token nabídky." });
    return;
  }
  const body = z.object({ respondentName: z.string().trim().min(2).max(120) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Uveďte jméno osoby, která o nabídce rozhoduje." });
    return;
  }
  try {
    const result = await acceptQuoteByToken(token, {
      respondentName: body.data.respondentName,
      userAgent: req.get("user-agent"),
    });
    res.json(result);
  } catch (err) {
    handleError(err, "Přijetí nabídky selhalo.", res);
  }
});

router.post("/quotes/public/:token/reject", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token || !isValidToken(token)) {
    res.status(400).json({ error: "Neplatný token nabídky." });
    return;
  }
  const body = z.object({ respondentName: z.string().trim().min(2).max(120) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Uveďte jméno osoby, která o nabídce rozhoduje." });
    return;
  }
  try {
    const result = await rejectQuoteByToken(token, {
      respondentName: body.data.respondentName,
      userAgent: req.get("user-agent"),
    });
    res.json(result);
  } catch (err) {
    handleError(err, "Odmítnutí nabídky selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// All remaining quote routes require effective module access.
// ---------------------------------------------------------------------------

router.use("/quotes", requirePermission("quotes.view"));

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get("/quotes", async (req, res): Promise<void> => {
  const customerIdRaw = req.query.customerId;
  const customerId =
    typeof customerIdRaw === "string" && customerIdRaw.length > 0
      ? Number(customerIdRaw)
      : undefined;
  const status =
    typeof req.query.status === "string" && req.query.status.length > 0
      ? req.query.status
      : undefined;
  try {
    const quotes = await listQuotes({
      customerId: customerId != null && Number.isFinite(customerId) ? customerId : undefined,
      status,
    });
    res.json(quotes);
  } catch (err) {
    handleError(err, "Načtení nabídek selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post("/quotes", async (req, res): Promise<void> => {
  const parsed = CreateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const quote = await createQuote({
      customerId: d.customerId ?? null,
      title: d.title,
      validUntil: d.validUntil ?? null,
      notes: d.notes ?? null,
      items: d.items?.map((i) => ({
        description: i.description,
        quantity: i.quantity ?? null,
        unit: i.unit ?? null,
        unitPrice: i.unitPrice ?? null,
        vatRate: i.vatRate ?? null,
        position: i.position ?? null,
      })),
    });
    res.status(201).json(quote);
  } catch (err) {
    handleError(err, "Vytvoření nabídky selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Get detail
// ---------------------------------------------------------------------------

router.get("/quotes/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const quote = await getQuoteDetail(id);
  if (!quote) {
    res.status(404).json({ error: "Nabídka nenalezena." });
    return;
  }
  res.json(quote);
});

// ---------------------------------------------------------------------------
// Update (draft only)
// ---------------------------------------------------------------------------

router.patch("/quotes/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const parsed = UpdateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const updated = await updateQuote(id, {
      customerId: d.customerId,
      title: d.title ?? undefined,
      validUntil: d.validUntil,
      notes: d.notes,
      items: d.items?.map((i) => ({
        description: i.description,
        quantity: i.quantity ?? null,
        unit: i.unit ?? null,
        unitPrice: i.unitPrice ?? null,
        vatRate: i.vatRate ?? null,
        position: i.position ?? null,
      })),
    });
    res.json(updated);
  } catch (err) {
    handleError(err, "Úprava nabídky selhala.", res);
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

router.delete("/quotes/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  try {
    await deleteQuote(id);
    res.status(204).end();
  } catch (err) {
    handleError(err, "Smazání nabídky selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Send (email + PDF + status → sent)
// ---------------------------------------------------------------------------

router.post("/quotes/:id/send", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const parsed = SendQuoteEmailBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await sendQuote(id, {
      to: parsed.data.to ?? null,
      subject: parsed.data.subject ?? null,
      message: parsed.data.message ?? null,
      createdByUserId: req.auth?.userId ?? null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "PDF nabídky nebylo nalezeno." });
      return;
    }
    req.log.error({ err, quoteId: id }, "Quote email failed");
    handleError(err, "Odeslání nabídky e-mailem selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Accept / reject / expire
// ---------------------------------------------------------------------------

router.post("/quotes/:id/accept", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  try {
    res.json(await acceptQuote(id, { userId: req.auth!.userId, name: req.auth!.name }));
  } catch (err) {
    handleError(err, "Přijetí nabídky selhalo.", res);
  }
});

router.post("/quotes/:id/reject", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  try {
    res.json(await rejectQuote(id, { userId: req.auth!.userId, name: req.auth!.name }));
  } catch (err) {
    handleError(err, "Odmítnutí nabídky selhalo.", res);
  }
});

router.post("/quotes/:id/expire", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  try {
    res.json(await expireQuote(id, { userId: req.auth!.userId, name: req.auth!.name }));
  } catch (err) {
    handleError(err, "Označení nabídky jako expirované selhalo.", res);
  }
});

router.post("/quotes/:id/revision", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Důvod opravy musí mít alespoň 3 znaky." });
    return;
  }
  try {
    const version = await reopenQuoteRevision({
      quoteId: id,
      reason: body.data.reason,
      actor: { userId: req.auth!.userId, name: req.auth!.name },
    });
    res.json({
      reopened: true,
      supersededVersion: version.version,
      snapshotSha256: version.snapshotSha256,
    });
  } catch (err) {
    handleError(err, "Založení opravené verze nabídky selhalo.", res);
  }
});

router.get("/quotes/:id/evidence", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const quote = await getQuoteDetail(id);
  if (!quote) {
    res.status(404).json({ error: "Nabídka nenalezena." });
    return;
  }
  const evidence = await listQuoteEvidence(id);
  res.json({
    versions: evidence.versions.map((version) => ({
      ...version,
      createdAt: version.createdAt.toISOString(),
    })),
    events: evidence.events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// Convert to job
// ---------------------------------------------------------------------------

router.post("/quotes/:id/convert-to-job", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const body = ConvertQuoteToJobBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    res.json(await convertQuoteToJob(
      id,
      {
        plannedDate: body.data.plannedDate
          ? body.data.plannedDate.toISOString().slice(0, 10)
          : null,
      },
      { userId: req.auth!.userId, name: req.auth!.name },
    ));
  } catch (err) {
    handleError(err, "Převod nabídky na zakázku selhal.", res);
  }
});

// ---------------------------------------------------------------------------
// Download PDF
// ---------------------------------------------------------------------------

router.get("/quotes/:id/pdf", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID nabídky." });
    return;
  }
  const quote = await getQuoteDetail(id);
  if (!quote) {
    res.status(404).json({ error: "Nabídka nenalezena." });
    return;
  }
  if (!quote.pdfObjectPath) {
    // Generate on the fly
    try {
      const { buffer } = await generateAndStorePdf(id);
      const number = (quote.quoteNumber ?? `${id}`).replace(/[^\w.-]+/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="nabidka-${number}.pdf"`);
      res.end(buffer);
      return;
    } catch (err) {
      handleError(err, "Generování PDF nabídky selhalo.", res);
      return;
    }
  }
  const number = (quote.quoteNumber ?? `${id}`).replace(/[^\w.-]+/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="nabidka-${number}.pdf"`);
  try {
    await objectStorage.servePrivateObject(quote.pdfObjectPath, res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "PDF nabídky nebylo nalezeno v úložišti." });
      return;
    }
    req.log.error({ err, quoteId: id }, "Quote PDF download failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Stažení PDF nabídky selhalo." });
    }
  }
});

export default router;
