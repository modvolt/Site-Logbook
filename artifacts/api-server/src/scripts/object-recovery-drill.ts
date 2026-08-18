import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  checkObjectRecoveryBundleFreshness,
  createObjectRecoveryBundle,
  recoveryStorageFingerprint,
  restoreObjectRecoveryBundle,
} from "../lib/object-recovery";
import { ObjectStorageService } from "../lib/objectStorage";
import { evaluateRecoveryStorageReadiness } from "../lib/recovery-storage-readiness";
import {
  DB_BACKED_PRIVATE_OBJECT_PREFIXES,
  TYPED_ONLY_PRIVATE_OBJECT_PREFIXES,
} from "../lib/private-object-policy";
import {
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
} from "../lib/secret-envelope";

const LARGE_OBJECT_BYTES = 64 * 1024 * 1024 + 257;
const RECOVERY_CHUNK_BYTES = 8 * 1024 * 1024;
const STREAM_BLOCK_BYTES = 64 * 1024;
const PRIVATE_PREFIX = "private";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function assertSafeEnvironment(endpoint: string): URL {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.OBJECT_RECOVERY_DRILL_CONFIRM_ISOLATED !== "true"
  ) {
    throw new Error(
      "Recovery drill requires NODE_ENV=test and " +
        "OBJECT_RECOVERY_DRILL_CONFIRM_ISOLATED=true.",
    );
  }
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || !isLoopback(parsed.hostname)) {
    throw new Error("Recovery drill endpoint must be isolated loopback HTTP.");
  }
  return parsed;
}

function deterministicStream(size: number, byte: number): Readable {
  async function* blocks(): AsyncGenerator<Buffer> {
    let remaining = size;
    while (remaining > 0) {
      const length = Math.min(remaining, STREAM_BLOCK_BYTES);
      yield Buffer.alloc(length, byte);
      remaining -= length;
    }
  }
  return Readable.from(blocks(), { objectMode: false });
}

function deterministicHash(size: number, byte: number): string {
  const hash = createHash("sha256");
  let remaining = size;
  while (remaining > 0) {
    const length = Math.min(remaining, STREAM_BLOCK_BYTES);
    hash.update(Buffer.alloc(length, byte));
    remaining -= length;
  }
  return hash.digest("hex");
}

