import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  db,
  ppeItemsTable,
  ppeAssignmentsTable,
  ppeHandoverDocumentsTable,
  ppeHandoverEventsTable,
  peopleTable,
  type PpePublicEvidenceSnapshot,
} from "@workspace/db";
import { PPE_CATEGORIES, PPE_STATUSES } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { generatePpeHandoverPdf } from "../lib/ppe-handover-pdf";
import { z } from "zod/v4";
import { generatePpePdf, generatePpeCsv, type PpeExportRow } from "../lib/ppe-pdf";
import { ensureBillingSettings } from "../lib/invoice-service";
import { sendPlainEmail } from "../lib/email";
import { decodeSignatureImage } from "../lib/signature-image";
import { publicAppGrantUrl } from "../lib/public-origin";
import {
  PublicAccessTokenError,
  publicAccessTokenHttpStatus,
  publicTokenExpiry,
  revokePublicAccessTokens,
} from "../lib/public-access-token";
import {
  consumePpePublicEvidenceToken,
  issuePpePublicEvidenceToken,
  PpePublicEvidenceError,
  PPE_PUBLIC_SIGNATURE_CONFIRMATION_TEXT,
  resolvePpePublicEvidenceToken,
} from "../lib/ppe-public-evidence";
import {
  assertNoAuthorizationCredential,
  readPublicBearerOrLegacyToken,
  readPublicBearerToken,
  sendPublicBearerCredentialError,
} from "../lib/public-bearer-auth";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

const CONFIRMATION_TEXT_DEFAULT = PPE_PUBLIC_SIGNATURE_CONFIRMATION_TEXT;

function sendPublicTokenError(
  res: import("express").Response,
  error: PublicAccessTokenError,
  noun: string,
): void {
  const status = publicAccessTokenHttpStatus(error);
  const message = error.code === "expired"
    ? `Platnost odkazu pro ${noun} vypršela. Požádejte správce o nový odkaz.`
    : error.code === "consumed"
      ? `Tento odkaz pro ${noun} již byl použit.`
      : `Odkaz pro ${noun} nebyl nalezen, byl zrušen nebo již není platný.`;
  res.status(status).json({ error: message, code: `public_token_${error.code}` });
}

function sendPpePublicEvidenceError(
  res: import("express").Response,
  error: PpePublicEvidenceError,
  mode: "signature" | "confirmation",
): void {
  const status = error.code === "not_found" ? 404 : 409;
  const message = error.code === "not_found"
    ? "Výdej nebyl nalezen."
    : error.code === "closed"
      ? mode === "signature"
        ? "Výdej byl uzavřen a nelze ho již podepsat."
        : "Tato pomůcka již byla vrácena nebo uzavřena."
      : mode === "signature"
        ? "Výdej byl již podepsán."
        : "Výdej již byl potvrzen zaměstnancem.";
  res.status(status).json({ error: message });
}

