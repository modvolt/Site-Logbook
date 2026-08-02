import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkObjectRecoveryBundleFreshness,
  createObjectRecoveryBundle,
  restoreObjectRecoveryBundle,
  verifyObjectRecoveryBundle,
  type ObjectRecoveryStorage,
  type RecoveryStorageIdentity,
} from "../src/lib/object-recovery";
import { evaluateRecoveryStorageReadiness } from "../src/lib/recovery-storage-readiness";
import { describeObjectStorageConfig } from "../src/lib/objectStorage";
import {
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
  encryptBackupArtifactPayload,
} from "../src/lib/secret-envelope";

type StoredObject = { body: Buffer; contentType: string; lastModified: string };

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryRecoveryStorage implements ObjectRecoveryStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly observedUploadChunks: number[] = [];

  constructor(private readonly identity: RecoveryStorageIdentity) {}

  seed(
    objectPath: string,
    body: string | Buffer,
    contentType = "application/octet-stream",
  ): void {
    this.objects.set(objectPath, {
      body: Buffer.isBuffer(body)
        ? Buffer.from(body)
        : Buffer.from(body, "utf8"),
      contentType,
      lastModified: "2026-08-02T00:00:00.000Z",
    });
  }

  getRecoveryStorageIdentity(): RecoveryStorageIdentity {
    return this.identity;
  }

  async listPrivateObjectsForRecovery() {
    return [...this.objects.entries()]
      .map(([objectPath, value]) => ({
        objectPath,
        size: value.body.length,
        lastModified: value.lastModified,
        snapshotToken: sha256(value.body),
      }))
      .reverse();
  }

  async privateObjectExists(objectPath: string): Promise<boolean> {
    return this.objects.has(objectPath);
  }

  async openPrivateObjectRecoveryStream(
    objectPath: string,
    snapshotToken?: string,
  ) {
    const value = this.objects.get(objectPath);
    if (!value) throw new Error(`Missing test object: ${objectPath}`);
    if (snapshotToken && snapshotToken !== sha256(value.body)) {
      throw new Error(`Test object changed: ${objectPath}`);
    }
    async function* chunks(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < value.body.length; offset += 64 * 1024) {
        yield Buffer.from(value.body.subarray(offset, offset + 64 * 1024));
      }
    }
    return {
      body: Readable.from(chunks(), { objectMode: false }),
      contentType: value.contentType,
    };
  }

  async putPrivateObjectRecoveryStream(
    objectPath: string,
    body: Readable,
    contentLength: number,
    contentType: string,
    plaintextSha256: string,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value)
        ? Buffer.from(value)
        : Buffer.from(value as Uint8Array);
      this.observedUploadChunks.push(chunk.length);
      chunks.push(chunk);
    }
    const stored = Buffer.concat(chunks);
    if (stored.length !== contentLength || sha256(stored) !== plaintextSha256) {
      throw new Error("Test recovery upload integrity mismatch.");
    }
    this.objects.set(objectPath, {
      body: stored,
      contentType,
      lastModified: "2026-08-02T00:01:00.000Z",
    });
  }
}

const originalEnv = { ...process.env };
let tempRoot: string;

