import { Router, type IRouter } from "express";
import { and, gte, lte, eq, sql, desc, asc, inArray, isNull } from "drizzle-orm";
import {
  db,
  activitiesTable,
  jobsTable,
  customersTable,
  jobVisitsTable,
  activityVisitsTable,
  peopleTable,
  ppeAssignmentsTable,
  ppeHandoverDocumentsTable,
  ppeHandoverEventsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { generatePpeHandoverPdf } from "../lib/ppe-handover-pdf";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";

const objectStorage = new ObjectStorageService();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGNATURE_BYTES = 500 * 1024;
const CONFIRMATION_TEXT_DEFAULT =
  "Svým podpisem potvrzuji, že jsem převzal/a výše uvedené ochranné pracovní pomůcky (OOPP). " +
  "Zavazuji se je používat v souladu s pokyny výrobce a zaměstnavatele a chránit je před poškozením.";

const router: IRouter = Router();

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymd(monday), to: ymd(sunday) };
}

function getMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last) };
}

router.get("/me/stats", requireAuth, async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const week = getWeekRange();
  const month = getMonthRange();

  const [activitiesAll] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(eq(activitiesTable.createdByUserId, userId));

  const [activitiesWeek] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        gte(activitiesTable.updatedAt, new Date(week.from)),
      ),
    );

  const [activitiesMonth] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        gte(activitiesTable.updatedAt, new Date(month.from)),
      ),
    );

  const [activeCount] = await db
    .select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        eq(activitiesTable.isArchived, false),
      ),
    );

  // Jobs (team-wide, no per-user attribution yet)
  const [jobsAll] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
      done: sql<number>`sum(case when ${jobsTable.status} = 'done' then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(isNull(jobsTable.archivedAt));

  const [jobsWeek] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), gte(jobsTable.date, week.from), lte(jobsTable.date, week.to)));

  const [jobsMonth] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), gte(jobsTable.date, month.from), lte(jobsTable.date, month.to)));

  res.json({
    activityHoursWeek: Number(activitiesWeek?.total ?? 0),
    activityHoursMonth: Number(activitiesMonth?.total ?? 0),
    activityHoursAll: Number(activitiesAll?.total ?? 0),
    activitiesActiveCount: Number(activeCount?.c ?? 0),
    jobHoursWeek: Number(jobsWeek?.total ?? 0),
    jobHoursMonth: Number(jobsMonth?.total ?? 0),
    jobHoursAll: Number(jobsAll?.total ?? 0),
    jobsDoneCount: Number(jobsAll?.done ?? 0),
  });
});

router.get("/me/jobs", requireAuth, async (req, res): Promise<void> => {
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;

  const rows = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      date: jobsTable.date,
      clientSite: jobsTable.clientSite,
      hoursSpent: jobsTable.hoursSpent,
      status: jobsTable.status,
      customerName: customersTable.companyName,
    })
    .from(jobsTable)
    .leftJoin(customersTable, eq(jobsTable.customerId, customersTable.id))
    .where(and(isNull(jobsTable.archivedAt), eq(jobsTable.status, "done")))
    .orderBy(desc(jobsTable.date))
    .limit(limit);

  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      clientSite: r.clientSite ?? r.customerName ?? null,
      hoursSpent: r.hoursSpent != null ? Number(r.hoursSpent) : null,
      status: r.status,
    })),
  );
});

// Planned site visits for the logged-in technician. Authentication carries the
// authoritative personId; display names are not used as identifiers.
// Returns both job visits and activity visits unified under a single shape:
// { kind: "job"|"activity", parentId, parentName, ... }
// Optional query params: from (YYYY-MM-DD, defaults to today), to (YYYY-MM-DD, no upper bound by default).
router.get("/me/visits", requireAuth, async (req, res): Promise<void> => {
  const fromParam = typeof req.query.from === "string" ? req.query.from : ymd(new Date());
  const toParam = typeof req.query.to === "string" ? req.query.to : null;

  const personIds = req.auth!.personId == null ? [] : [req.auth!.personId];

  if (personIds.length === 0) {
    res.json([]);
    return;
  }

  const jobDateConditions = [
    gte(jobVisitsTable.date, fromParam),
    ...(toParam ? [lte(jobVisitsTable.date, toParam)] : []),
  ];
  const activityDateConditions = [
    gte(activityVisitsTable.date, fromParam),
    ...(toParam ? [lte(activityVisitsTable.date, toParam)] : []),
  ];

  const [jobRows, activityRows] = await Promise.all([
    db
      .select({
        id: jobVisitsTable.id,
        jobId: jobVisitsTable.jobId,
        date: jobVisitsTable.date,
        note: jobVisitsTable.note,
        status: jobVisitsTable.status,
        jobTitle: jobsTable.title,
        jobClientSite: jobsTable.clientSite,
        customerName: customersTable.companyName,
      })
      .from(jobVisitsTable)
      .innerJoin(jobsTable, eq(jobVisitsTable.jobId, jobsTable.id))
      .leftJoin(customersTable, eq(jobsTable.customerId, customersTable.id))
      .where(
        and(
          isNull(jobsTable.archivedAt),
          inArray(jobVisitsTable.personId, personIds),
          eq(jobVisitsTable.status, "planned"),
          ...jobDateConditions,
        ),
      )
      .orderBy(asc(jobVisitsTable.date), asc(jobVisitsTable.id)),

    db
      .select({
        id: activityVisitsTable.id,
        activityId: activityVisitsTable.activityId,
        date: activityVisitsTable.date,
        note: activityVisitsTable.note,
        status: activityVisitsTable.status,
        activityName: activitiesTable.name,
        customerName: customersTable.companyName,
      })
      .from(activityVisitsTable)
      .innerJoin(activitiesTable, eq(activityVisitsTable.activityId, activitiesTable.id))
      .leftJoin(customersTable, eq(activitiesTable.customerId, customersTable.id))
      .where(
        and(
          inArray(activityVisitsTable.personId, personIds),
          eq(activityVisitsTable.status, "planned"),
          ...activityDateConditions,
        ),
      )
      .orderBy(asc(activityVisitsTable.date), asc(activityVisitsTable.id)),
  ]);

  const results = [
    ...jobRows.map((r) => ({
      id: r.id,
      kind: "job" as const,
      parentId: r.jobId,
      parentName: r.jobTitle ?? r.jobClientSite ?? r.customerName ?? null,
      jobId: r.jobId,
      jobTitle: r.jobTitle,
      clientSite: r.jobClientSite ?? r.customerName ?? null,
      date: r.date,
      note: r.note,
      status: r.status,
    })),
    ...activityRows.map((r) => ({
      id: r.id,
      kind: "activity" as const,
      parentId: r.activityId,
      parentName: r.activityName ?? r.customerName ?? null,
      jobId: null,
      jobTitle: null,
      clientSite: r.customerName ?? null,
      date: r.date,
      note: r.note,
      status: r.status,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  res.json(results);
});

// ── Self-service PPE signing ───────────────────────────────────────────────────
//
// Resolves the logged-in user to a person record by name (same logic as
// /me/visits). If no match or >1 match the list is empty and signing is blocked.

router.get("/me/ppe/assignments", requireAuth, async (req, res): Promise<void> => {
  const name = req.auth!.name;
  const matchingPeople = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(eq(peopleTable.name, name));
  const personIds = matchingPeople.map((p) => p.id);

  if (personIds.length !== 1) {
    res.json([]);
    return;
  }

  const assignments = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(
      and(
        eq(ppeAssignmentsTable.personId, personIds[0]),
        eq(ppeAssignmentsTable.status, "issued"),
        isNull(ppeAssignmentsTable.employeeConfirmedAt),
      ),
    )
    .orderBy(asc(ppeAssignmentsTable.issuedAt));

  res.json(
    assignments.map((a) => ({
      id: a.id,
      ppeItemId: a.ppeItemId,
      personId: a.personId,
      ppeNameSnapshot: a.ppeNameSnapshot,
      personNameSnapshot: a.personNameSnapshot,
      ppeCategorySnapshot: a.ppeCategorySnapshot,
      quantity: a.quantity,
      size: a.size,
      serialNumber: a.serialNumber,
      issuedAt: a.issuedAt,
      replaceBy: a.replaceBy,
      nextInspectionAt: a.nextInspectionAt,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
  );
});

const MyPpeSignSchema = z.object({
  signatureDataUrl: z.string().startsWith("data:image/png;base64,"),
  confirmationText: z.string().optional(),
});

router.post("/me/ppe/assignments/:id/sign", requireAuth, async (req, res): Promise<void> => {
  const idParam = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!idParam.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }

  const parsed = MyPpeSignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Chybí nebo je neplatný podpis (očekáváno PNG base64 data URL)" });
    return;
  }

  const name = req.auth!.name;
  const matchingPeople = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(eq(peopleTable.name, name));
  const personIds = matchingPeople.map((p) => p.id);

  if (personIds.length !== 1) {
    res.status(403).json({
      error:
        personIds.length === 0
          ? "Váš uživatelský účet není propojen s žádným zaměstnancem."
          : "Váš uživatelský účet odpovídá více zaměstnancům — kontaktujte administrátora.",
    });
    return;
  }

  const [assignment] = await db
    .select()
    .from(ppeAssignmentsTable)
    .where(
      and(
        eq(ppeAssignmentsTable.id, idParam.data),
        eq(ppeAssignmentsTable.personId, personIds[0]),
      ),
    );

  if (!assignment) {
    res.status(404).json({ error: "Výdej nenalezen nebo nepatří vašemu záznamu." });
    return;
  }
  if (assignment.status !== "issued") {
    res.status(409).json({ error: "Výdej byl uzavřen a nelze ho již podepsat." });
    return;
  }
  if (assignment.employeeConfirmedAt) {
    res.status(409).json({ error: "Výdej byl již podepsán." });
    return;
  }

  const dataUrl = parsed.data.signatureDataUrl;
  let pngBuffer: Buffer;
  try {
    pngBuffer = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  } catch {
    res.status(400).json({ error: "Nepodařilo se dekódovat podpis." });
    return;
  }
  if (pngBuffer.length > MAX_SIGNATURE_BYTES) {
    res.status(400).json({ error: `Podpis je příliš velký (max ${Math.round(MAX_SIGNATURE_BYTES / 1024)} kB).` });
    return;
  }
  if (pngBuffer.length < 8 || !pngBuffer.slice(0, 8).equals(PNG_MAGIC)) {
    res.status(400).json({ error: "Soubor podpisu není platný PNG." });
    return;
  }

  const signedAt = new Date();
  const year = signedAt.getFullYear();
  const signatoryName = name;
  const issuerSnapshot = name;
  const confirmationText = parsed.data.confirmationText ?? CONFIRMATION_TEXT_DEFAULT;
  const pngSha256 = createHash("sha256").update(pngBuffer).digest("hex");

  const pngObjectPath = `/objects/ppe-handovers/${randomUUID()}.png`;
  const pdfObjectPath = `/objects/ppe-handovers/${randomUUID()}.pdf`;
  let pngUploaded = false;
  let pdfUploaded = false;

  try {
    const companyName = "Modvolt s.r.o.";

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

    const handoverDoc = await db.transaction(async (tx) => {
      const [recheck] = await tx
        .select()
        .from(ppeAssignmentsTable)
        .where(eq(ppeAssignmentsTable.id, idParam.data))
        .for("update");
      if (recheck?.employeeConfirmedAt) {
        throw new Error("ALREADY_SIGNED");
      }

      await objectStorage.putPrivateObject(pngObjectPath, pngBuffer, "image/png");
      pngUploaded = true;
      await objectStorage.putPrivateObject(pdfObjectPath, pdfBuffer, "application/pdf");
      pdfUploaded = true;

      const [doc] = await tx
        .insert(ppeHandoverDocumentsTable)
        .values({
          assignmentId: idParam.data,
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

      const documentNumber = `OOPP-${year}-${String(doc.id).padStart(6, "0")}`;
      const [finalDoc] = await tx
        .update(ppeHandoverDocumentsTable)
        .set({ documentNumber })
        .where(eq(ppeHandoverDocumentsTable.id, doc.id))
        .returning();

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

      await objectStorage.putPrivateObject(pdfObjectPath, realPdfBuffer, "application/pdf");

      const [docWithRealSha] = await tx
        .update(ppeHandoverDocumentsTable)
        .set({ pdfSha256: realPdfSha256 })
        .where(eq(ppeHandoverDocumentsTable.id, doc.id))
        .returning();

      await tx
        .update(ppeAssignmentsTable)
        .set({ employeeConfirmedAt: signedAt })
        .where(eq(ppeAssignmentsTable.id, idParam.data));

      await tx.insert(ppeHandoverEventsTable).values({
        assignmentId: idParam.data,
        handoverDocumentId: doc.id,
        eventType: "signed",
        actorUserId: req.auth?.userId ?? null,
        actorName: signatoryName,
      });

      return docWithRealSha ?? finalDoc;
    });

    res.status(201).json({
      ok: true,
      employeeConfirmedAt: signedAt.toISOString(),
      documentNumber: handoverDoc.documentNumber,
    });
  } catch (err) {
    if (pngUploaded) {
      objectStorage.deletePrivateObject(pngObjectPath).catch(() => undefined);
    }
    if (pdfUploaded) {
      objectStorage.deletePrivateObject(pdfObjectPath).catch(() => undefined);
    }
    if (err instanceof Error && err.message === "ALREADY_SIGNED") {
      res.status(409).json({ error: "Výdej byl již podepsán." });
      return;
    }
    req.log?.error({ err }, "Error in self-service PPE sign");
    res.status(500).json({ error: "Nepodařilo se vytvořit protokol o předání." });
  }
});

export default router;
