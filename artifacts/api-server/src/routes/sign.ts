import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { db, jobsTable, customersTable } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { decodeSignatureImage } from "../lib/signature-image";
import {
  consumePublicAccessToken,
  PublicAccessTokenError,
  publicAccessTokenHttpStatus,
  resolvePublicAccessToken,
} from "../lib/public-access-token";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function sendTokenError(
  res: import("express").Response,
  error: PublicAccessTokenError,
): void {
  const status = publicAccessTokenHttpStatus(error);
  const message = error.code === "expired"
    ? "Platnost odkazu k podpisu vypršela. Požádejte o zaslání nového odkazu."
    : error.code === "consumed"
      ? "Tento odkaz k podpisu již byl použit."
      : "Odkaz k podpisu nebyl nalezen, byl zrušen nebo již není platný.";
  res.status(status).json({ error: message, code: `public_token_${error.code}` });
}

class JobSignatureStateError extends Error {
  constructor(readonly code: "not_found" | "already_signed") {
    super(code);
    this.name = "JobSignatureStateError";
  }
}

router.get("/sign/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token) {
    res.status(400).json({ error: "Neplatný token" });
    return;
  }

  let tokenRecord;
  try {
    tokenRecord = await resolvePublicAccessToken("job_signature", token);
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendTokenError(res, error);
      return;
    }
    throw error;
  }
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, tokenRecord.resourceId));

  if (!job) {
    res.status(404).json({ error: "Odkaz k podpisu nebyl nalezen. Možná byl zrušen nebo jste použili neplatný odkaz." });
    return;
  }

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
    expired: false,
  });
});

router.post("/sign/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  if (!token) {
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

  let tokenRecord;
  try {
    tokenRecord = await resolvePublicAccessToken("job_signature", token);
  } catch (error) {
    if (error instanceof PublicAccessTokenError) {
      sendTokenError(res, error);
      return;
    }
    throw error;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, tokenRecord.resourceId));

  if (!job) {
    res.status(404).json({ error: "Odkaz k podpisu nebyl nalezen" });
    return;
  }

  if (job.signedAt) {
    res.status(409).json({ error: "Zakázka již byla podepsána" });
    return;
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

  try {
    const signedAt = await consumePublicAccessToken({
      purpose: "job_signature",
      token,
      action: "signed",
      transition: async (tx, record) => {
        const [current] = await tx
          .select({ id: jobsTable.id, signedAt: jobsTable.signedAt })
          .from(jobsTable)
          .where(eq(jobsTable.id, record.resourceId))
          .for("update");
        if (!current) throw new JobSignatureStateError("not_found");
        if (current.signedAt) throw new JobSignatureStateError("already_signed");
        const value = new Date();
        await tx
          .update(jobsTable)
          .set({ signedAt: value, signatureObjectPath: objectPath })
          .where(eq(jobsTable.id, current.id));
        return value;
      },
    });
    res.json({ signedAt: signedAt.toISOString() });
  } catch (error) {
    await objectStorage.deletePrivateObject(objectPath).catch((cleanupError: unknown) => {
      req.log?.warn({ err: cleanupError, objectPath }, "Failed to clean up orphan signature object after lost race");
    });
    if (error instanceof PublicAccessTokenError) {
      sendTokenError(res, error);
      return;
    }
    if (error instanceof JobSignatureStateError) {
      res.status(error.code === "not_found" ? 404 : 409).json({
        error: error.code === "not_found"
          ? "Zakázka nebyla nalezena."
          : "Zakázka již byla podepsána.",
      });
      return;
    }
    req.log?.error({ err: error }, "Job signature save failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis. Zkuste to prosím znovu." });
  }
});

export default router;
