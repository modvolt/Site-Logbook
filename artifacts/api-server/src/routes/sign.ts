import { Router, type IRouter } from "express";
import { and, eq, isNull, gt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { db, jobsTable, customersTable } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

router.get("/sign/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token || !TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Neplatný token" });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.signatureToken, token));

  if (!job) {
    res.status(404).json({ error: "Odkaz k podpisu nebyl nalezen. Možná byl zrušen nebo jste použili neplatný odkaz." });
    return;
  }

  const expired =
    job.signatureTokenExpiresAt != null &&
    job.signatureTokenExpiresAt < new Date();

  let customerCompanyName: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({ companyName: customersTable.companyName })
      .from(customersTable)
      .where(eq(customersTable.id, job.customerId));
    customerCompanyName = customer?.companyName ?? null;
  }

  res.json({
    jobId: job.id,
    title: job.title,
    date: fmtDate(job.date),
    customerCompanyName,
    notes: job.notes,
    alreadySigned: !!job.signedAt,
    signedAt: job.signedAt ? job.signedAt.toISOString() : null,
    expired,
  });
});

router.post("/sign/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token || !TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Neplatný token" });
    return;
  }

  const body = z
    .object({ signatureDataUrl: z.string().startsWith("data:image/png;base64,") })
    .safeParse(req.body);

  if (!body.success) {
    res.status(400).json({ error: "Chybí nebo je neplatný podpis (očekáváno PNG base64 data URL)" });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.signatureToken, token));

  if (!job) {
    res.status(404).json({ error: "Odkaz k podpisu nebyl nalezen" });
    return;
  }

  if (job.signatureTokenExpiresAt != null && job.signatureTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Platnost odkazu k podpisu vypršela. Požádejte o zaslání nového odkazu." });
    return;
  }

  if (job.signedAt) {
    res.status(409).json({ error: "Zakázka již byla podepsána" });
    return;
  }

  const base64Data = body.data.signatureDataUrl.replace(/^data:image\/png;base64,/, "");
  const pngBuffer = Buffer.from(base64Data, "base64");

  // Use a unique key per attempt so concurrent submissions never overwrite each other.
  // The conditional DB update decides the winner; the loser's object is cleaned up.
  const attemptId = randomUUID();
  const objectPath = `/objects/job-signatures/${job.id}-${attemptId}.png`;
  try {
    await objectStorage.putPrivateObject(objectPath, pngBuffer, "image/png");
  } catch (err) {
    req.log?.error({ err }, "Job signature upload failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis. Zkuste to prosím znovu." });
    return;
  }

  const signedAt = new Date();
  const updated = await db
    .update(jobsTable)
    .set({ signedAt, signatureObjectPath: objectPath })
    .where(
      and(
        eq(jobsTable.signatureToken, token),
        isNull(jobsTable.signedAt),
        gt(jobsTable.signatureTokenExpiresAt, new Date()),
      )
    )
    .returning({ id: jobsTable.id });

  if (!updated.length) {
    // Another request won the race — clean up the orphan object we just uploaded.
    objectStorage.deletePrivateObject(objectPath).catch((err: unknown) => {
      req.log?.warn({ err, objectPath }, "Failed to clean up orphan signature object after lost race");
    });
    res.status(409).json({ error: "Zakázka již byla podepsána nebo platnost odkazu vypršela." });
    return;
  }

  res.json({ signedAt: signedAt.toISOString() });
});

export default router;
