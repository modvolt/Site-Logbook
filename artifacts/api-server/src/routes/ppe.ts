import { Router, type IRouter } from "express";
import { and, count, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";
import { PPE_CATEGORIES, PPE_STATUSES } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { z } from "zod/v4";
import { generatePpePdf, generatePpeCsv, type PpeExportRow } from "../lib/ppe-pdf";
import { ensureBillingSettings } from "../lib/invoice-service";
import { ObjectStorageService } from "../lib/objectStorage";
import { randomUUID } from "crypto";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serializeItem(item: typeof ppeItemsTable.$inferSelect) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
  };
}

function serializeAssignment(a: typeof ppeAssignmentsTable.$inferSelect) {
  return {
    ...a,
    signatureToken: undefined,
    signatureObjectPath: undefined,
    hasSignature: !!a.signatureObjectPath,
    employeeConfirmedAt: a.employeeConfirmedAt ? a.employeeConfirmedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
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

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

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

router.get("/ppe/assignments", async (req, res): Promise<void> => {
  const todayStr = today();
  const conditions = [];

  const personId = req.query.personId ? Number(req.query.personId) : null;
  if (personId && Number.isFinite(personId)) {
    conditions.push(eq(ppeAssignmentsTable.personId, personId));
  }

  const status = req.query.status as string | undefined;
  if (status && PPE_STATUSES.includes(status as typeof PPE_STATUSES[number])) {
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

  const rows = conditions.length
    ? await db.select().from(ppeAssignmentsTable).where(and(...conditions)).orderBy(ppeAssignmentsTable.issuedAt)
    : await db.select().from(ppeAssignmentsTable).orderBy(ppeAssignmentsTable.issuedAt);

  res.json(rows.map(serializeAssignment));
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
      status: "issued",
    })
    .returning();

  res.status(201).json(serializeAssignment(assignment));
});

router.delete("/ppe/assignments/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [deleted] = await db
    .delete(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.id, params.data.id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Výdej nenalezen" });
    return;
  }
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

  res.json(serializeAssignment(updated));
});

export default router;
