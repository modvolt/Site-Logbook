import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
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

function getClient(): S3Client {
  if (cachedClient) return cachedClient;

  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "us-east-1";
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY");
  // Path-style addressing is required by MinIO and some self-hosted gateways.
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  cachedClient = new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
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
      getClient(),
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
