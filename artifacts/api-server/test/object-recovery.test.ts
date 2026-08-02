import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createObjectRecoveryBundle,
  restoreObjectRecoveryBundle,
  verifyObjectRecoveryBundle,
  type ObjectRecoveryStorage,
  type RecoveryStorageIdentity,
} from "../src/lib/object-recovery";
import {
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
} from "../src/lib/secret-envelope";

type StoredObject = { body: Buffer; contentType: string; lastModified: string };

class MemoryRecoveryStorage implements ObjectRecoveryStorage {
  readonly objects = new Map<string, StoredObject>();

  constructor(private readonly identity: RecoveryStorageIdentity) {}

  seed(objectPath: string, body: string, contentType = "application/octet-stream"): void {
    this.objects.set(objectPath, {
      body: Buffer.from(body, "utf8"),
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
      }))
      .reverse();
  }

  async privateObjectExists(objectPath: string): Promise<boolean> {
    return this.objects.has(objectPath);
  }

  async readPrivateObjectForRecovery(objectPath: string) {
    const value = this.objects.get(objectPath);
    if (!value) throw new Error(`Missing test object: ${objectPath}`);
    return { body: Buffer.from(value.body), contentType: value.contentType };
  }

  async putPrivateObject(
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    this.objects.set(objectPath, {
      body: Buffer.from(body),
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
  it("creates a deterministic encrypted inventory and verifies every payload", async () => {
    const source = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source-test",
      privatePrefix: "private",
    });
    source.seed("/objects/photos/z.jpg", "secret-photo-bytes", "image/jpeg");
    source.seed("/objects/documents/a.pdf", "secret-pdf-bytes", "application/pdf");
    const bundleDir = join(tempRoot, "bundle");

    const created = await createObjectRecoveryBundle(source, bundleDir);
    const verified = await verifyObjectRecoveryBundle(bundleDir);

    expect(created.objectCount).toBe(2);
    expect(verified).toEqual(created);
    const descriptor = await readFile(join(bundleDir, "bundle.json"), "utf8");
    const manifest = await readFile(join(bundleDir, "manifest.mve1"));
    const firstPayload = await readFile(join(bundleDir, "objects", "00000001.mve1"));
    const combined = Buffer.concat([
      Buffer.from(descriptor, "utf8"),
      manifest,
      firstPayload,
    ]).toString("utf8");
    expect(combined).not.toContain("secret-photo-bytes");
    expect(combined).not.toContain("secret-pdf-bytes");
    expect(descriptor).not.toContain("source-test");
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
    await createObjectRecoveryBundle(source, bundleDir);

    await expect(
      restoreObjectRecoveryBundle(source, bundleDir, { confirmIsolatedTarget: true }),
    ).rejects.toThrow(/source object store/i);
    const aliasOfSource = new MemoryRecoveryStorage({
      backend: "s3",
      bucket: "source",
      privatePrefix: "private",
      endpoint: "http://127.0.0.1:9000",
    });
    await expect(
      restoreObjectRecoveryBundle(aliasOfSource, bundleDir, { confirmIsolatedTarget: true }),
    ).rejects.toThrow(/source object store/i);
    const target = new MemoryRecoveryStorage({ backend: "s3", bucket: "target" });
    const restored = await restoreObjectRecoveryBundle(target, bundleDir, {
      confirmIsolatedTarget: true,
    });

    expect(restored.restoredObjects).toBe(2);
    expect(target.objects.get("/objects/job-files/report.pdf")?.body.toString()).toBe("report");
    expect(target.objects.get("/objects/job-files/report.pdf")?.contentType).toBe(
      "application/pdf",
    );
    expect(target.objects.get("/objects/signatures/signature.png")?.body.toString()).toBe(
      "signature",
    );
  });

  it("refuses restore without confirmation or when any target path already exists", async () => {
    const source = new MemoryRecoveryStorage({ backend: "s3", bucket: "source" });
    source.seed("/objects/photos/a.jpg", "new-photo", "image/jpeg");
    const bundleDir = join(tempRoot, "bundle");
    await createObjectRecoveryBundle(source, bundleDir);
    const target = new MemoryRecoveryStorage({ backend: "s3", bucket: "target" });

    await expect(
      restoreObjectRecoveryBundle(target, bundleDir, { confirmIsolatedTarget: false }),
    ).rejects.toThrow(/explicit isolated-target confirmation/i);
    target.seed("/objects/unrelated/must-survive.bin", "must-survive");
    await expect(
      restoreObjectRecoveryBundle(target, bundleDir, { confirmIsolatedTarget: true }),
    ).rejects.toThrow(/private prefix is not empty/i);
    expect(
      target.objects.get("/objects/unrelated/must-survive.bin")?.body.toString(),
    ).toBe("must-survive");
  });

  it("fails closed when an encrypted object payload is modified", async () => {
    const source = new MemoryRecoveryStorage({ backend: "s3", bucket: "source" });
    source.seed("/objects/attachments/a.bin", "evidence");
    const bundleDir = join(tempRoot, "bundle");
    await createObjectRecoveryBundle(source, bundleDir);
    const payloadPath = join(bundleDir, "objects", "00000001.mve1");
    const payload = await readFile(payloadPath);
    payload[payload.length - 1] ^= 1;
    await writeFile(payloadPath, payload);

    await expect(verifyObjectRecoveryBundle(bundleDir)).rejects.toThrow(/checksum mismatch/i);
  });

  it("removes a partial bundle when inventory bytes change during snapshot", async () => {
    const source = new MemoryRecoveryStorage({ backend: "s3", bucket: "source" });
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
    await expect(readFile(join(bundleDir, "bundle.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
