import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import type { Response as ExpressResponse } from "express";

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// Object storage supports two backends:
//   - S3-compatible (AWS S3, MinIO, Hetzner Object Storage, …) for self-hosted
//     / production deploys. Selected when the S3_* env vars are configured.
//   - Replit App Storage (GCS, authenticated via the Replit sidecar) for the
//     Replit dev environment. Used as the fallback when S3 is not configured.
// Both expose the same small surface used by routes/storage.ts and GDPR erasure:
// putPrivateObject / servePrivateObject / deletePrivateObject /
// servePublicObject. Stored object paths are backend-agnostic ("/objects/...").
function s3Configured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinKey(...parts: Array<string>): string {
  return parts.map((p) => trimSlashes(p)).filter((p) => p.length > 0).join("/");
}

// ---------------------------------------------------------------------------
// S3-compatible backend
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} not set. Configure S3-compatible object storage via the ` +
        `S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and ` +
        `S3_SECRET_ACCESS_KEY environment variables.`,
    );
  }
  return value;
}

let cachedClient: S3Client | null = null;

// The AWS SDK requires a fully-qualified endpoint URL (with scheme); it calls
// `new URL(endpoint)` internally and throws "Invalid URL" for a bare host like
// "fsn1.your-objectstorage.com". Operators commonly omit the scheme, so be
// lenient and default to https:// (the safe choice for managed S3 providers).
function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const trimmed = endpoint.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function buildClient(endpoint: string | undefined): S3Client {
  const region = process.env.S3_REGION || "us-east-1";
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY");
  // Path-style addressing is required by MinIO and some self-hosted gateways.
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint: normalizeEndpoint(endpoint),
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// Client used for all server-side operations (Head/Get/Delete). It talks to the
// object store over the internal/private endpoint (e.g. http://minio:9000).
function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = buildClient(process.env.S3_ENDPOINT);
  return cachedClient;
}

function getBucket(): string {
  return requireEnv("S3_BUCKET");
}

// Optional key prefix applied to private (uploaded) objects inside the bucket.
function getPrivatePrefix(): string {
  return trimSlashes(process.env.S3_PRIVATE_PREFIX || "private");
}

// Comma-separated key prefixes searched when serving public assets.
function getPublicPrefixes(): Array<string> {
  const raw = process.env.S3_PUBLIC_PREFIX || "public";
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((p) => trimSlashes(p))
        .filter((p) => p.length > 0),
    ),
  );
}

async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw err;
  }
}

async function s3StreamToResponse(
  key: string,
  res: ExpressResponse,
  { isPublic, cacheTtlSec = 3600 }: { isPublic: boolean; cacheTtlSec?: number },
): Promise<void> {
  let result;
  try {
    result = await getClient().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    );
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
      throw new ObjectNotFoundError();
    }
    throw err;
  }

  res.setHeader("Content-Type", result.ContentType || "application/octet-stream");
  res.setHeader(
    "Cache-Control",
    `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
  );
  if (result.ContentLength != null) {
    res.setHeader("Content-Length", String(result.ContentLength));
  }

  const body = result.Body;
  if (!body) {
    res.end();
    return;
  }
  (body as Readable).pipe(res);
}

// ---------------------------------------------------------------------------
// Replit App Storage (GCS) backend
// ---------------------------------------------------------------------------

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

let cachedGcsClient: Storage | null = null;

function getGcsClient(): Storage {
  if (cachedGcsClient) return cachedGcsClient;
  cachedGcsClient = new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });
  return cachedGcsClient;
}

function gcsPrivateDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Provision Replit App Storage or configure " +
        "S3-compatible object storage via the S3_* environment variables.",
    );
  }
  return dir;
}

function gcsPublicSearchPaths(): Array<string> {
  const raw = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
  return Array.from(
    new Set(raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0)),
  );
}

