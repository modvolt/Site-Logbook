import { Router, type IRouter } from "express";
import { and, eq, gte, lte, or, isNotNull } from "drizzle-orm";
import { db, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";
import { PPE_CATEGORIES, PPE_STATUSES } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { z } from "zod/v4";
import { generatePpePdf, generatePpeCsv, type PpeExportRow } from "../lib/ppe-pdf";
import { ensureBillingSettings } from "../lib/invoice-service";
import crypto from "crypto";

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
    confirmToken: undefined,
    hasConfirmToken: !!a.confirmToken,
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
  if (issuedFrom && /^\d{4}-\d{2}-\d{2}$/.test(issuedFrom)) {
    conditions.push(gte(ppeAssignmentsTable.issuedAt, issuedFrom));
  }

  const issuedTo = req.query.issuedTo as string | undefined;
  if (issuedTo && /^\d{4}-\d{2}-\d{2}$/.test(issuedTo)) {
    conditions.push(lte(ppeAssignmentsTable.issuedAt, issuedTo));
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
    })
    .from(ppeAssignmentsTable)
    .innerJoin(ppeItemsTable, eq(ppeAssignmentsTable.ppeItemId, ppeItemsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(ppeAssignmentsTable.issuedAt, ppeAssignmentsTable.personNameSnapshot);

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

  const [updated] = await db
    .update(ppeAssignmentsTable)
    .set(updates)
    .where(eq(ppeAssignmentsTable.id, params.data.id))
    .returning();

  res.json(serializeAssignment(updated));
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

  const token = existing.confirmToken ?? crypto.randomBytes(32).toString("hex");
  if (!existing.confirmToken) {
    await db.update(ppeAssignmentsTable).set({ confirmToken: token }).where(eq(ppeAssignmentsTable.id, params.data.id));
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const confirmUrl = `${baseUrl}/oopp/potvrdit?token=${token}`;

  res.json({ confirmUrl, token });
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

  res.json(serializeAssignment(assignment));
});

export default router;