async function hashS3Object(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ size: number; sha256: string; contentType: string }> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body || !(result.Body instanceof Readable)) {
    throw new Error(`Drill object is unreadable: ${key}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const value of result.Body) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    size += chunk.length;
    hash.update(chunk);
  }
  return {
    size,
    sha256: hash.digest("hex"),
    contentType: result.ContentType || "application/octet-stream",
  };
}

async function emptyVersionedBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    const objects = [
      ...(page.Versions ?? []).map((item) => ({
        Key: item.Key,
        VersionId: item.VersionId,
      })),
      ...(page.DeleteMarkers ?? []).map((item) => ({
        Key: item.Key,
        VersionId: item.VersionId,
      })),
    ].filter((item): item is { Key: string; VersionId: string } =>
      Boolean(item.Key && item.VersionId),
    );
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    if (page.IsTruncated && !keyMarker) {
      throw new Error(
        "Versioned bucket cleanup pagination ended without a key marker.",
      );
    }
  } while (keyMarker);
}

async function removeBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await emptyVersionedBucket(client, bucket);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status !== 404) throw error;
  }
}

function configureApplicationStorage(
  endpoint: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
): void {
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_BUCKET = bucket;
  process.env.S3_ACCESS_KEY_ID = accessKeyId;
  process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
  process.env.S3_FORCE_PATH_STYLE = "true";
  process.env.S3_PRIVATE_PREFIX = PRIVATE_PREFIX;
}

async function main(): Promise<void> {
  const endpoint = requireEnv("OBJECT_RECOVERY_DRILL_ENDPOINT");
  assertSafeEnvironment(endpoint);
  const accessKeyId = requireEnv("OBJECT_RECOVERY_DRILL_ACCESS_KEY");
  const secretAccessKey = requireEnv("OBJECT_RECOVERY_DRILL_SECRET_KEY");
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const sourceBucket = `modvolt-phase12-source-test-${tag}`;
  const targetBucket = `modvolt-phase12-target-test-${tag}`;
  const bundleRoot = await mkdtemp(join(tmpdir(), "modvolt-phase12-recovery-"));
  const bundleDir = join(bundleRoot, "bundle");
  const startedAt = Date.now();
  let peakRssBytes = process.memoryUsage().rss;
  const memorySampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 20);
  memorySampler.unref();

  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const expected = new Map<
    string,
    { size: number; sha256: string; contentType: string }
  >();

  process.env[BACKUP_ACTIVE_KEY_ENV] = "phase12-drill";
  process.env[BACKUP_KEYRING_ENV] = JSON.stringify({
    "phase12-drill": randomBytes(32).toString("base64"),
  });

  try {
    for (const bucket of [sourceBucket, targetBucket]) {
      await client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ObjectLockEnabledForBucket: true,
        }),
      );
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
    }

    const prefixes = [
      ...DB_BACKED_PRIVATE_OBJECT_PREFIXES,
      ...TYPED_ONLY_PRIVATE_OBJECT_PREFIXES,
    ];
    for (const prefix of prefixes) {
      const key = `${PRIVATE_PREFIX}/${prefix}/${tag}.canary`;
      const body = Buffer.from(
        `phase12-recovery-canary:${prefix}:${tag}`,
        "utf8",
      );
      const contentType = prefix.includes("signature")
        ? "image/png"
        : "application/octet-stream";
      await client.send(
        new PutObjectCommand({
          Bucket: sourceBucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: contentType,
        }),
      );
      expected.set(key, {
        size: body.length,
        sha256: sha256Buffer(body),
        contentType,
      });
      body.fill(0);
    }

    const largeKey = `${PRIVATE_PREFIX}/backups/${tag}.large`;
    await client.send(
      new PutObjectCommand({
        Bucket: sourceBucket,
        Key: largeKey,
        Body: deterministicStream(LARGE_OBJECT_BYTES, 0x5a),
        ContentLength: LARGE_OBJECT_BYTES,
        ContentType: "application/octet-stream",
      }),
    );
    expected.set(largeKey, {
      size: LARGE_OBJECT_BYTES,
      sha256: deterministicHash(LARGE_OBJECT_BYTES, 0x5a),
      contentType: "application/octet-stream",
    });

    configureApplicationStorage(
      endpoint,
      sourceBucket,
      accessKeyId,
      secretAccessKey,
    );
    const sourceStorage = new ObjectStorageService();
    const sourcePreflight = evaluateRecoveryStorageReadiness(
      await sourceStorage.inspectRecoveryStorageReadiness(),
      {
        allowInsecureLoopback: true,
        requireVersioning: true,
        requireObjectLock: true,
      },
    );
    if (!sourcePreflight.ready) {
      throw new Error(
        `Source preflight failed: ${sourcePreflight.violations.join(",")}`,
      );
    }

    const created = await createObjectRecoveryBundle(sourceStorage, bundleDir, {
      chunkSizeBytes: RECOVERY_CHUNK_BYTES,
    });
    const freshness = await checkObjectRecoveryBundleFreshness(bundleDir, 1);
    if (!freshness.fresh)
      throw new Error("Fresh recovery bundle was reported as stale.");

    configureApplicationStorage(
      endpoint,
      targetBucket,
      accessKeyId,
      secretAccessKey,
    );
    const targetStorage = new ObjectStorageService();
    const targetIdentity = targetStorage.getRecoveryStorageIdentity();
    const targetPreflight = evaluateRecoveryStorageReadiness(
      await targetStorage.inspectRecoveryStorageReadiness(),
      {
        expectedFingerprint: recoveryStorageFingerprint(targetIdentity),
        allowInsecureLoopback: true,
        requireVersioning: true,
        requireObjectLock: true,
      },
    );
    if (!targetPreflight.ready) {
      throw new Error(
        `Target preflight failed: ${targetPreflight.violations.join(",")}`,
      );
    }

    const restored = await restoreObjectRecoveryBundle(
      targetStorage,
      bundleDir,
      {
        confirmIsolatedTarget: true,
      },
    );
    let verifiedObjects = 0;
    for (const [key, source] of expected) {
      const target = await hashS3Object(client, targetBucket, key);
      if (
        target.size !== source.size ||
        target.sha256 !== source.sha256 ||
        target.contentType !== source.contentType
      ) {
        throw new Error(`Restored S3 object differs from source: ${key}`);
      }
      const head = await client.send(
        new HeadObjectCommand({ Bucket: targetBucket, Key: key }),
      );
      if (head.Metadata?.sha256 !== source.sha256) {
        throw new Error(`Restored S3 object SHA-256 metadata differs: ${key}`);
      }
      verifiedObjects += 1;
    }

    clearInterval(memorySampler);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    process.stdout.write(
      `${JSON.stringify(
        {
          drill: "modvolt-object-recovery/phase12",
          endpointClass: "loopback-isolated",
          sourceBucket,
          targetBucket,
          bundleSchema: "modvolt-object-recovery/v2",
          protectedPrefixes: prefixes.length,
          objectCount: created.objectCount,
          restoredObjects: restored.restoredObjects,
          verifiedObjects,
          largeObjectBytes: LARGE_OBJECT_BYTES,
          recoveryChunkBytes: RECOVERY_CHUNK_BYTES,
          recoveryPointAgeSeconds: freshness.ageHours * 3_600,
          recoveryTimeSeconds: (Date.now() - startedAt) / 1_000,
          peakRssBytes,
          sourcePreflight: sourcePreflight.ready,
          targetPreflight: targetPreflight.ready,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    clearInterval(memorySampler);
    await rm(bundleRoot, { recursive: true, force: true });
    await removeBucket(client, sourceBucket);
    await removeBucket(client, targetBucket);
    client.destroy();
    delete process.env[BACKUP_ACTIVE_KEY_ENV];
    delete process.env[BACKUP_KEYRING_ENV];
  }
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Object recovery drill failed: ${message}\n`);
  process.exitCode = 1;
});
