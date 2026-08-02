import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
  HeadBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { createHash, randomUUID } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { Response as ExpressResponse } from "express";

export type RecoveryReadinessStatus = "pass" | "fail" | "unknown";

export type RecoveryReadinessCheck = {
  status: RecoveryReadinessStatus;
  detail: string;
  value?: boolean | number | string | null;
};

export type RecoveryStorageReadinessInspection = {
  identity: Record<string, string>;
  checks: {
    bucketAccess: RecoveryReadinessCheck;
    transportSecurity: RecoveryReadinessCheck;
    versioning: RecoveryReadinessCheck;
    objectLock: RecoveryReadinessCheck & {
      defaultRetentionDays?: number | null;
      mode?: string | null;
    };
    encryption: RecoveryReadinessCheck;
    publicAccessBlock: RecoveryReadinessCheck;
  };
};

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
  return parts
    .map((p) => trimSlashes(p))
    .filter((p) => p.length > 0)
    .join("/");
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
  const normalized = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.username || parsed.password) {
    throw new Error(
      "S3_ENDPOINT must not contain embedded credentials; use the dedicated S3 credential variables.",
    );
  }
  return normalized;
}

// Startup diagnostic: a safe, secret-free summary of the active S3 backend
// config. Logged once on boot so the deployed image can be verified at a glance
// (e.g. to confirm a no-cache rebuild actually shipped the latest code, and that
// the upload-checksum workaround for Hetzner is active). NEVER include the
// secret access key here.
export function describeObjectStorageConfig(): Record<string, unknown> {
  if (!s3Configured()) {
    return { backend: "gcs-replit" };
  }
  const accessKeyId = (process.env.S3_ACCESS_KEY_ID || "").trim();
  return {
    backend: "s3",
    endpoint: normalizeEndpoint(process.env.S3_ENDPOINT) || "(aws default)",
    region: process.env.S3_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    privatePrefix: getPrivatePrefix(),
    // Length + last 4 chars only — enough to spot a wrong/truncated key without
    // leaking it.
    accessKeyIdLen: accessKeyId.length,
    accessKeyIdTail: accessKeyId.slice(-4),
    // Proves the checksum workaround (this build) is the one running.
    uploadChecksum: "WHEN_REQUIRED",
  };
}

// Pull the diagnostic-relevant fields off an AWS SDK / S3 error without ever
// exposing the secret key. Providers echo back the *access key id* they received
// in an InvalidAccessKeyId body and a region hint on a wrong-location redirect —
// both are gold for telling "wrong key" apart from "wrong bucket location".
function extractS3Error(error: unknown): {
  code?: string;
  message?: string;
  httpStatusCode?: number;
  requestId?: string;
  rejectedKeyTail?: string;
  regionHint?: string;
} {
  const e = error as Record<string, unknown> & {
    name?: string;
    message?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
    $response?: { headers?: Record<string, string> };
  };
  const rejectedKey =
    (e?.["AWSAccessKeyId"] as string | undefined) ||
    (e?.["AccessKeyId"] as string | undefined);
  const headers = e?.$response?.headers || {};
  const regionHint =
    (e?.["Region"] as string | undefined) ||
    (e?.["region"] as string | undefined) ||
    (e?.["BucketRegion"] as string | undefined) ||
    headers["x-amz-bucket-region"];
  return {
    code: (e?.Code as string | undefined) || e?.name,
    message: typeof e?.message === "string" ? e.message : undefined,
    httpStatusCode: e?.$metadata?.httpStatusCode,
    requestId: e?.$metadata?.requestId,
    rejectedKeyTail:
      typeof rejectedKey === "string" ? rejectedKey.slice(-4) : undefined,
    regionHint: typeof regionHint === "string" ? regionHint : undefined,
  };
}

