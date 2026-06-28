import { Router, type IRouter } from "express";
import { and, count, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  db,
  ppeItemsTable,
  ppeAssignmentsTable,
  ppeHandoverDocumentsTable,
  ppeHandoverEventsTable,
  peopleTable,
} from "@workspace/db";
import { PPE_CATEGORIES, PPE_STATUSES } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { generatePpeHandoverPdf } from "../lib/ppe-handover-pdf";
import { z } from "zod/v4";
import { generatePpePdf, generatePpeCsv, type PpeExportRow } from "../lib/ppe-pdf";
import { ensureBillingSettings } from "../lib/invoice-service";
import { sendPlainEmail } from "../lib/email";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGNATURE_BYTES = 500 * 1024;

const CONFIRMATION_TEXT_DEFAULT =
  "Svým podpisem potvrzuji, že jsem převzal/a výše uvedené ochranné pracovní pomůcky (OOPP). " +
  "Zavazuji se je používat v souladu s pokyny výrobce a zaměstnavatele a chránit je před poškozením.";

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

  const [existing] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }

  let token = existing.signatureToken;
  if (!token) {
    token = randomUUID();
    await db.update(ppeAssignmentsTable).set({ signatureToken: token }).where(eq(ppeAssignmentsTable.id, params.data.id));
  }

  res.json({ token, signUrl: `/oopp/sign/${token}` });
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

  await db.update(ppeAssignmentsTable).set({ signatureToken: null }).where(eq(ppeAssignmentsTable.id, params.data.id));

  res.status(204).end();
});