function parseGcsPath(path: string): { bucketName: string; objectName: string } {
  let p = path;
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid object path: must contain a bucket name");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function gcsResolvePrivate(objectPath: string): {
  bucketName: string;
  objectName: string;
} {
  const entityId = trimSlashes(objectPath.slice("/objects/".length));
  if (!entityId) throw new ObjectNotFoundError();
  let dir = gcsPrivateDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  return parseGcsPath(`${dir}${entityId}`);
}

async function gcsStreamToResponse(
  bucketName: string,
  objectName: string,
  res: ExpressResponse,
  { isPublic, cacheTtlSec = 3600 }: { isPublic: boolean; cacheTtlSec?: number },
): Promise<void> {
  const file = getGcsClient().bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) throw new ObjectNotFoundError();
  const [metadata] = await file.getMetadata();
  res.setHeader(
    "Content-Type",
    (metadata.contentType as string) || "application/octet-stream",
  );
  res.setHeader(
    "Cache-Control",
    `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
  );
  if (metadata.size) {
    res.setHeader("Content-Length", String(metadata.size));
  }
  await new Promise<void>((resolve, reject) => {
    file
      .createReadStream()
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export class ObjectStorageService {
  /**
   * Upload a server-generated private object (e.g. a database backup) directly
   * from the API process. `objectPath` is the backend-agnostic
   * "/objects/<entityId>" path the caller persists. Used by the backup system
   * and the server-proxied client upload flow (POST /storage/uploads).
   */
  async putPrivateObject(
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new Error("putPrivateObject requires an /objects/ path");
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) throw new Error("putPrivateObject requires a non-empty path");

    if (s3Configured()) {
      const key = joinKey(getPrivatePrefix(), entityId);
      await getClient().send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
      return;
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    await getGcsClient()
      .bucket(bucketName)
      .file(objectName)
      .save(body, { contentType, resumable: false });
  }

  /** Stream a private object ("/objects/<entityId>") to the response. */
  async servePrivateObject(objectPath: string, res: ExpressResponse): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    if (s3Configured()) {
      const entityId = trimSlashes(objectPath.slice("/objects/".length));
      if (!entityId) throw new ObjectNotFoundError();
      const key = joinKey(getPrivatePrefix(), entityId);
      if (!(await s3ObjectExists(key))) throw new ObjectNotFoundError();
      await s3StreamToResponse(key, res, { isPublic: false });
      return;
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    await gcsStreamToResponse(bucketName, objectName, res, { isPublic: false });
  }

  /**
   * Permanently delete a private object referenced by a "/objects/<entityId>"
   * path. Used for GDPR erasure. Safe to call for missing objects. Returns
   * false (instead of throwing) when the path is not a valid private object
   * reference, so callers can skip non-storage values.
   */
  async deletePrivateObject(objectPath: string): Promise<boolean> {
    if (!objectPath || !objectPath.startsWith("/objects/")) {
      return false;
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) return false;

    if (s3Configured()) {
      const key = joinKey(getPrivatePrefix(), entityId);
      await getClient().send(
        new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
      );
      return true;
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    await getGcsClient()
      .bucket(bucketName)
      .file(objectName)
      .delete({ ignoreNotFound: true });
    return true;
  }

  /**
   * Stream a public asset by its relative path, searching configured public
   * prefixes / search paths. Returns false if no matching object is found.
   */
  async servePublicObject(filePath: string, res: ExpressResponse): Promise<boolean> {
    const relative = trimSlashes(filePath);
    if (!relative) return false;

    if (s3Configured()) {
      for (const prefix of getPublicPrefixes()) {
        const key = joinKey(prefix, relative);
        if (await s3ObjectExists(key)) {
          await s3StreamToResponse(key, res, { isPublic: true });
          return true;
        }
      }
      return false;
    }

    for (const searchPath of gcsPublicSearchPaths()) {
      const { bucketName, objectName } = parseGcsPath(`${searchPath}/${relative}`);
      const file = getGcsClient().bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        await gcsStreamToResponse(bucketName, objectName, res, { isPublic: true });
        return true;
      }
    }
    return false;
  }
}
