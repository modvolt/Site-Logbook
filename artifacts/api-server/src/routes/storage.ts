import { Router, type IRouter, type Request, type Response } from "express";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Hard limit on a single uploaded file (photos/documents). Enforced here at
// presign time so the server never hands out an upload URL for an oversized or
// disallowed file. 30 MB comfortably covers phone photos and PDFs.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// Allowlist of content types the app accepts. Notably excludes text/html and
// SVG to avoid storing active content that could be served back inline.
const ALLOWED_UPLOAD_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const { name, size, contentType } = parsed.data;

  if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `Soubor je příliš velký (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
    });
    return;
  }
  if (contentType && !ALLOWED_UPLOAD_TYPES.has(contentType)) {
    res.status(415).json({ error: "Tento typ souboru není povolen." });
    return;
  }

  try {
    const { uploadURL, objectPath } =
      await objectStorageService.getObjectEntityUploadURL();

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from the configured public prefixes.
 * These are unconditionally public — no authentication or ACL checks.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const served = await objectStorageService.servePublicObject(filePath, res);
    if (!served) {
      res.status(404).json({ error: "File not found" });
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to serve public object" });
    }
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve private object entities uploaded via the presigned-URL flow.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    // Database backups live under the "backups/" prefix and contain the entire
    // database. They must NEVER be served through this generic (any authenticated
    // user, incl. guests on GET) endpoint — only via the admin-gated
    // GET /api/backups/:id/download route. Treat them as nonexistent here.
    if (wildcardPath === "backups" || wildcardPath.startsWith("backups/")) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const objectPath = `/objects/${wildcardPath}`;
    await objectStorageService.servePrivateObject(objectPath, res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to serve object" });
    }
  }
});

export default router;