function serializePublicEvidenceSnapshot(
  snapshot: PpePublicEvidenceSnapshot,
  employeeConfirmedAt: Date | null = null,
) {
  return {
    ...snapshot.assignment,
    confirmationText: snapshot.confirmationText,
    status: "issued",
    closed: false,
    alreadySigned: employeeConfirmedAt !== null,
    employeeConfirmedAt: employeeConfirmedAt?.toISOString() ?? null,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serializeHandoverDocument(
  doc: typeof ppeHandoverDocumentsTable.$inferSelect,
) {
  return {
    ...doc,
    signedAt: doc.signedAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
}

function serializeHandoverEvent(
  ev: typeof ppeHandoverEventsTable.$inferSelect,
) {
  return {
    ...ev,
    createdAt: ev.createdAt.toISOString(),
  };
}

function serializeAssignment(
  a: typeof ppeAssignmentsTable.$inferSelect,
  doc?: typeof ppeHandoverDocumentsTable.$inferSelect | null,
) {
  return {
    ...a,
    confirmToken: undefined,
    confirmTokenExpiresAt: undefined,
    signatureToken: undefined,
    signatureObjectPath: undefined,
    hasConfirmToken: !!a.confirmToken,
    hasSignature: !!a.signatureObjectPath,
    hasSignToken: !!a.signatureToken,
    employeeConfirmedAt: a.employeeConfirmedAt ? a.employeeConfirmedAt.toISOString() : null,
    confirmEmailSentAt: a.confirmEmailSentAt ? a.confirmEmailSentAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    handoverDocument: doc ? serializeHandoverDocument(doc) : null,
  };
}

function serializeItem(item: typeof ppeItemsTable.$inferSelect) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
  };
}

const PpeItemInputSchema = z.object({
  name: z.string().min(1, "Název je povinný"),
  category: z.enum(PPE_CATEGORIES as unknown as [string, ...string[]]).default("ostatni"),
  description: z.string().nullable().optional(),
  defaultReplacementMonths: z.number().int().positive().nullable().optional(),
  defaultInspectionMonths: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

const PpeAssignmentInputSchema = z.object({
  ppeItemId: z.number().int().positive("Pomůcka je povinná"),
  personId: z.number().int().positive("Zaměstnanec je povinný"),
  quantity: z.number().int().min(1, "Počet musí být alespoň 1"),
  size: z.string().nullable().optional(),
  serialNumber: z.string().nullable().optional(),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum výdeje musí být ve formátu YYYY-MM-DD"),
  replaceBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nextInspectionAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const PpeAssignmentUpdateSchema = z.object({
  status: z.enum(PPE_STATUSES as unknown as [string, ...string[]]).optional(),
  returnedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  replaceBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nextInspectionAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  size: z.string().nullable().optional(),
  serialNumber: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  quantity: z.number().int().min(1).optional(),
});

const PpeSignHandoverInputSchema = z.object({
  signatureDataUrl: z.string().min(1, "Podpis je povinný"),
  signatoryName: z.string().min(1, "Jméno podepisujícího je povinné"),
  confirmationText: z.string().optional(),
  confirmationAccepted: z.literal(true, { error: "Souhlas je povinný" }),
});

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Fetch all assignments with their handover documents via LEFT JOIN, applying
 * optional WHERE conditions. Returns serialized rows ready for the response.
 */
async function fetchAssignmentsWithDocs(conditions: Parameters<typeof and>[0][]) {
  const rows =
    conditions.length > 0
      ? await db
          .select()
          .from(ppeAssignmentsTable)
          .leftJoin(
            ppeHandoverDocumentsTable,
            eq(ppeHandoverDocumentsTable.assignmentId, ppeAssignmentsTable.id),
          )
          .where(and(...conditions))
          .orderBy(ppeAssignmentsTable.issuedAt)
      : await db
          .select()
          .from(ppeAssignmentsTable)
          .leftJoin(
            ppeHandoverDocumentsTable,
            eq(ppeHandoverDocumentsTable.assignmentId, ppeAssignmentsTable.id),
          )
          .orderBy(ppeAssignmentsTable.issuedAt);
  return rows.map((r) => serializeAssignment(r.ppe_assignments, r.ppe_handover_documents));
}

// ── PPE Items ─────────────────────────────────────────────────────────────────

router.get("/ppe/items", async (req, res): Promise<void> => {
  const includeArchived = req.query.includeArchived === "true";
  const items = includeArchived
    ? await db.select().from(ppeItemsTable).orderBy(ppeItemsTable.name)
    : await db.select().from(ppeItemsTable).where(eq(ppeItemsTable.active, true)).orderBy(ppeItemsTable.name);
  res.json(items.map(serializeItem));
});

router.post("/ppe/items", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const parsed = PpeItemInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const [item] = await db.insert(ppeItemsTable).values(parsed.data).returning();
  res.status(201).json(serializeItem(item));
});

router.patch("/ppe/items/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const parsed = PpeItemInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const [item] = await db.update(ppeItemsTable).set(parsed.data).where(eq(ppeItemsTable.id, params.data.id)).returning();
  if (!item) {
    res.status(404).json({ error: "Pomůcka nenalezena" });
    return;
  }
  res.json(serializeItem(item));
});

router.delete("/ppe/items/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }

  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(ppeAssignmentsTable)
    .where(and(eq(ppeAssignmentsTable.ppeItemId, params.data.id), eq(ppeAssignmentsTable.status, "issued")));
  if (activeCount > 0) {
    res.status(409).json({
      error: `Pomůcka má ${activeCount} aktivní ${activeCount === 1 ? "výdej" : activeCount < 5 ? "výdeje" : "výdejů"} – nelze ji archivovat. Nejdříve vraťte všechny aktivní výdeje.`,
    });
    return;
  }

  const [item] = await db
    .update(ppeItemsTable)
    .set({ active: false })
    .where(eq(ppeItemsTable.id, params.data.id))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Pomůcka nenalezena" });
    return;
  }
  res.json(serializeItem(item));
});

// ── PPE Assignments ───────────────────────────────────────────────────────────

router.get("/ppe/assignments", async (req, res): Promise<void> => {
  const todayStr = today();
  const conditions: Parameters<typeof and>[0][] = [];

  const personId = req.query.personId ? Number(req.query.personId) : null;
  if (personId && Number.isFinite(personId)) {
    conditions.push(eq(ppeAssignmentsTable.personId, personId));
  }

  const status = req.query.status as string | undefined;
  if (status && PPE_STATUSES.includes(status as (typeof PPE_STATUSES)[number])) {
    conditions.push(eq(ppeAssignmentsTable.status, status));
  }

  if (req.query.overdue === "true") {
    conditions.push(
      and(
        eq(ppeAssignmentsTable.status, "issued"),
        or(
          and(isNotNull(ppeAssignmentsTable.replaceBy), lte(ppeAssignmentsTable.replaceBy, todayStr)),
          and(isNotNull(ppeAssignmentsTable.nextInspectionAt), lte(ppeAssignmentsTable.nextInspectionAt, todayStr)),
        ),
      )!,
    );
  }

  const assignments = await fetchAssignmentsWithDocs(conditions);
  res.json(assignments);
});

// ─────────── Public sign endpoints (no auth required — gated by token) ───────────

router.post("/ppe/assignments/:id/sign-token", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }

  const expiresAt = publicTokenExpiry("PPE_SIGNATURE_EXPIRY_DAYS", 30);
  let token: string;
  try {
    ({ token } = await issuePpePublicEvidenceToken({
      purpose: "ppe_signature",
      assignmentId: params.data.id,
      expiresAt,
      createdByUserId: req.auth!.userId,
    }));
  } catch (error) {
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "signature");
      return;
    }
    throw error;
  }

  res.json({
    signUrl: publicAppGrantUrl("/oopp/sign", token),
    expiresAt: expiresAt.toISOString(),
  });
});