// Admin-only live probe of the configured S3 backend. Runs three lightweight
// operations (ListBuckets, HeadBucket, a tiny PutObject which is deleted again)
// and returns a plain, secret-free verdict. Designed to be read directly in the
// browser so the diagnosis never has to travel through log files (whose access
// keys get scrubbed/redacted by deploy-log viewers). Returns last-4 chars of the
// configured key and of any key the provider echoes back — never the full key,
// never the secret.
export async function diagnoseS3(): Promise<Record<string, unknown>> {
  if (!s3Configured()) {
    return {
      backend: "gcs-replit",
      verdict:
        "Aktivní je Replit úložiště (GCS), ne S3. Na self-hostu nastav proměnné S3_*.",
    };
  }

  const configuredKeyTail = (process.env.S3_ACCESS_KEY_ID || "")
    .trim()
    .slice(-4);
  const region = process.env.S3_REGION || "us-east-1";
  const endpoint =
    normalizeEndpoint(process.env.S3_ENDPOINT) || "(aws default)";
  const bucket = process.env.S3_BUCKET;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
  const client = buildClient(process.env.S3_ENDPOINT);

  const probes: Record<string, unknown> = {};

  // 1) ListBuckets — pure credential check, independent of the bucket/region.
  let listBucketsOk = false;
  let bucketListed: boolean | undefined;
  try {
    const out = await client.send(new ListBucketsCommand({}));
    listBucketsOk = true;
    const names = (out.Buckets || []).map((b) => b.Name);
    bucketListed = bucket ? names.includes(bucket) : undefined;
    probes.listBuckets = { ok: true, bucketListed };
  } catch (error) {
    probes.listBuckets = { ok: false, ...extractS3Error(error) };
  }

  // 2) HeadBucket — checks bucket existence + that we're hitting the right region.
  let headBucketOk = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    headBucketOk = true;
    probes.headBucket = { ok: true };
  } catch (error) {
    probes.headBucket = { ok: false, ...extractS3Error(error) };
  }

  // 3) PutObject (then delete) — the exact operation uploads use.
  let putObjectOk = false;
  const testKey = joinKey(getPrivatePrefix(), `_diag/${randomUUID()}.txt`);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: testKey,
        Body: Buffer.from("modvolt-storage-diagnostic"),
        ContentType: "text/plain",
        ContentLength: 26,
      }),
    );
    putObjectOk = true;
    probes.putObject = { ok: true };
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: testKey }),
      );
    } catch {
      // Cleanup best-effort; leaving a 26-byte diag file is harmless.
    }
  } catch (error) {
    probes.putObject = { ok: false, ...extractS3Error(error) };
  }

  // Build a human Czech verdict from the probe outcomes.
  let verdict: string;
  if (putObjectOk) {
    verdict =
      "OK – přihlašovací údaje i bucket fungují, nahrávání by mělo jít.";
  } else if (!listBucketsOk) {
    const d = probes.listBuckets as { code?: string; rejectedKeyTail?: string };
    if (d.code === "InvalidAccessKeyId") {
      const tailMatch =
        d.rejectedKeyTail && d.rejectedKeyTail === configuredKeyTail
          ? "Odeslaný klíč se shoduje s tím v Coolify"
          : `Pozor: odeslaný klíč (…${d.rejectedKeyTail ?? "?"}) se LIŠÍ od klíče v Coolify (…${configuredKeyTail})`;
      verdict =
        `Hetzner klíč NEZNÁ (InvalidAccessKeyId) už při výpisu bucketů. ${tailMatch}. ` +
        "Příčina je téměř jistě: (a) klíč/secret v Coolify neodpovídá platnému klíči v Hetzneru, " +
        "nebo (b) bucket je v jiné lokalitě než endpoint (S3_REGION/S3_ENDPOINT). " +
        "Vygeneruj nové S3 credentials v Hetzner konzoli ve STEJNÉM projektu, kde je bucket, a ověř lokalitu bucketu.";
    } else {
      verdict = `Selhalo ověření přihlašovacích údajů: ${d.code ?? "neznámá chyba"}. Zkontroluj S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.`;
    }
  } else if (!headBucketOk) {
    const d = probes.headBucket as {
      code?: string;
      httpStatusCode?: number;
      regionHint?: string;
    };
    if (d.httpStatusCode === 301 || d.regionHint) {
      verdict =
        `Klíč je platný, ale bucket "${bucket}" je v jiné lokalitě/regionu` +
        (d.regionHint ? ` (Hetzner hlásí region: ${d.regionHint})` : "") +
        `. Uprav S3_REGION a S3_ENDPOINT na správnou lokalitu bucketu.`;
    } else {
      verdict = `Klíč je platný, ale bucket "${bucket}" není dostupný: ${d.code ?? "neznámá chyba"} (HTTP ${d.httpStatusCode ?? "?"}). Zkontroluj název bucketu.`;
    }
  } else {
    const d = probes.putObject as {
      code?: string;
      message?: string;
      rejectedKeyTail?: string;
    };
    verdict =
      `Výpis bucketů i HeadBucket prošly, ale samotné nahrání selhalo: ${d.code ?? "neznámá chyba"}` +
      (d.message ? ` – ${d.message}` : "") +
      ". To bývá nekompatibilita podpisu/checksumu nebo chybějící oprávnění k zápisu.";
  }

  return {
    backend: "s3",
    endpoint,
    region,
    bucket,
    forcePathStyle,
    configuredKeyTail,
    probes,
    verdict,
  };
}

