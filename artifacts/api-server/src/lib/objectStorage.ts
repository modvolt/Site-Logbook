import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

let cachedClient: S3Client | null = null;
let cachedPublicClient: S3Client | null = null;

function buildClient(endpoint: string | undefined): S3Client {
  const region = process.env.S3_REGION || "us-east-1";
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY");
  // Path-style addressing is required by MinIO and some self-hosted gateways.
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint: endpoint || undefined,
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

// Client used only to presign upload URLs handed back to the browser. The
// signature is bound to the endpoint host, so when the browser cannot reach the
// internal endpoint (typical in Docker/Coolify where the API talks to MinIO at
// http://minio:9000 but the browser must use a public URL), set
// S3_PUBLIC_ENDPOINT to the browser-reachable endpoint. Falls back to
// S3_ENDPOINT when both sides share a single endpoint (e.g. AWS S3).
function getPublicClient(): S3Client {
  if (cachedPublicClient) return cachedPublicClient;
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT;
  cachedPublicClient = buildClient(publicEndpoint);
  return cachedPublicClient;
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

function joinKey(...parts: Array<string>): string {
  return parts.map((p) => trimSlashes(p)).filter((p) => p.length > 0).join("/");
}

async function objectExists(key: string): Promise<boolean> {
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

async function streamToResponse(
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

  res.setHeader(
    "Content-Type",
    result.ContentType || "application/octet-stream",
  );
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

export class ObjectStorageService {
  /**
   * Generate a presigned PUT URL for a brand-new private object and the stable
   * object path the client should persist (e.g. "/objects/uploads/<uuid>").
   */
  async getObjectEntityUploadURL(): Promise<{ uploadURL: string; objectPath: string }> {
    const entityId = `uploads/${randomUUID()}`;
    const key = joinKey(getPrivatePrefix(), entityId);

    const uploadURL = await getSignedUrl(
      getPublicClient(),
      new PutObjectCommand({ Bucket: getBucket(), Key: key }),
      { expiresIn: 900 },
    );

    return { uploadURL, objectPath: `/objects/${entityId}` };
  }

  /**
   * Resolve a "/objects/<entityId>" path to its bucket key, verifying the
   * object exists. Throws ObjectNotFoundError otherwise.
   */
  private async resolvePrivateKey(objectPath: string): Promise<string> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) {
      throw new ObjectNotFoundError();
    }
    const key = joinKey(getPrivatePrefix(), entityId);
    if (!(await objectExists(key))) {
      throw new ObjectNotFoundError();
    }
    return key;
  }

  /** Stream a private object ("/objects/<entityId>") to the response. */
  async servePrivateObject(objectPath: string, res: ExpressResponse): Promise<void> {
    const key = await this.resolvePrivateKey(objectPath);
    await streamToResponse(key, res, { isPublic: false });
  }

  /**
   * Permanently delete a private object referenced by a "/objects/<entityId>"
   * path. Used for GDPR erasure. Safe to call for missing objects — S3 delete
   * is idempotent and returns success even when the key does not exist. Returns
   * false (instead of throwing) when the path is not a valid private object
   * reference, so callers can skip non-storage values.
   */
  async deletePrivateObject(objectPath: string): Promise<boolean> {
    if (!objectPath || !objectPath.startsWith("/objects/")) {
      return false;
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) return false;
    const key = joinKey(getPrivatePrefix(), entityId);
    await getClient().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    return true;
  }

  /**
   * Stream a public asset by its relative path, searching configured public
   * prefixes. Returns false if no matching object is found.
   */
  async servePublicObject(filePath: string, res: ExpressResponse): Promise<boolean> {
    const relative = trimSlashes(filePath);
    if (!relative) return false;

    for (const prefix of getPublicPrefixes()) {
      const key = joinKey(prefix, relative);
      if (await objectExists(key)) {
        await streamToResponse(key, res, { isPublic: true });
        return true;
      }
    }
    return false;
  }
}