router.delete("/ppe/assignments/:id/sign-token", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }

  const [existing] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }

  await db.transaction(async (tx) => {
    await revokePublicAccessTokens({
      purpose: "ppe_signature",
      resourceId: existing.id,
      revokedByUserId: req.auth?.userId ?? null,
      reason: "manual_revoke",
    }, tx);
    await tx
      .update(ppeAssignmentsTable)
      .set({ signatureToken: null })
      .where(eq(ppeAssignmentsTable.id, existing.id));
  });

  res.status(204).end();
});

function ppeSignatureToken(
  req: Request,
  res: Response,
  legacyToken?: string,
): string | null {
  try {
    if (legacyToken !== undefined) {
      assertNoAuthorizationCredential(req);
      return legacyToken;
    }
    return readPublicBearerToken(req);
  } catch (error) {
    if (sendPublicBearerCredentialError(res, error)) return null;
    throw error;
  }
}

// Public: fetch assignment info for signing (by token)
async function getPublicPpeSignature(
  req: Request,
  res: Response,
  token: string,
): Promise<void> {
  try {
    const { snapshot } = await resolvePpePublicEvidenceToken(
      "ppe_signature",
      token,
    );
    res.json(serializePublicEvidenceSnapshot(snapshot));
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendPublicTokenError(res, error, "podpis");
      return;
    }
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "signature");
      return;
    }
    throw error;
  }
}

// Public: submit signature PNG (base64) — sets employeeConfirmedAt + uploads to storage
async function postPublicPpeSignature(
  req: Request,
  res: Response,
  token: string,
): Promise<void> {
  const body = z.object({
    signatureDataUrl: z.string().startsWith("data:image/png;base64,"),
  }).safeParse(req.body);

  if (!body.success) {
    res.status(400).json({ error: "Chybí nebo je neplatný podpis (očekáváno PNG base64 data URL)" });
    return;
  }

  let snapshot: PpePublicEvidenceSnapshot;
  try {
    ({ snapshot } = await resolvePpePublicEvidenceToken(
      "ppe_signature",
      token,
    ));
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendPublicTokenError(res, error, "podpis");
      return;
    }
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "signature");
      return;
    }
    throw error;
  }

  let pngBuffer: Buffer;
  try {
    ({ pngBuffer } = await decodeSignatureImage(body.data.signatureDataUrl));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Podpis není platný PNG obrázek.",
    });
    return;
  }

  const objectPath = `/objects/ppe-signatures/${snapshot.assignment.id}-${randomUUID()}.png`;
  let uploaded = false;
  try {
    await objectStorage.putPrivateObject(objectPath, pngBuffer, "image/png");
    uploaded = true;
  } catch (err) {
    req.log?.error({ err }, "PPE signature upload failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis" });
    return;
  }

  try {
    const consumed = await consumePpePublicEvidenceToken({
      purpose: "ppe_signature",
      token,
      action: "signed",
      signatureObjectPath: objectPath,
      signatureSha256: createHash("sha256").update(pngBuffer).digest("hex"),
    });

    res.json({
      ok: true,
      employeeConfirmedAt: consumed.confirmedAt.toISOString(),
      personNameSnapshot: consumed.snapshot.assignment.personNameSnapshot,
      ppeNameSnapshot: consumed.snapshot.assignment.ppeNameSnapshot,
    });
  } catch (err) {
    // Clean up the uploaded signature PNG if we could not commit
    if (uploaded) {
      objectStorage.deletePrivateObject(objectPath).catch(() => undefined);
    }

    if (err instanceof PublicAccessTokenError) {
      sendPublicTokenError(res, err, "podpis");
      return;
    }
    if (err instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, err, "signature");
      return;
    }
    req.log?.error({ err }, "PPE signature save failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis" });
  }
}