beforeEach(async () => {
  process.env[BACKUP_ACTIVE_KEY_ENV] = "recovery-test";
  process.env[BACKUP_KEYRING_ENV] = JSON.stringify({
    "recovery-test": randomBytes(32).toString("base64"),
  });
  tempRoot = await mkdtemp(join(tmpdir(), "modvolt-object-recovery-test-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(tempRoot, { recursive: true, force: true });
});

describe("encrypted object recovery bundles", () => {
  it("creates a deterministic encrypted v2 inventory and verifies every chunk", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source-test",
      privatePrefix: "private",
    });
    source.seed("/objects/photos/z.jpg", "secret-photo-bytes", "image/jpeg");
    source.seed(
      "/objects/documents/a.pdf",
      "secret-pdf-bytes",
      "application/pdf",
    );
    const bundleDir = join(tempRoot, "bundle");

    const created = await createObjectRecoveryBundle(source, bundleDir, {
      chunkSizeBytes: 8,
    });
    const verified = await verifyObjectRecoveryBundle(bundleDir);

    expect(created.objectCount).toBe(2);
    expect(verified).toEqual(created);
    const descriptor = await readFile(join(bundleDir, "bundle.json"), "utf8");
    const manifest = await readFile(join(bundleDir, "manifest.mve1"));
    const firstPayload = await readFile(
      join(bundleDir, "objects", "00000001", "00000001.mve1"),
    );
    const combined = Buffer.concat([
      Buffer.from(descriptor, "utf8"),
      manifest,
      firstPayload,
    ]).toString("utf8");
    expect(combined).not.toContain("secret-photo-bytes");
    expect(combined).not.toContain("secret-pdf-bytes");
    expect(descriptor).not.toContain("source-test");
    expect(JSON.parse(descriptor)).toMatchObject({
      schema: "modvolt-object-recovery/v2",
      chunkSizeBytes: 8,
    });
  });

  it("restores exact paths, bytes, and content types only into a distinct empty store", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
      privatePrefix: "private",
      endpoint: "http://localhost:9000",
    });
    source.seed("/objects/job-files/report.pdf", "report", "application/pdf");
    source.seed("/objects/signatures/signature.png", "signature", "image/png");
    const bundleDir = join(tempRoot, "bundle");
    await createObjectRecoveryBundle(source, bundleDir, { chunkSizeBytes: 4 });

    await expect(
      restoreObjectRecoveryBundle(source, bundleDir, {
        confirmIsolatedTarget: true,
      }),
    ).rejects.toThrow(/source object store/i);
    const aliasOfSource = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
      privatePrefix: "private",
      endpoint: "http://127.0.0.1:9000",
    });
    await expect(
      restoreObjectRecoveryBundle(aliasOfSource, bundleDir, {
        confirmIsolatedTarget: true,
      }),
    ).rejects.toThrow(/source object store/i);
    const target = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "target",
    });
    const restored = await restoreObjectRecoveryBundle(target, bundleDir, {
      confirmIsolatedTarget: true,
    });

    expect(restored.restoredObjects).toBe(2);
    expect(
      target.objects.get("/objects/job-files/report.pdf")?.body.toString(),
    ).toBe("report");
    expect(
      target.objects.get("/objects/job-files/report.pdf")?.contentType,
    ).toBe("application/pdf");
    expect(
      target.objects.get("/objects/signatures/signature.png")?.body.toString(),
    ).toBe("signature");
  });

  it("streams a large object as bounded encrypted and restore chunks", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source-large",
    });
    const large = Buffer.alloc(20 * 1024 * 1024 + 137, 0x5a);
    source.seed(
      "/objects/backups/large.dump",
      large,
      "application/octet-stream",
    );
    const bundleDir = join(tempRoot, "large-bundle");
    const chunkSizeBytes = 1024 * 1024;

    await createObjectRecoveryBundle(source, bundleDir, { chunkSizeBytes });
    const objectFiles = await readdir(join(bundleDir, "objects", "00000001"));
    expect(objectFiles).toHaveLength(21);
    const target = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "target-large",
    });
    await restoreObjectRecoveryBundle(target, bundleDir, {
      confirmIsolatedTarget: true,
    });

    expect(
      sha256(
        target.objects.get("/objects/backups/large.dump")?.body ??
          Buffer.alloc(0),
      ),
    ).toBe(sha256(large));
    expect(Math.max(...target.observedUploadChunks)).toBeLessThanOrEqual(
      chunkSizeBytes,
    );
    large.fill(0);
  });

  it("refuses restore without confirmation or when any target path already exists", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
    });
    source.seed("/objects/photos/a.jpg", "new-photo", "image/jpeg");
    const bundleDir = join(tempRoot, "bundle");
    await createObjectRecoveryBundle(source, bundleDir);
    const target = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "target",
    });

    await expect(
      restoreObjectRecoveryBundle(target, bundleDir, {
        confirmIsolatedTarget: false,
      }),
    ).rejects.toThrow(/explicit isolated-target confirmation/i);
    target.seed("/objects/unrelated/must-survive.bin", "must-survive");
    await expect(
      restoreObjectRecoveryBundle(target, bundleDir, {
        confirmIsolatedTarget: true,
      }),
    ).rejects.toThrow(/private prefix is not empty/i);
    expect(
      target.objects
        .get("/objects/unrelated/must-survive.bin")
        ?.body.toString(),
    ).toBe("must-survive");
  });

  it("fails closed when an encrypted object chunk is modified", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
    });
    source.seed("/objects/attachments/a.bin", "evidence");
    const bundleDir = join(tempRoot, "bundle");
    await createObjectRecoveryBundle(source, bundleDir);
    const payloadPath = join(bundleDir, "objects", "00000001", "00000001.mve1");
    const payload = await readFile(payloadPath);
    payload[payload.length - 1] ^= 1;
    await writeFile(payloadPath, payload);

    await expect(verifyObjectRecoveryBundle(bundleDir)).rejects.toThrow(
      /checksum mismatch/i,
    );
  });

  it("removes a partial bundle when inventory bytes change during snapshot", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
    });
    source.seed("/objects/photos/a.jpg", "original");
    const originalList = source.listPrivateObjectsForRecovery.bind(source);
    source.listPrivateObjectsForRecovery = async () => {
      const inventory = await originalList();
      inventory[0].size += 1;
      return inventory;
    };
    const bundleDir = join(tempRoot, "partial");

    await expect(createObjectRecoveryBundle(source, bundleDir)).rejects.toThrow(
      /changed during recovery snapshot/i,
    );
    await expect(
      readFile(join(bundleDir, "bundle.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps legacy v1 bundles verifiable and restorable", async () => {
    const bundleId = randomUUID();
    const createdAt = "2026-08-02T00:00:00.000Z";
    const objectPath = "/objects/legacy/a.bin";
    const plaintext = Buffer.from("legacy-secret", "utf8");
    const objectPathHash = sha256(objectPath);
    const encrypted = encryptBackupArtifactPayload(
      plaintext,
      `object_recovery:${bundleId}:object:${objectPathHash}`,
    );
    const bundleDir = join(tempRoot, "legacy");
    await mkdir(join(bundleDir, "objects"), { recursive: true });
    await writeFile(
      join(bundleDir, "objects", "00000001.mve1"),
      encrypted.payload,
    );
    const manifest = {
      schema: "modvolt-object-recovery/v1",
      bundleId,
      createdAt,
      sourceStorage: { backend: "s3", bucket: "legacy-source" },
      objectCount: 1,
      totalPlaintextBytes: plaintext.length,
      entries: [
        {
          objectPath,
          payloadFile: "objects/00000001.mve1",
          plaintextSha256: sha256(plaintext),
          encryptedSha256: sha256(encrypted.payload),
          size: plaintext.length,
          encryptedSize: encrypted.payload.length,
          contentType: "application/octet-stream",
          sourceLastModified: null,
        },
      ],
    };
    const encryptedManifest = encryptBackupArtifactPayload(
      Buffer.from(JSON.stringify(manifest), "utf8"),
      `object_recovery:${bundleId}:manifest`,
    );
    await writeFile(
      join(bundleDir, "manifest.mve1"),
      encryptedManifest.payload,
    );
    await writeFile(
      join(bundleDir, "bundle.json"),
      JSON.stringify({
        schema: "modvolt-object-recovery/v1",
        bundleId,
        createdAt,
        manifestFile: "manifest.mve1",
        encryptedManifestSha256: sha256(encryptedManifest.payload),
        encryptionFormat: "mve1",
        encryptionKeyId: encryptedManifest.keyId,
        objectCount: 1,
        totalPlaintextBytes: plaintext.length,
      }),
    );

    await expect(verifyObjectRecoveryBundle(bundleDir)).resolves.toMatchObject({
      objectCount: 1,
    });
    const target = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "legacy-target",
    });
    await restoreObjectRecoveryBundle(target, bundleDir, {
      confirmIsolatedTarget: true,
    });
    expect(target.objects.get(objectPath)?.body.toString("utf8")).toBe(
      "legacy-secret",
    );
    plaintext.fill(0);
    encrypted.payload.fill(0);
    encryptedManifest.payload.fill(0);
  });

  it("authenticates freshness and fails stale bundles closed", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
    });
    source.seed("/objects/a.bin", "fresh");
    const bundleDir = join(tempRoot, "freshness");
    const created = await createObjectRecoveryBundle(source, bundleDir);

    const fresh = await checkObjectRecoveryBundleFreshness(
      bundleDir,
      2,
      new Date(Date.parse(created.createdAt) + 3_600_000),
    );
    const stale = await checkObjectRecoveryBundleFreshness(
      bundleDir,
      2,
      new Date(Date.parse(created.createdAt) + 3 * 3_600_000),
    );
    expect(fresh.fresh).toBe(true);
    expect(stale.fresh).toBe(false);
  });

  it("evaluates storage policy requirements without mutating the provider", () => {
    const result = evaluateRecoveryStorageReadiness(
      {
        identity: {
          backend: "s3",
          bucket: "offsite-test",
          privatePrefix: "private",
        },
        checks: {
          bucketAccess: { status: "pass", detail: "reachable" },
          transportSecurity: { status: "pass", detail: "HTTPS" },
          versioning: { status: "pass", detail: "enabled" },
          objectLock: {
            status: "pass",
            detail: "enabled",
            defaultRetentionDays: 7,
            mode: "GOVERNANCE",
          },
          encryption: {
            status: "unknown",
            detail: "provider did not expose it",
          },
          publicAccessBlock: {
            status: "unknown",
            detail: "provider did not expose it",
          },
        },
      },
      {
        requireVersioning: true,
        requireObjectLock: true,
        minimumDefaultRetentionDays: 14,
        requireEncryption: true,
        requirePublicAccessBlock: true,
      },
    );

    expect(result.ready).toBe(false);
    expect(result.violations).toEqual([
      "default_retention_too_short_or_unknown",
      "default_encryption_not_proven",
      "public_access_block_not_proven",
    ]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses endpoint userinfo before it can leak through recovery identity", () => {
    process.env.S3_BUCKET = "phase12-test";
    process.env.S3_ACCESS_KEY_ID = "test-access";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_ENDPOINT =
      "https://embedded-user:embedded-password@example.invalid";

    expect(() => describeObjectStorageConfig()).toThrow(
      /must not contain embedded credentials/i,
    );
  });
});