// Public: fetch assignment info for signing (by token)
router.get("/ppe/sign/:token", async (req, res): Promise<void> => {
  const token = req.params.token;
  if (!token || !/^[0-9a-f-]{36}$/.test(token)) {
    res.status(400).json({ error: "Neplatný token" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.signatureToken, token));

  if (!assignment) {
    res.status(404).json({ error: "Odkaz pro podpis nebyl nalezen nebo vypršel" });
    return;
  }

  res.json({
    id: assignment.id,
    ppeNameSnapshot: assignment.ppeNameSnapshot,
    personNameSnapshot: assignment.personNameSnapshot,
    quantity: assignment.quantity,
    size: assignment.size,
    serialNumber: assignment.serialNumber,
    issuedAt: assignment.issuedAt,
    status: assignment.status,
    closed: assignment.status !== "issued",
    alreadySigned: !!assignment.employeeConfirmedAt,
    employeeConfirmedAt: assignment.employeeConfirmedAt ? assignment.employeeConfirmedAt.toISOString() : null,
  });
});

// Public: submit signature PNG (base64) — sets employeeConfirmedAt + uploads to storage
router.post("/ppe/sign/:token", async (req, res): Promise<void> => {
  const token = req.params.token;
  if (!token || !/^[0-9a-f-]{36}$/.test(token)) {
    res.status(400).json({ error: "Neplatný token" });
    return;
  }

  const body = z.object({
    signatureDataUrl: z.string().startsWith("data:image/png;base64,"),
  }).safeParse(req.body);

  if (!body.success) {
    res.status(400).json({ error: "Chybí nebo je neplatný podpis (očekáváno PNG base64 data URL)" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.signatureToken, token));

  if (!assignment) {
    res.status(404).json({ error: "Odkaz pro podpis nebyl nalezen" });
    return;
  }

  if (assignment.status !== "issued") {
    res.status(409).json({ error: "Výdej byl uzavřen a nelze ho již podepsat" });
    return;
  }

  if (assignment.employeeConfirmedAt) {
    res.status(409).json({ error: "Výdej byl již podepsán" });
    return;
  }

  const base64Data = body.data.signatureDataUrl.replace(/^data:image\/png;base64,/, "");
  const pngBuffer = Buffer.from(base64Data, "base64");

  const objectPath = `/objects/ppe-signatures/${assignment.id}-${token}.png`;
  try {
    await objectStorage.putPrivateObject(objectPath, pngBuffer, "image/png");
  } catch (err) {
    req.log?.error({ err }, "PPE signature upload failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis" });
    return;
  }

  const confirmedAt = new Date();
  await db
    .update(ppeAssignmentsTable)
    .set({ employeeConfirmedAt: confirmedAt, signatureObjectPath: objectPath })
    .where(eq(ppeAssignmentsTable.id, assignment.id));

  res.json({
    ok: true,
    employeeConfirmedAt: confirmedAt.toISOString(),
    personNameSnapshot: assignment.personNameSnapshot,
    ppeNameSnapshot: assignment.ppeNameSnapshot,
  });
});

// Admin: serve stored signature image for a confirmed assignment
router.get("/ppe/assignments/:id/signature", requireRole("admin", "master"), async (req, res): Promise<void> => {
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

  if (!assignment.signatureObjectPath) {
    res.status(404).json({ error: "Podpis nebyl nalezen" });
    return;
  }

  try {
    const buffer = await objectStorage.getPrivateObjectBuffer(assignment.signatureObjectPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    req.log?.warn({ err }, "PPE signature fetch failed — object missing or inaccessible");
    res.status(404).json({ error: "Podpis nebyl nalezen" });
  }
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

  // Validate PNG data URL
  const dataUrl = parsed.data.signatureDataUrl;
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    res.status(400).json({ error: "Podpis musí být ve formátu PNG (data:image/png;base64,...)" });
    return;
  }
  let pngBuffer: Buffer;
  try {
    pngBuffer = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  } catch {
    res.status(400).json({ error: "Nepodařilo se dekódovat podpis" });
    return;
  }
  if (pngBuffer.length > MAX_SIGNATURE_BYTES) {
    res.status(400).json({ error: `Podpis je příliš velký (max ${Math.round(MAX_SIGNATURE_BYTES / 1024)} kB)` });
    return;
  }
  if (pngBuffer.length < 8 || !pngBuffer.slice(0, 8).equals(PNG_MAGIC)) {
    res.status(400).json({ error: "Soubor podpisu není platný PNG" });
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
  if (!doc) {
    res.status(404).json({ error: "Podpis nenalezen" });
    return;
  }
  db.insert(ppeHandoverEventsTable)
    .values({
      assignmentId: params.data.id,
      handoverDocumentId: doc.id,
      eventType: "signature_viewed",
      actorUserId: req.auth?.userId ?? null,
      actorName: req.auth?.name ?? req.auth?.username ?? null,
    })
    .catch(() => undefined);

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `inline; filename="podpis-${doc.documentNumber}.png"`);
  try {
    await objectStorage.servePrivateObject(doc.pngObjectPath, res);
  } catch {
    if (!res.headersSent) {
      res.status(404).json({ error: "Soubor nenalezen" });
    }
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

  const [existing] = await db.select().from(ppeAssignmentsTable).where(eq(ppeAssignmentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
  if (existing.status !== "issued") {
    res.status(409).json({ error: "Potvrdit lze pouze aktivní výdej" });
    return;
  }
  if (existing.employeeConfirmedAt) {
    res.status(409).json({ error: "Výdej již byl potvrzen zaměstnancem" });
    return;
  }

  const expiryDays = parseInt(process.env.PPE_CONFIRM_EXPIRY_DAYS ?? "30", 10);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);

  const isExpired = existing.confirmTokenExpiresAt && existing.confirmTokenExpiresAt < new Date();
  const token = (!existing.confirmToken || isExpired) ? randomBytes(32).toString("hex") : existing.confirmToken;
  await db.update(ppeAssignmentsTable)
    .set({ confirmToken: token, confirmTokenExpiresAt: expiresAt })
    .where(eq(ppeAssignmentsTable.id, params.data.id));

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const confirmUrl = `${baseUrl}/oopp/potvrdit?token=${token}`;

  const [person] = await db.select().from(peopleTable).where(eq(peopleTable.id, existing.personId));
  let emailSent = false;

  if (person?.email && !existing.confirmEmailSentAt) {
    try {
      await sendPlainEmail({
        to: person.email,
        subject: `Potvrzení převzetí OOPP – ${existing.ppeNameSnapshot}`,
        text:
          `Dobrý den ${existing.personNameSnapshot},\n\n` +
          `Prosíme potvrďte převzetí ochranné pomůcky: ${existing.ppeNameSnapshot}.\n\n` +
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

  res.json({ confirmUrl, token, emailSent });
});

router.post("/ppe/confirm", async (req, res): Promise<void> => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Chybí token" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.confirmToken, parsed.data.token));

  if (!assignment) {
    res.status(404).json({ error: "Odkaz je neplatný nebo vypršel" });
    return;
  }
  if (assignment.confirmTokenExpiresAt && assignment.confirmTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Odkaz vypršel. Požádejte správce o nový potvrzovací odkaz." });
    return;
  }
  if (assignment.status !== "issued") {
    res.status(409).json({ error: "Tato pomůcka již byla vrácena nebo uzavřena" });
    return;
  }
  if (assignment.employeeConfirmedAt) {
    res.json({ already: true, assignment: serializeAssignment(assignment) });
    return;
  }

  const [updated] = await db
    .update(ppeAssignmentsTable)
    .set({ employeeConfirmedAt: new Date() })
    .where(eq(ppeAssignmentsTable.id, assignment.id))
    .returning();

  res.json({ already: false, assignment: serializeAssignment(updated) });
});

router.get("/ppe/confirm", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (!token) {
    res.status(400).json({ error: "Chybí token" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.confirmToken, token));

  if (!assignment) {
    res.status(404).json({ error: "Odkaz je neplatný nebo vypršel" });
    return;
  }
  if (assignment.confirmTokenExpiresAt && assignment.confirmTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Odkaz vypršel. Požádejte správce o nový potvrzovací odkaz." });
    return;
  }

  res.json(serializeAssignment(assignment));
});

export default router;