router.get("/ppe/sign", async (req, res): Promise<void> => {
  const token = ppeSignatureToken(req, res);
  if (token) await getPublicPpeSignature(req, res, token);
});

router.get("/ppe/sign/:token", async (req, res): Promise<void> => {
  const token = ppeSignatureToken(req, res, req.params.token);
  if (token) await getPublicPpeSignature(req, res, token);
});

router.post("/ppe/sign", async (req, res): Promise<void> => {
  const token = ppeSignatureToken(req, res);
  if (token) await postPublicPpeSignature(req, res, token);
});

router.post("/ppe/sign/:token", async (req, res): Promise<void> => {
  const token = ppeSignatureToken(req, res, req.params.token);
  if (token) await postPublicPpeSignature(req, res, token);
});

// ─────────── Export ───────────

router.get("/ppe/assignments/export", async (req, res): Promise<void> => {
  const format = req.query.format === "csv" ? "csv" : "pdf";
  const conditions = [];

  const personId = req.query.personId ? Number(req.query.personId) : null;
  if (personId && Number.isFinite(personId)) {
    conditions.push(eq(ppeAssignmentsTable.personId, personId));
  }

  const status = req.query.status as string | undefined;
  if (status && PPE_STATUSES.includes(status as (typeof PPE_STATUSES)[number])) {
    conditions.push(eq(ppeAssignmentsTable.status, status));
  }

  const issuedFrom = req.query.issuedFrom as string | undefined;
  const validIssuedFrom = issuedFrom && /^\d{4}-\d{2}-\d{2}$/.test(issuedFrom) ? issuedFrom : undefined;

  const issuedTo = req.query.issuedTo as string | undefined;
  const validIssuedTo = issuedTo && /^\d{4}-\d{2}-\d{2}$/.test(issuedTo) ? issuedTo : undefined;

  if (validIssuedFrom || validIssuedTo) {
    const excludeNoDate = req.query.excludeNoDate === "true";
    const dateParts = [
      ...(validIssuedFrom ? [gte(ppeAssignmentsTable.issuedAt, validIssuedFrom)] : []),
      ...(validIssuedTo ? [lte(ppeAssignmentsTable.issuedAt, validIssuedTo)] : []),
    ];
    const dateCondition = dateParts.length === 1 ? dateParts[0] : and(...dateParts)!;
    if (excludeNoDate) {
      conditions.push(and(isNotNull(ppeAssignmentsTable.issuedAt), dateCondition)!);
    } else {
      conditions.push(or(isNull(ppeAssignmentsTable.issuedAt), dateCondition)!);
    }
  }

  if (req.query.overdue === "true") {
    const todayStr = today();
    conditions.push(
      and(
        eq(ppeAssignmentsTable.status, "issued"),
        or(
          and(isNotNull(ppeAssignmentsTable.replaceBy), lte(ppeAssignmentsTable.replaceBy, todayStr)),
          and(isNotNull(ppeAssignmentsTable.nextInspectionAt), lte(ppeAssignmentsTable.nextInspectionAt, todayStr)),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      personNameSnapshot: ppeAssignmentsTable.personNameSnapshot,
      ppeNameSnapshot: ppeAssignmentsTable.ppeNameSnapshot,
      category: ppeItemsTable.category,
      quantity: ppeAssignmentsTable.quantity,
      size: ppeAssignmentsTable.size,
      serialNumber: ppeAssignmentsTable.serialNumber,
      issuedAt: ppeAssignmentsTable.issuedAt,
      replaceBy: ppeAssignmentsTable.replaceBy,
      returnedAt: ppeAssignmentsTable.returnedAt,
      status: ppeAssignmentsTable.status,
      employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt,
      signatureObjectPath: ppeAssignmentsTable.signatureObjectPath,
    })
    .from(ppeAssignmentsTable)
    .innerJoin(ppeItemsTable, eq(ppeAssignmentsTable.ppeItemId, ppeItemsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(ppeAssignmentsTable.issuedAt, ppeAssignmentsTable.personNameSnapshot);

  // Fetch signature images for signed rows (PDF only)
  const signatureBuffers = new Map<string, Buffer>();
  if (format === "pdf") {
    await Promise.allSettled(
      rows
        .filter((r) => r.signatureObjectPath)
        .map(async (r) => {
          try {
            const buf = await objectStorage.getPrivateObjectBuffer(r.signatureObjectPath!);
            signatureBuffers.set(r.signatureObjectPath!, buf);
          } catch {
            // non-fatal — missing signature just won't be shown in PDF
          }
        }),
    );
  }

  const exportRows: PpeExportRow[] = rows.map((r) => ({
    personNameSnapshot: r.personNameSnapshot,
    ppeNameSnapshot: r.ppeNameSnapshot,
    category: r.category,
    quantity: r.quantity,
    size: r.size,
    serialNumber: r.serialNumber,
    issuedAt: r.issuedAt,
    replaceBy: r.replaceBy,
    returnedAt: r.returnedAt,
    status: r.status,
    employeeConfirmedAt: r.employeeConfirmedAt ? r.employeeConfirmedAt.toISOString() : null,
    signatureBuffer: r.signatureObjectPath ? (signatureBuffers.get(r.signatureObjectPath) ?? null) : null,
  }));

  const todaySlug = today();

  if (format === "csv") {
    const csv = generatePpeCsv(exportRows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="oopp-vydeje-${todaySlug}.csv"`);
    res.send(csv);
    return;
  }

  let companyName: string | undefined;
  try {
    const settings = await ensureBillingSettings();
    companyName = settings.supplierName ?? undefined;
  } catch {
    // non-fatal — branding is optional
  }

  const pdfBuffer = generatePpePdf(exportRows, companyName);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="oopp-vydeje-${todaySlug}.pdf"`);
  res.send(pdfBuffer);
});

router.post("/ppe/assignments", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const parsed = PpeAssignmentInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const [ppeItem] = await db.select().from(ppeItemsTable).where(eq(ppeItemsTable.id, parsed.data.ppeItemId));
  if (!ppeItem) {
    res.status(400).json({ error: "Pomůcka nenalezena" });
    return;
  }
  if (!ppeItem.active) {
    res.status(400).json({ error: "Archivovanou pomůcku nelze vydat" });
    return;
  }

  const [person] = await db.select().from(peopleTable).where(eq(peopleTable.id, parsed.data.personId));
  if (!person) {
    res.status(400).json({ error: "Zaměstnanec nenalezen" });
    return;
  }

  const [assignment] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ...parsed.data,
      replaceBy: parsed.data.replaceBy ?? null,
      nextInspectionAt: parsed.data.nextInspectionAt ?? null,
      ppeNameSnapshot: ppeItem.name,
      personNameSnapshot: person.name,
      ppeCategorySnapshot: ppeItem.category ?? null,
      ppeRiskDescriptionSnapshot: ppeItem.description ?? null,
      ppeStandardSnapshot: null,
      ppeProtectionClassSnapshot: null,
      status: "issued",
    })
    .returning();

  res.status(201).json(serializeAssignment(assignment, null));
});

router.delete("/ppe/assignments/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [existing] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  if (existing.employeeConfirmedAt) {
    res.status(409).json({ error: "Podepsaný výdej nelze smazat" });
    return;
  }
  await db.delete(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  res.status(204).end();
});

router.patch("/ppe/assignments/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const parsed = PpeAssignmentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const [existing] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }

  if (existing.employeeConfirmedAt) {
    const { status, returnedAt, ...rest } = parsed.data;
    if (Object.keys(rest).length > 0) {
      res.status(409).json({ error: "Podepsaný výdej lze měnit jen ve stavu a datu vrácení" });
      return;
    }
  }

  const updates: Partial<typeof ppeAssignmentsTable.$inferInsert> = { ...parsed.data };

  if (Object.keys(updates).length === 0) {
    res.json(serializeAssignment(existing));
    return;
  }

  const [updated] = await db
    .update(ppeAssignmentsTable)
    .set(updates)
    .where(eq(ppeAssignmentsTable.id, params.data.id))
    .returning();

  // Fetch the handover document if it exists
  const [doc] = await db
    .select()
    .from(ppeHandoverDocumentsTable)
    .where(eq(ppeHandoverDocumentsTable.assignmentId, params.data.id));

  res.json(serializeAssignment(updated, doc ?? null));
});