function buildClient(endpoint: string | undefined): S3Client {
  const region = process.env.S3_REGION || "us-east-1";
  // Trim credentials: pasting keys into a deploy UI (Coolify, etc.) commonly
  // appends a trailing space/newline, which the provider rejects with a
  // confusing "InvalidAccessKeyId". S3 keys never contain surrounding
  // whitespace, so trimming is always safe.
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID").trim();
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY").trim();
  // Path-style addressing is required by MinIO and some self-hosted gateways.
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint: normalizeEndpoint(endpoint),
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
    // AWS SDK v3 (>= 3.729) defaults to adding a CRC32 integrity checksum to
    // uploads, sent via `aws-chunked` content-encoding with a streaming
    // trailer (Content-Encoding: aws-chunked + x-amz-trailer). Many
    // S3-compatible providers — notably Hetzner Object Storage — do NOT
    // implement trailing checksums and reject such PutObject requests with a
    // misleading `InvalidAccessKeyId` (the credentials are actually fine; only
    // uploads break, while GET/HEAD/DELETE keep working). Forcing checksums to
    // "WHEN_REQUIRED" disables the default trailer so uploads use a plain
    // signed payload that every S3-compatible store accepts (AWS S3 and MinIO
    // included).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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

function recoveryProbeFailure(error: unknown): RecoveryReadinessCheck {
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = candidate.name || candidate.Code || candidate.code || "unknown";
  const status = candidate.$metadata?.httpStatusCode;
  return {
    status: "unknown",
    detail: status ? `${code} (HTTP ${status})` : code,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

function transportReadiness(
  endpoint: string | undefined,
): RecoveryReadinessCheck {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) {
    return {
      status: "pass",
      detail: "AWS default endpoint uses TLS.",
      value: true,
    };
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "https:") {
      return {
        status: "pass",
        detail: "Storage endpoint uses HTTPS.",
        value: true,
      };
    }
    if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
      return {
        status: "unknown",
        detail: "Loopback HTTP is suitable only for an isolated local drill.",
        value: false,
      };
    }
    return {
      status: "fail",
      detail: "Non-loopback storage endpoint does not use HTTPS.",
      value: false,
    };
  } catch {
    return {
      status: "fail",
      detail: "Storage endpoint URL is invalid.",
      value: false,
    };
  }
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
    await getClient().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
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
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
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
    new Set(
      raw
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),
  );
}

