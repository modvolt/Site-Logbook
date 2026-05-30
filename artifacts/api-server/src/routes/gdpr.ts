import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  customersTable,
  customerContactsTable,
  customerSitesTable,
  peopleTable,
  jobsTable,
  attachmentsTable,
  auditLogTable,
} from "@workspace/db";
import { EraseSubjectDataBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const SUBJECT_TYPES = ["customer", "contact", "person"] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

router.use("/gdpr", requireRole("admin"));

function isObjectPath(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("/objects/");
}

// Collect the object-storage paths personally attributable to a subject.
// Only customers have associated files in this schema (photos/docs on their
// jobs). Contacts and people have none.
async function collectCustomerFiles(customerId: number): Promise<string[]> {
  const jobs = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.customerId, customerId));
  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length === 0) return [];
  const atts = await db
    .select({ url: attachmentsTable.url })
    .from(attachmentsTable)
    .where(inArray(attachmentsTable.jobId, jobIds));
  return atts.map((a) => a.url).filter(isObjectPath);
}

// Gather all personal-data records held about a subject, plus associated files.
async function gatherSubject(
  subjectType: SubjectType,
  subjectId: number,
): Promise<{ data: Record<string, unknown>; files: string[] } | null> {
  if (subjectType === "customer") {
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, subjectId));
    if (!customer) return null;
    const contacts = await db
      .select()
      .from(customerContactsTable)
      .where(eq(customerContactsTable.customerId, subjectId));
    const sites = await db
      .select()
      .from(customerSitesTable)
      .where(eq(customerSitesTable.customerId, subjectId));
    const files = await collectCustomerFiles(subjectId);
    return { data: { customer, contacts, sites }, files };
  }

  if (subjectType === "contact") {
    const [contact] = await db
      .select()
      .from(customerContactsTable)
      .where(eq(customerContactsTable.id, subjectId));
    if (!contact) return null;
    return { data: { contact }, files: [] };
  }

  // person
  const [person] = await db
    .select()
    .from(peopleTable)
    .where(eq(peopleTable.id, subjectId));
  if (!person) return null;
  return { data: { person }, files: [] };
}

router.get("/gdpr/export", async (req, res): Promise<void> => {
  const subjectType = String(req.query.subjectType || "") as SubjectType;
  const subjectId = Number(req.query.subjectId);
  if (!SUBJECT_TYPES.includes(subjectType) || !Number.isInteger(subjectId)) {
    res.status(400).json({ error: "Neplatný typ nebo ID subjektu" });
    return;
  }

  const result = await gatherSubject(subjectType, subjectId);
  if (!result) {
    res.status(404).json({ error: "Subjekt nenalezen" });
    return;
  }

  res.json({
    subjectType,
    subjectId,
    generatedAt: new Date().toISOString(),
    data: result.data,
    files: result.files,
  });
});

router.post("/gdpr/erase", async (req, res): Promise<void> => {
  const parsed = EraseSubjectDataBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const subjectType = parsed.data.subjectType as SubjectType;
  const subjectId = parsed.data.subjectId;
  if (!SUBJECT_TYPES.includes(subjectType)) {
    res.status(400).json({ error: "Neplatný typ subjektu" });
    return;
  }

  const result = await gatherSubject(subjectType, subjectId);
  if (!result) {
    res.status(404).json({ error: "Subjekt nenalezen" });
    return;
  }

  // Delete DB records first inside a transaction so the database is the source
  // of truth. Object-storage files are removed only after the transaction
  // commits — if the transaction rolls back, no files are orphaned.
  await db.transaction(async (tx) => {
    if (subjectType === "customer") {
      // Remove ALL attachment rows on the customer's jobs (photos, documents,
      // notes — every record personally attributable to the subject). Jobs
      // themselves survive as anonymized business records: deleting the
      // customer sets jobs.customer_id to NULL via the FK's ON DELETE SET NULL.
      const jobs = await tx
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(eq(jobsTable.customerId, subjectId));
      const jobIds = jobs.map((j) => j.id);
      if (jobIds.length > 0) {
        await tx.delete(attachmentsTable).where(inArray(attachmentsTable.jobId, jobIds));
      }
      // Cascades to customer_contacts and customer_sites (ON DELETE CASCADE).
      await tx.delete(customersTable).where(eq(customersTable.id, subjectId));
    } else if (subjectType === "contact") {
      await tx.delete(customerContactsTable).where(eq(customerContactsTable.id, subjectId));
    } else {
      // person — jobs.assigned_person_id and machines.assigned_person_id are
      // ON DELETE SET NULL, so business history survives without the personal link.
      await tx.delete(peopleTable).where(eq(peopleTable.id, subjectId));
    }

    await tx.insert(auditLogTable).values({
      actorUserId: req.auth?.userId ?? null,
      actorName: req.auth?.name ?? req.auth?.username ?? null,
      action: "erase",
      entityType: subjectType,
      entityId: subjectId,
      summary: `GDPR výmaz subjektu ${subjectType} #${subjectId}; souborů k odstranění: ${result.files.length}`,
      method: "POST",
      path: "/gdpr/erase",
    });
  });

  // After the DB commit, remove the object-storage files. Track failures so the
  // response honestly reports whether every personal file was actually removed.
  let deletedFiles = 0;
  const failedFiles: string[] = [];
  for (const path of result.files) {
    try {
      const ok = await objectStorage.deletePrivateObject(path);
      if (ok) deletedFiles++;
      else failedFiles.push(path);
    } catch (err) {
      req.log.error({ err, path }, "GDPR erase: failed to delete object");
      failedFiles.push(path);
    }
  }

  const allFilesRemoved = failedFiles.length === 0;
  const message = allFilesRemoved
    ? `Osobní údaje subjektu byly trvale vymazány. Smazáno souborů: ${deletedFiles}.`
    : `Databázové záznamy byly vymazány, ale ${failedFiles.length} souborů se nepodařilo odstranit z úložiště. Smazáno souborů: ${deletedFiles}.`;

  res.json({
    subjectType,
    subjectId,
    deletedFiles,
    failedFiles: failedFiles.length,
    allFilesRemoved,
    message,
  });
});

export default router;