// ── PPE Handover: Sign ────────────────────────────────────────────────────────

router.post("/ppe/assignments/:id/sign", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const parsed = PpeSignHandoverInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  let pngBuffer: Buffer;
  let dataUrl: string;
  try {
    ({ pngBuffer, dataUrl } = await decodeSignatureImage(parsed.data.signatureDataUrl));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Podpis není platný PNG obrázek.",
    });
    return;
  }

  // Load assignment
  const [assignment] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!assignment) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  if (assignment.employeeConfirmedAt) {
    res.status(409).json({ error: "Výdej již byl podepsán" });
    return;
  }
  if (assignment.status !== "issued") {
    res.status(409).json({ error: "Podpis lze přidat pouze na aktivní výdej" });
    return;
  }

  const signedAt = new Date();
  const year = signedAt.getFullYear();
  const confirmationText = parsed.data.confirmationText ?? CONFIRMATION_TEXT_DEFAULT;
  const signatoryName = parsed.data.signatoryName;
  const issuerSnapshot = req.auth?.name ?? req.auth?.username ?? "Systém";

  // SHA-256 of the PNG
  const pngSha256 = createHash("sha256").update(pngBuffer).digest("hex");

  // Upload PNG
  const pngObjectPath = `/objects/ppe-handovers/${randomUUID()}.png`;
  let pngUploaded = false;
  let pdfObjectPath = `/objects/ppe-handovers/${randomUUID()}.pdf`;
  let pdfUploaded = false;

  try {
    // Fetch company/person info for PDF (outside the transaction to avoid holding the lock during I/O)
    const [person] = await db.select().from(peopleTable).where(eq(peopleTable.id, assignment.personId));
    const companyName = "Modvolt s.r.o.";

    // Generate placeholder PDF buffer before the transaction (pure computation — no storage I/O yet)
    const pdfBuffer = generatePpeHandoverPdf({
      documentNumber: "OOPP-PENDING",
      companyName,
      employeeName: assignment.personNameSnapshot,
      signatoryName,
      signedAt,
      issuerSnapshot,
      confirmationText,
      signatureDataUrl: dataUrl,
      signatureSha256: pngSha256,
      ppeNameSnapshot: assignment.ppeNameSnapshot,
      ppeCategorySnapshot: assignment.ppeCategorySnapshot,
      ppeStandardSnapshot: assignment.ppeStandardSnapshot,
      ppeProtectionClassSnapshot: assignment.ppeProtectionClassSnapshot,
      ppeRiskDescriptionSnapshot: assignment.ppeRiskDescriptionSnapshot,
      quantity: assignment.quantity,
      size: assignment.size,
      serialNumber: assignment.serialNumber,
      issuedAt: assignment.issuedAt,
      replaceBy: assignment.replaceBy,
      nextInspectionAt: assignment.nextInspectionAt,
    });

    const pdfSha256 = createHash("sha256").update(pdfBuffer).digest("hex");

    // Atomic DB transaction — uploads happen AFTER the FOR UPDATE re-check so that the
    // loser of a concurrent race never writes to object storage at all.
    const handoverDoc = await db.transaction(async (tx) => {
      // Lock the assignment row to serialize concurrent sign attempts
      const [recheck] = await tx
        .select()
        .from(ppeAssignmentsTable)
        .where(eq(ppeAssignmentsTable.id, params.data.id))
        .for("update");
      if (recheck?.employeeConfirmedAt) {
        throw new Error("ALREADY_SIGNED");
      }

      // Upload PNG and placeholder PDF only after the slot is confirmed free —
      // the loser of a race never reaches this point.
      await objectStorage.putPrivateObject(pngObjectPath, pngBuffer, "image/png");
      pngUploaded = true;
      await objectStorage.putPrivateObject(pdfObjectPath, pdfBuffer, "application/pdf");
      pdfUploaded = true;

      // Insert handover document with placeholder number
      const [doc] = await tx
        .insert(ppeHandoverDocumentsTable)
        .values({
          assignmentId: params.data.id,
          version: 1,
          documentNumber: "OOPP-PENDING",
          signatoryName,
          signedAt,
          confirmationText,
          pngObjectPath,
          pngSha256,
          pdfObjectPath,
          pdfSha256,
          issuerSnapshot,
        })
        .returning();

      // Update document number using the new ID
      const documentNumber = `OOPP-${year}-${String(doc.id).padStart(6, "0")}`;
      const [finalDoc] = await tx
        .update(ppeHandoverDocumentsTable)
        .set({ documentNumber })
        .where(eq(ppeHandoverDocumentsTable.id, doc.id))
        .returning();

      // Regenerate PDF with the real document number
      const realPdfBuffer = generatePpeHandoverPdf({
        documentNumber,
        companyName,
        employeeName: assignment.personNameSnapshot,
        signatoryName,
        signedAt,
        issuerSnapshot,
        confirmationText,
        signatureDataUrl: dataUrl,
        signatureSha256: pngSha256,
        ppeNameSnapshot: assignment.ppeNameSnapshot,
        ppeCategorySnapshot: assignment.ppeCategorySnapshot,
        ppeStandardSnapshot: assignment.ppeStandardSnapshot,
        ppeProtectionClassSnapshot: assignment.ppeProtectionClassSnapshot,
        ppeRiskDescriptionSnapshot: assignment.ppeRiskDescriptionSnapshot,
        quantity: assignment.quantity,
        size: assignment.size,
        serialNumber: assignment.serialNumber,
        issuedAt: assignment.issuedAt,
        replaceBy: assignment.replaceBy,
        nextInspectionAt: assignment.nextInspectionAt,
      });
      const realPdfSha256 = createHash("sha256").update(realPdfBuffer).digest("hex");

      // Upload final PDF (overwrite the same path)
      await objectStorage.putPrivateObject(pdfObjectPath, realPdfBuffer, "application/pdf");

      // Update PDF SHA
      const [docWithRealSha] = await tx
        .update(ppeHandoverDocumentsTable)
        .set({ pdfSha256: realPdfSha256 })
        .where(eq(ppeHandoverDocumentsTable.id, doc.id))
        .returning();

      // Set employeeConfirmedAt on the assignment
      await tx
        .update(ppeAssignmentsTable)
        .set({ employeeConfirmedAt: signedAt })
        .where(eq(ppeAssignmentsTable.id, params.data.id));

      // Record signed event
      await tx.insert(ppeHandoverEventsTable).values({
        assignmentId: params.data.id,
        handoverDocumentId: doc.id,
        eventType: "signed",
        actorUserId: req.auth?.userId ?? null,
        actorName: issuerSnapshot,
      });

      return docWithRealSha ?? finalDoc;
    });

    res.status(201).json(serializeHandoverDocument(handoverDoc));
  } catch (err) {
    // Clean up uploaded objects if transaction failed
    if (pngUploaded) {
      objectStorage.deletePrivateObject(pngObjectPath).catch((cleanupErr: unknown) => {
        req.log.warn({ err: cleanupErr, path: pngObjectPath }, "Failed to delete orphaned PNG after sign rollback");
      });
    }
    if (pdfUploaded) {
      objectStorage.deletePrivateObject(pdfObjectPath).catch((cleanupErr: unknown) => {
        req.log.warn({ err: cleanupErr, path: pdfObjectPath }, "Failed to delete orphaned PDF after sign rollback");
      });
    }

    if (err instanceof Error && err.message === "ALREADY_SIGNED") {
      res.status(409).json({ error: "Výdej již byl podepsán" });
      return;
    }
    if (typeof err === "object" && err !== null && (err as Record<string, unknown>).code === "23505") {
      res.status(409).json({ error: "Protokol předání pro tento výdej již existuje" });
      return;
    }
    req.log.error({ err }, "Error signing PPE handover");
    res.status(500).json({ error: "Nepodařilo se vytvořit protokol o předání" });
  }
});

