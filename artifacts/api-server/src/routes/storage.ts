import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHash, randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { UploadObjectResponse } from "@workspace/api-zod";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  diagnoseS3,
} from "../lib/objectStorage";
import { requirePermission } from "../middlewares/permissions";
import { contentMatchesType } from "../lib/fileSignature";
import { canAccessPrivateObject } from "../lib/private-object-access";
import { verifyOfflineContentDigest } from "../lib/offline-content-digest";
import { scanUploadContent } from "../lib/upload-scanner";
import {
  createObjectUploadIntent,
  LEDGERED_UPLOAD_PREFIX,
  markObjectUploadFailed,
  markObjectUploadQuarantined,
  markObjectUploadStored,
} from "../lib/object-upload-ledger";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Hard limit on a single uploaded file (photos/documents). Enforced here as the
// raw body is parsed, so an oversized payload is rejected with a clean JSON 413.
// Keep nginx's client_max_body_size (artifacts/stavba/nginx.conf) at/above this,
// or large files are rejected at the proxy with an HTML 413 before reaching here.
// Note: the body is buffered in memory, so each concurrent upload uses up to this
// many bytes of RAM — raise with that in mind.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Limit nahrávání byl dočasně vyčerpán. Zkuste to později." },
});

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
    if (!req.auth) {
      res.status(401).json({ error: "Pro nahrání souboru je nutné přihlášení." });
      return;
    }
    next();
  },
  uploadRateLimit,
  (req: Request, res: Response, next: NextFunction) => {
    // Parse the raw body capped at MAX_UPLOAD_BYTES. A too-large payload is
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
    if (!verifyOfflineContentDigest(req, body)) {
      res.status(400).json({
        error: "SHA-256 offline uploadu neodpovídá přijatému obsahu.",
        code: "offline_content_digest_mismatch",
      });
      return;
    }

    // Verify the actual file bytes match the declared content type, so a client
    // cannot store disguised active content (e.g. HTML labelled image/png).
    if (!contentMatchesType(contentType, body)) {
      res.status(415).json({
        error: "Obsah souboru neodpovídá jeho typu.",
      });
      return;
    }

    const scan = await scanUploadContent(body, contentType, name || "soubor");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const attemptId = randomUUID();
    const objectPath = scan.verdict === "content_validated" || scan.verdict === "clean"
      ? `${LEDGERED_UPLOAD_PREFIX}${attemptId}`
      : `/objects/quarantine/${attemptId}`;
    try {
      await createObjectUploadIntent({
        objectPath,
        uploadedByUserId: req.auth!.userId,
        originalName: (name || "soubor").slice(0, 255),
        contentType,
        sizeBytes: body.length,
        sha256,
      });

      if (scan.verdict === "malicious") {
        await markObjectUploadFailed(objectPath, scan.reason, "malicious");
        res.status(422).json({ error: "Soubor neprošel bezpečnostní kontrolou." });
        return;
      }

      await objectStorageService.putPrivateObject(objectPath, body, contentType, {
        uploadStatus: scan.verdict === "unavailable" ? "quarantined" : "stored",
      });
      if (scan.verdict === "unavailable") {
        await markObjectUploadQuarantined(objectPath, scan.reason);
        res.status(503).json({
          error: `${scan.reason} Soubor byl bezpečně oddělen a nebyl zpřístupněn.`,
          code: "upload_quarantined",
        });
        return;
      }
      await markObjectUploadStored(objectPath, scan.verdict);
      res.json(
        UploadObjectResponse.parse({
          objectPath,
          metadata: { name: name || "soubor", size: body.length, contentType },
        }),
      );
    } catch (error) {
      await markObjectUploadFailed(
        objectPath,
        "Storage provider request failed.",
        scan.verdict === "unavailable" ? "unavailable" : "pending",
      ).catch((ledgerError: unknown) => {
        const ledgerFailure = ledgerError as { name?: string; code?: string };
        req.log.error(
          {
            objectPath,
            errorName: ledgerFailure?.name,
            errorCode: ledgerFailure?.code,
          },
          "Upload ledger update failed",
        );
      });
      const providerError = error as Record<string, unknown> & {
        name?: string;
        Code?: string;
        $metadata?: { httpStatusCode?: number; requestId?: string };
      };
      req.log.error(
        {
          objectPath,
          storageError: {
            name: providerError?.name,
            code: providerError?.Code,
            endpoint: providerError?.["Endpoint"],
            bucketRegion: providerError?.["Region"] ?? providerError?.["region"],
            httpStatusCode: providerError?.$metadata?.httpStatusCode,
            requestId: providerError?.$metadata?.requestId,
          },
        },
        "Error uploading object",
      );
      res.status(500).json({
        error: "Nepodařilo se uložit soubor do úložiště.",
        code: "storage_upload_failed",
      });
    }
  },
);

/**
 * GET /storage/diagnose
 *
 * Admin-only live probe of the configured object-storage backend. Runs
 * ListBuckets / HeadBucket / a throwaway PutObject and returns a plain,
 * secret-free Czech verdict so a misconfigured self-hosted S3 (e.g. Hetzner
 * InvalidAccessKeyId) can be diagnosed straight from the browser — without
 * relying on deploy logs whose access keys get scrubbed by log viewers.
 */
router.get(
  "/storage/diagnose",
  requirePermission("diagnostics.view"),
  async (req: Request, res: Response) => {
    try {
      const result = await diagnoseS3();
      res.json(result);
    } catch (error) {
      req.log.error({ err: error }, "Storage diagnostic failed");
      res.status(500).json({ error: "Diagnostika úložiště selhala." });
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
 * Serve only an exact DB-linked object whose owning module permissions are all
 * present. Typed-only and unknown prefixes, unlinked uploads and forbidden
 * objects are all returned as the same 404 response.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    if (
      !req.auth ||
      !(await canAccessPrivateObject(objectPath, req.auth.permissions))
    ) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
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