function parseGcsPath(path: string): {
  bucketName: string;
  objectName: string;
} {
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
    file.createReadStream().on("error", reject).on("end", resolve).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export class ObjectStorageService {
  /** Secret-free identity used to prevent recovery into the source store. */
  getRecoveryStorageIdentity(): Record<string, string> {
    if (s3Configured()) {
      return {
        backend: "s3",
        endpoint: normalizeEndpoint(process.env.S3_ENDPOINT) || "aws-default",
        region: process.env.S3_REGION || "us-east-1",
        bucket: getBucket(),
        privatePrefix: getPrivatePrefix(),
      };
    }

    const { bucketName, objectName } = parseGcsPath(gcsPrivateDir());
    return {
      backend: "gcs-replit",
      bucket: bucketName,
      privatePrefix: trimSlashes(objectName),
    };
  }

  /**
   * Read-only provider-policy inspection for recovery release gates. The
   * result intentionally contains no credentials and never mutates bucket
   * policy, retention, encryption, or versioning.
   */
  async inspectRecoveryStorageReadiness(): Promise<RecoveryStorageReadinessInspection> {
    const identity = this.getRecoveryStorageIdentity();
    if (s3Configured()) {
      let bucketAccess: RecoveryReadinessCheck;
      let versioning: RecoveryReadinessCheck;
      let objectLock: RecoveryStorageReadinessInspection["checks"]["objectLock"];
      let encryption: RecoveryReadinessCheck;
      let publicAccessBlock: RecoveryReadinessCheck;

      try {
        await getClient().send(new HeadBucketCommand({ Bucket: getBucket() }));
        bucketAccess = {
          status: "pass",
          detail: "Bucket is reachable.",
          value: true,
        };
      } catch (error) {
        bucketAccess = { ...recoveryProbeFailure(error), status: "fail" };
      }

      try {
        const result = await getClient().send(
          new GetBucketVersioningCommand({ Bucket: getBucket() }),
        );
        const enabled = result.Status === "Enabled";
        versioning = {
          status: enabled ? "pass" : "fail",
          detail: enabled
            ? "Bucket versioning is enabled."
            : "Bucket versioning is not enabled.",
          value: result.Status ?? "Disabled",
        };
      } catch (error) {
        versioning = recoveryProbeFailure(error);
      }

      try {
        const result = await getClient().send(
          new GetObjectLockConfigurationCommand({ Bucket: getBucket() }),
        );
        const retention =
          result.ObjectLockConfiguration?.Rule?.DefaultRetention;
        const defaultRetentionDays =
          typeof retention?.Days === "number"
            ? retention.Days
            : typeof retention?.Years === "number"
              ? retention.Years * 365
              : null;
        const enabled =
          result.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
        objectLock = {
          status: enabled ? "pass" : "fail",
          detail: enabled
            ? "S3 Object Lock capability is enabled."
            : "S3 Object Lock capability is not enabled.",
          value: enabled,
          defaultRetentionDays,
          mode: retention?.Mode ?? null,
        };
      } catch (error) {
        objectLock = {
          ...recoveryProbeFailure(error),
          defaultRetentionDays: null,
          mode: null,
        };
      }

      try {
        const result = await getClient().send(
          new GetBucketEncryptionCommand({ Bucket: getBucket() }),
        );
        const algorithms = (
          result.ServerSideEncryptionConfiguration?.Rules ?? []
        )
          .map((rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm)
          .filter((value) => Boolean(value))
          .map((value) => String(value));
        encryption = {
          status: algorithms.length > 0 ? "pass" : "unknown",
          detail:
            algorithms.length > 0
              ? "Default server-side encryption is configured."
              : "No explicit default encryption rule was returned.",
          value: algorithms.join(",") || null,
        };
      } catch (error) {
        encryption = recoveryProbeFailure(error);
      }

      try {
        const result = await getClient().send(
          new GetPublicAccessBlockCommand({ Bucket: getBucket() }),
        );
        const config = result.PublicAccessBlockConfiguration;
        const blocked = Boolean(
          config?.BlockPublicAcls &&
          config.IgnorePublicAcls &&
          config.BlockPublicPolicy &&
          config.RestrictPublicBuckets,
        );
        publicAccessBlock = {
          status: blocked ? "pass" : "fail",
          detail: blocked
            ? "All S3 public-access-block controls are enabled."
            : "S3 public-access-block controls are incomplete.",
          value: blocked,
        };
      } catch (error) {
        publicAccessBlock = recoveryProbeFailure(error);
      }

      return {
        identity,
        checks: {
          bucketAccess,
          transportSecurity: transportReadiness(process.env.S3_ENDPOINT),
          versioning,
          objectLock,
          encryption,
          publicAccessBlock,
        },
      };
    }

    const { bucketName } = parseGcsPath(gcsPrivateDir());
    try {
      const [rawMetadata] = await getGcsClient()
        .bucket(bucketName)
        .getMetadata();
      const metadata = rawMetadata as unknown as Record<string, unknown>;
      const versioningMetadata = metadata.versioning as
        | { enabled?: boolean }
        | undefined;
      const retention = metadata.retentionPolicy as
        | { isLocked?: boolean; retentionPeriod?: number | string }
        | undefined;
      const iam = metadata.iamConfiguration as
        | { publicAccessPrevention?: string }
        | undefined;
      const encryptionMetadata = metadata.encryption as
        | { defaultKmsKeyName?: string }
        | undefined;
      const retentionSeconds = Number(retention?.retentionPeriod ?? 0);
      const retentionDays = Number.isFinite(retentionSeconds)
        ? retentionSeconds / 86_400
        : null;
      const retentionLocked = retention?.isLocked === true;
      const versioningEnabled = versioningMetadata?.enabled === true;
      const publicAccessPrevented = iam?.publicAccessPrevention === "enforced";
      const kmsKey = encryptionMetadata?.defaultKmsKeyName;
      return {
        identity,
        checks: {
          bucketAccess: {
            status: "pass",
            detail: "Bucket metadata is readable.",
            value: true,
          },
          transportSecurity: {
            status: "pass",
            detail: "GCS API access uses the provider TLS endpoint.",
            value: true,
          },
          versioning: {
            status: versioningEnabled ? "pass" : "fail",
            detail: versioningEnabled
              ? "GCS object versioning is enabled."
              : "GCS object versioning is not enabled.",
            value: versioningEnabled,
          },
          objectLock: {
            status: retentionLocked ? "pass" : "fail",
            detail: retentionLocked
              ? "GCS bucket retention policy is locked."
              : "GCS bucket retention policy is not locked.",
            value: retentionLocked,
            defaultRetentionDays: retentionDays,
            mode: retentionLocked ? "LOCKED" : null,
          },
          encryption: {
            status: kmsKey ? "pass" : "unknown",
            detail: kmsKey
              ? "A default customer-managed encryption key is configured."
              : "No default customer-managed encryption key is visible in bucket metadata.",
            value: kmsKey ? "customer-managed" : null,
          },
          publicAccessBlock: {
            status: publicAccessPrevented ? "pass" : "fail",
            detail: publicAccessPrevented
              ? "GCS public access prevention is enforced."
              : "GCS public access prevention is not enforced.",
            value: publicAccessPrevented,
          },
        },
      };
    } catch (error) {
      const failed = {
        ...recoveryProbeFailure(error),
        status: "fail" as const,
      };
      return {
        identity,
        checks: {
          bucketAccess: failed,
          transportSecurity: {
            status: "pass",
            detail: "GCS API access uses the provider TLS endpoint.",
            value: true,
          },
          versioning: recoveryProbeFailure(error),
          objectLock: {
            ...recoveryProbeFailure(error),
            defaultRetentionDays: null,
            mode: null,
          },
          encryption: recoveryProbeFailure(error),
          publicAccessBlock: recoveryProbeFailure(error),
        },
      };
    }
  }

  /** List every object below the configured private prefix for recovery. */
  async listPrivateObjectsForRecovery(): Promise<
    Array<{ objectPath: string; size: number; lastModified: string | null }>
  > {
    if (s3Configured()) {
      const prefix = `${getPrivatePrefix()}/`;
      const objects: Array<{
        objectPath: string;
        size: number;
        lastModified: string | null;
        snapshotToken?: string;
      }> = [];
      let continuationToken: string | undefined;
      do {
        const page = await getClient().send(
          new ListObjectsV2Command({
            Bucket: getBucket(),
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key || item.Key === prefix) continue;
          const entityId = item.Key.slice(prefix.length);
          if (!entityId) continue;
          objects.push({
            objectPath: `/objects/${entityId}`,
            size: Number(item.Size ?? 0),
            lastModified: item.LastModified?.toISOString() ?? null,
            snapshotToken: item.ETag,
          });
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
        if (page.IsTruncated && !continuationToken) {
          throw new Error(
            "Object inventory pagination ended without a continuation token.",
          );
        }
      } while (continuationToken);
      return objects.sort((a, b) => a.objectPath.localeCompare(b.objectPath));
    }

    const { bucketName, objectName } = parseGcsPath(gcsPrivateDir());
    const prefix = trimSlashes(objectName);
    const keyPrefix = prefix ? `${prefix}/` : "";
    const [files] = await getGcsClient()
      .bucket(bucketName)
      .getFiles({ prefix: keyPrefix });
    const objects = files
      .filter((file) => file.name !== keyPrefix)
      .map((file) => ({
        objectPath: `/objects/${file.name.slice(keyPrefix.length)}`,
        size: Number(file.metadata.size ?? 0),
        lastModified:
          typeof file.metadata.updated === "string"
            ? file.metadata.updated
            : null,
        snapshotToken:
          typeof file.metadata.generation === "string" ||
          typeof file.metadata.generation === "number"
            ? String(file.metadata.generation)
            : undefined,
      }))
      .filter((item) => item.objectPath !== "/objects/");
    return objects.sort((a, b) => a.objectPath.localeCompare(b.objectPath));
  }

  /** True when the current private store already contains the exact path. */
  async privateObjectExists(objectPath: string): Promise<boolean> {
    if (!objectPath.startsWith("/objects/")) return false;
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) return false;
    if (s3Configured())
      return s3ObjectExists(joinKey(getPrivatePrefix(), entityId));

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    const [exists] = await getGcsClient()
      .bucket(bucketName)
      .file(objectName)
      .exists();
    return exists;
  }

  /** Open a bounded-memory recovery read, pinned when the provider exposes a token. */
  async openPrivateObjectRecoveryStream(
    objectPath: string,
    snapshotToken?: string,
  ): Promise<{ body: Readable; contentType: string }> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    if (s3Configured()) {
      const entityId = trimSlashes(objectPath.slice("/objects/".length));
      if (!entityId) throw new ObjectNotFoundError();
      const out = await getClient().send(
        new GetObjectCommand({
          Bucket: getBucket(),
          Key: joinKey(getPrivatePrefix(), entityId),
          IfMatch: snapshotToken,
        }),
      );
      if (!out.Body || !(out.Body instanceof Readable)) {
        throw new ObjectNotFoundError();
      }
      return {
        body: out.Body,
        contentType: out.ContentType || "application/octet-stream",
      };
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    if (snapshotToken && !/^[1-9][0-9]*$/.test(snapshotToken)) {
      throw new Error(`Invalid GCS recovery generation for ${objectPath}.`);
    }
    const file = getGcsClient()
      .bucket(bucketName)
      .file(
        objectName,
        snapshotToken ? { generation: snapshotToken } : undefined,
      );
    const [metadata] = await file.getMetadata();
    return {
      body: file.createReadStream(),
      contentType:
        (metadata.contentType as string) || "application/octet-stream",
    };
  }

  /** Upload a recovery object without buffering it in the API process. */
  async putPrivateObjectRecoveryStream(
    objectPath: string,
    body: Readable,
    contentLength: number,
    contentType: string,
    plaintextSha256: string,
  ): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new Error(
        "putPrivateObjectRecoveryStream requires an /objects/ path",
      );
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId) {
      throw new Error(
        "putPrivateObjectRecoveryStream requires a non-empty path",
      );
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error(
        "putPrivateObjectRecoveryStream requires a valid content length",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(plaintextSha256)) {
      throw new Error(
        "putPrivateObjectRecoveryStream requires a valid SHA-256",
      );
    }

    if (s3Configured()) {
      await getClient().send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: joinKey(getPrivatePrefix(), entityId),
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
          Metadata: {
            sha256: plaintextSha256,
            "upload-status": "stored",
          },
        }),
      );
      return;
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    const output = getGcsClient()
      .bucket(bucketName)
      .file(objectName)
      .createWriteStream({
        contentType,
        resumable: true,
        metadata: {
          metadata: {
            sha256: plaintextSha256,
            uploadStatus: "stored",
          },
        },
      });
    await pipeline(body, output);
  }

  /** Read bytes plus content type so a recovery copy preserves object metadata. */
  async readPrivateObjectForRecovery(
    objectPath: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const opened = await this.openPrivateObjectRecoveryStream(objectPath);
    const chunks: Buffer[] = [];
    for await (const value of opened.body) {
      chunks.push(
        Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array),
      );
    }
    return { body: Buffer.concat(chunks), contentType: opened.contentType };
  }

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
    options: { uploadStatus?: "stored" | "quarantined" } = {},
  ): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new Error("putPrivateObject requires an /objects/ path");
    }
    const entityId = trimSlashes(objectPath.slice("/objects/".length));
    if (!entityId)
      throw new Error("putPrivateObject requires a non-empty path");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const uploadStatus = options.uploadStatus ?? "stored";

    if (s3Configured()) {
      const key = joinKey(getPrivatePrefix(), entityId);
      await getClient().send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          Metadata: {
            sha256,
            "upload-status": uploadStatus,
          },
        }),
      );
      return;
    }

    const { bucketName, objectName } = gcsResolvePrivate(objectPath);
    await getGcsClient()
      .bucket(bucketName)
      .file(objectName)
      .save(body, {
        contentType,
        resumable: false,
        metadata: {
          metadata: {
            sha256,
            uploadStatus,
          },
        },
      });
  }

  /**
   * Read a private object ("/objects/<entityId>") fully into a Buffer. Used by
   * the restore flow, which needs the dump bytes on the local filesystem before
   * handing them to pg_restore. Throws ObjectNotFoundError if missing.
   */
  async getPrivateObjectBuffer(objectPath: string): Promise<Buffer> {
    return (await this.readPrivateObjectForRecovery(objectPath)).body;
  }

  /** Stream a private object ("/objects/<entityId>") to the response. */
  async servePrivateObject(
    objectPath: string,
    res: ExpressResponse,
  ): Promise<void> {
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
  async servePublicObject(
    filePath: string,
    res: ExpressResponse,
  ): Promise<boolean> {
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
      const { bucketName, objectName } = parseGcsPath(
        `${searchPath}/${relative}`,
      );
      const file = getGcsClient().bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        await gcsStreamToResponse(bucketName, objectName, res, {
          isPublic: true,
        });
        return true;
      }
    }
    return false;
  }
}