// ── PPE Handover: Download PDF ────────────────────────────────────────────────

router.get("/ppe/assignments/:id/handover-pdf", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [assignment] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!assignment) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  const [doc] = await db
    .select()
    .from(ppeHandoverDocumentsTable)
    .where(eq(ppeHandoverDocumentsTable.assignmentId, params.data.id));
  if (!doc) {
    res.status(404).json({ error: "Protokol nenalezen" });
    return;
  }
  // Record audit event (fire-and-forget, non-blocking)
  db.insert(ppeHandoverEventsTable)
    .values({
      assignmentId: params.data.id,
      handoverDocumentId: doc.id,
      eventType: "pdf_downloaded",
      actorUserId: req.auth?.userId ?? null,
      actorName: req.auth?.name ?? req.auth?.username ?? null,
    })
    .catch(() => undefined);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="protokol-oopp-${doc.documentNumber}.pdf"`,
  );
  try {
    await objectStorage.servePrivateObject(doc.pdfObjectPath, res);
  } catch {
    if (!res.headersSent) {
      res.status(404).json({ error: "Soubor nenalezen" });
    }
  }
});

// ── PPE Handover: Download Signature PNG ──────────────────────────────────────

router.get("/ppe/assignments/:id/signature", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [assignment] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!assignment) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  const [doc] = await db
    .select()
    .from(ppeHandoverDocumentsTable)
    .where(eq(ppeHandoverDocumentsTable.assignmentId, params.data.id));
  const signatureObjectPath = doc?.pngObjectPath ?? assignment.signatureObjectPath;
  if (!signatureObjectPath) {
    res.status(404).json({ error: "Podpis nenalezen" });
    return;
  }
  try {
    const signature = await objectStorage.getPrivateObjectBuffer(signatureObjectPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="podpis-${doc?.documentNumber ?? assignment.id}.png"`,
    );
    res.send(signature);
    db.insert(ppeHandoverEventsTable)
      .values({
        assignmentId: params.data.id,
        handoverDocumentId: doc?.id ?? null,
        eventType: "signature_viewed",
        actorUserId: req.auth?.userId ?? null,
        actorName: req.auth?.name ?? req.auth?.username ?? null,
      })
      .catch(() => undefined);
  } catch {
    res.status(404).json({ error: "Soubor nenalezen" });
  }
});

