import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { UploadObjectResponse } from "@workspace/api-zod";
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
 * POST /storage/uploads
 *
 * Server-proxied file upload. The browser POSTs the raw file bytes to our own
 * API (same origin — no bucket CORS or public endpoint needed), and the server
 * streams them into private object storage. Filename and content type are passed
 * as query params (?name=...&contentType=...). Replaces the old direct
 * browser→bucket presigned-PUT flow, which failed on deployments where the
 * bucket lacked a CORS rule / browser-reachable endpoint.
 */
router.post(
  "/storage/uploads",
  (req: Request, res: Response, next: NextFunction) => {
    // Parse the raw body capped at the 30 MB limit. A too-large payload is
    // rejected here with a clean JSON 413 instead of bubbling up as HTML.
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err) => {
      if (err) {
        const e = err as { type?: string; status?: number };
        if (e.type === "entity.too.large" || e.status === 413) {
          res.status(413).json({
            error: `Soubor je příliš velký (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const name = typeof req.query.name === "string" ? req.query.name : "";
    const contentType =
      typeof req.query.contentType === "string" ? req.query.contentType : "";

    if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
      res.status(415).json({ error: "Tento typ souboru není povolen." });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Chybí obsah souboru." });
      return;
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `Soubor je příliš velký (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
      });
      return;
    }

    const objectPath = `/objects/uploads/${randomUUID()}`;
    try {
      await objectStorageService.putPrivateObject(objectPath, body, contentType);
      res.json(
        UploadObjectResponse.parse({
          objectPath,
          metadata: { name: name || "soubor", size: body.length, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error uploading object");
      res.status(500).json({ error: "Nepodařilo se uložit soubor." });
    }
  },
);

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
