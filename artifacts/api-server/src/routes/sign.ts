import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { ObjectStorageService } from "../lib/objectStorage";
import { decodeSignatureImage } from "../lib/signature-image";
import { normalizedUserAgentSha256, sha256Hex } from "../lib/evidence-hash";
import { generateJobHandoverPdf } from "../lib/job-handover-pdf";
import {
  completeJobSignature,
  JobDocumentStateError,
  loadBoundJobDocumentVersion,
} from "../lib/job-document-service";
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
  let version;
  try {
    version = await loadBoundJobDocumentVersion(tokenRecord);
  } catch (error) {
    if (error instanceof JobDocumentStateError) {
      res.status(error.code === "job_archived" ? 410 : 404).json({
        error: error.code === "job_archived"
          ? "Zakázka byla archivována a odkaz již není platný."
          : "Verze předávacího protokolu nebyla nalezena.",
      });
      return;
    }
    throw error;
  }
  const snapshot = version.dataSnapshot;

  res.json({
    jobId: snapshot.job.id,
    documentVersion: version.version,
    snapshotSha256: version.snapshotSha256,
    title: snapshot.job.title,
    date: fmtDate(snapshot.job.date),
    customerCompanyName: snapshot.job.customerCompanyName,
    notes: snapshot.job.notes,
    confirmationText: version.confirmationText,
    alreadySigned: version.status === "signed",
    signedAt: version.signedAt ? version.signedAt.toISOString() : null,
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
    .object({
      signatoryName: z.string().trim().min(2).max(120),
      signatureDataUrl: z.string().startsWith("data:image/png;base64,"),
    })
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

  let version;
  try {
    version = await loadBoundJobDocumentVersion(tokenRecord);
  } catch (error) {
    if (error instanceof JobDocumentStateError) {
      res.status(error.code === "job_archived" ? 410 : 404).json({
        error: error.code === "job_archived"
          ? "Zakázka byla archivována a odkaz již není platný."
          : "Verze předávacího protokolu nebyla nalezena.",
      });
      return;
    }
    throw error;
  }
  if (version.status !== "pending_signature") {
    res.status(409).json({ error: "Tato verze již byla podepsána." });
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
  const signatureObjectPath = `/objects/job-signatures/${tokenRecord.resourceId}-${attemptId}.png`;
  const pdfObjectPath = `/objects/job-signed-documents/${tokenRecord.resourceId}-v${version.version}-${attemptId}.pdf`;
  const signatureSha256 = sha256Hex(pngBuffer);
  const signedAt = new Date();
  const signatureDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const pdfBuffer = generateJobHandoverPdf({
    snapshot: version.dataSnapshot,
    version: version.version,
    snapshotSha256: version.snapshotSha256,
    signatoryName: body.data.signatoryName,
    signedAt,
    signatureDataUrl,
    signatureSha256,
  });
  const pdfSha256 = sha256Hex(pdfBuffer);
  try {
    await objectStorage.putPrivateObject(signatureObjectPath, pngBuffer, "image/png");
    await objectStorage.putPrivateObject(pdfObjectPath, pdfBuffer, "application/pdf");
  } catch (err) {
    await Promise.all([
      objectStorage.deletePrivateObject(signatureObjectPath).catch(() => false),
      objectStorage.deletePrivateObject(pdfObjectPath).catch(() => false),
    ]);
    req.log?.error({ err }, "Job signature upload failed");
    res.status(500).json({ error: "Nepodařilo se uložit podepsaný protokol. Zkuste to prosím znovu." });
    return;
  }

  try {
    const signedVersion = await consumePublicAccessToken({
      purpose: "job_signature",
      token,
      action: "signed",
      transition: (tx, record) => completeJobSignature(tx, {
        record,
        signatoryName: body.data.signatoryName,
        signedAt,
        signatureObjectPath,
        signatureSha256,
        pdfObjectPath,
        pdfSha256,
        userAgentSha256: normalizedUserAgentSha256(req.get("user-agent")),
      }),
    });
    res.json({
      signedAt: signedAt.toISOString(),
      documentVersion: signedVersion.version,
      snapshotSha256: signedVersion.snapshotSha256,
      pdfSha256: signedVersion.pdfSha256,
    });
  } catch (error) {
    await Promise.all([
      objectStorage.deletePrivateObject(signatureObjectPath).catch((cleanupError: unknown) => {
        req.log?.warn({ err: cleanupError, objectPath: signatureObjectPath }, "Failed to clean up orphan signature object after lost race");
        return false;
      }),
      objectStorage.deletePrivateObject(pdfObjectPath).catch((cleanupError: unknown) => {
        req.log?.warn({ err: cleanupError, objectPath: pdfObjectPath }, "Failed to clean up orphan signed PDF after lost race");
        return false;
      }),
    ]);
    if (error instanceof PublicAccessTokenError) {
      sendTokenError(res, error);
      return;
    }
    if (error instanceof JobDocumentStateError) {
      res.status(error.code === "job_archived" ? 410 : error.code === "job_not_found" || error.code === "version_not_found" ? 404 : 409).json({
        error: error.code === "job_archived"
          ? "Zakázka byla archivována a odkaz již není platný."
          : error.code === "job_not_found" || error.code === "version_not_found"
          ? "Zakázka nebo její verze nebyla nalezena."
          : "Tato verze již byla podepsána.",
      });
      return;
    }
    req.log?.error({ err: error }, "Job signature save failed");
    res.status(500).json({ error: "Nepodařilo se uložit podpis. Zkuste to prosím znovu." });
  }
});

export default router;