// ── PPE Handover: Events ──────────────────────────────────────────────────────

router.get("/ppe/assignments/:id/events", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [assignment] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!assignment) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  const events = await db
    .select()
    .from(ppeHandoverEventsTable)
    .where(eq(ppeHandoverEventsTable.assignmentId, params.data.id))
    .orderBy(ppeHandoverEventsTable.createdAt);
  res.json(events.map(serializeHandoverEvent));
});

router.post("/ppe/assignments/:id/request-confirm", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }

  const expiresAt = publicTokenExpiry("PPE_CONFIRM_EXPIRY_DAYS", 30);
  let issued;
  try {
    issued = await issuePpePublicEvidenceToken({
      purpose: "ppe_confirmation",
      assignmentId: params.data.id,
      expiresAt,
      createdByUserId: req.auth!.userId,
    });
  } catch (error) {
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "confirmation");
      return;
    }
    throw error;
  }
  const { token, assignment: existing, snapshot } = issued;
  const confirmUrl = publicAppGrantUrl("/oopp/potvrdit", token);

  const [person] = await db.select().from(peopleTable).where(eq(peopleTable.id, existing.personId));
  let emailSent = false;

  if (person?.email) {
    try {
      await sendPlainEmail({
        to: person.email,
        subject: `Potvrzení převzetí OOPP – ${snapshot.assignment.ppeNameSnapshot}`,
        text:
          `Dobrý den ${snapshot.assignment.personNameSnapshot},\n\n` +
          `Prosíme potvrďte převzetí ochranné pomůcky: ${snapshot.assignment.ppeNameSnapshot}.\n\n` +
          `Pro potvrzení klikněte na odkaz:\n${confirmUrl}\n\n` +
          `Pokud jste pomůcku nepřevzali, tuto zprávu ignorujte.\n`,
      });
      await db
        .update(ppeAssignmentsTable)
        .set({ confirmEmailSentAt: new Date() })
        .where(eq(ppeAssignmentsTable.id, params.data.id));
      emailSent = true;
    } catch (err) {
      req.log.warn({ err }, "Failed to send PPE confirmation email");
    }
  }

  res.json({ confirmUrl, expiresAt: expiresAt.toISOString(), emailSent });
});

function ppeConfirmationToken(
  req: Request,
  res: Response,
  legacyToken: unknown,
): string | null {
  try {
    return readPublicBearerOrLegacyToken(req, legacyToken);
  } catch (error) {
    if (sendPublicBearerCredentialError(res, error)) return null;
    throw error;
  }
}

async function postPublicPpeConfirmation(
  res: Response,
  token: string,
): Promise<void> {
  try {
    const consumed = await consumePpePublicEvidenceToken({
      purpose: "ppe_confirmation",
      token,
      action: "confirmed",
    });
    res.json({
      already: false,
      assignment: serializePublicEvidenceSnapshot(
        consumed.snapshot,
        consumed.confirmedAt,
      ),
    });
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendPublicTokenError(res, error, "potvrzení");
      return;
    }
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "confirmation");
      return;
    }
    throw error;
  }
}

async function getPublicPpeConfirmation(
  res: Response,
  token: string,
): Promise<void> {
  try {
    const { snapshot } = await resolvePpePublicEvidenceToken(
      "ppe_confirmation",
      token,
    );
    res.json(serializePublicEvidenceSnapshot(snapshot));
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendPublicTokenError(res, error, "potvrzení");
      return;
    }
    if (error instanceof PpePublicEvidenceError) {
      sendPpePublicEvidenceError(res, error, "confirmation");
      return;
    }
    throw error;
  }
}

router.post("/ppe/confirm", async (req, res): Promise<void> => {
  const body = req.body && typeof req.body === "object"
    ? req.body as Record<string, unknown>
    : {};
  const token = ppeConfirmationToken(req, res, body.token);
  if (token) await postPublicPpeConfirmation(res, token);
});

router.get("/ppe/confirm", async (req, res): Promise<void> => {
  const token = ppeConfirmationToken(req, res, req.query.token);
  if (token) await getPublicPpeConfirmation(res, token);
});

export default router;
