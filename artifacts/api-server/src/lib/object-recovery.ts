import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  decryptBackupArtifactPayload,
  encryptBackupArtifactPayload,
} from "./secret-envelope";

const DESCRIPTOR_FILE = "bundle.json";
const MANIFEST_FILE = "manifest.mve1";
const BUNDLE_SCHEMA = "modvolt-object-recovery/v1";
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUNDLE_ID_PATTERN = /^[a-f0-9-]{36}$/;

export type RecoveryStorageIdentity = Record<string, string>;

export interface ObjectRecoveryStorage {
  getRecoveryStorageIdentity(): RecoveryStorageIdentity;
  listPrivateObjectsForRecovery(): Promise<
    Array<{ objectPath: string; size: number; lastModified: string | null }>
  >;
  privateObjectExists(objectPath: string): Promise<boolean>;
  readPrivateObjectForRecovery(
    objectPath: string,
  ): Promise<{ body: Buffer; contentType: string }>;
  putPrivateObject(
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
}

type RecoveryEntry = {
  objectPath: string;
  payloadFile: string;
  plaintextSha256: string;
  encryptedSha256: string;
  size: number;
  encryptedSize: number;
  contentType: string;
  sourceLastModified: string | null;
};

type RecoveryManifest = {
  schema: typeof BUNDLE_SCHEMA;
  bundleId: string;
  createdAt: string;
  sourceStorage: RecoveryStorageIdentity;
  objectCount: number;
  totalPlaintextBytes: number;
  entries: RecoveryEntry[];
};

type RecoveryDescriptor = {
  schema: typeof BUNDLE_SCHEMA;
  bundleId: string;
  createdAt: string;
  manifestFile: typeof MANIFEST_FILE;
  encryptedManifestSha256: string;
  encryptionFormat: "mve1";
  encryptionKeyId: string;
  objectCount: number;
  totalPlaintextBytes: number;
};

export type RecoveryBundleSummary = {
  bundleId: string;
  createdAt: string;
  objectCount: number;
  totalPlaintextBytes: number;
  sourceStorage: RecoveryStorageIdentity;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableIdentity(identity: RecoveryStorageIdentity): RecoveryStorageIdentity {
  return Object.fromEntries(
    Object.entries(identity)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function recoveryStorageFingerprint(identity: RecoveryStorageIdentity): string {
  return sha256(Buffer.from(JSON.stringify(stableIdentity(identity)), "utf8"));
}

function identitiesMatch(a: RecoveryStorageIdentity, b: RecoveryStorageIdentity): boolean {
  const left = stableIdentity(a);
  const right = stableIdentity(b);
  const sameStorageNamespace = ["backend", "bucket", "privatePrefix"].every(
    (key) => left[key] !== undefined && left[key] === right[key],
  );
  return (
    sameStorageNamespace ||
    JSON.stringify(left) === JSON.stringify(right)
  );
}

function validateObjectPath(objectPath: string): void {
  if (
    !objectPath.startsWith("/objects/") ||
    objectPath.length > 2_048 ||
    objectPath.includes("\\") ||
    objectPath.includes("\0") ||
    objectPath.split("/").some((part) => part === "." || part === "..") ||
    objectPath === "/objects/"
  ) {
    throw new Error(`Invalid private object path in recovery inventory: ${objectPath}`);
  }
}

function objectContext(bundleId: string, objectPath: string): string {
  return `object_recovery:${bundleId}:object:${sha256(Buffer.from(objectPath, "utf8"))}`;
}

function manifestContext(bundleId: string): string {
  return `object_recovery:${bundleId}:manifest`;
}

function assertSafePayloadFile(payloadFile: string, index: number): void {
  const expected = `objects/${String(index + 1).padStart(8, "0")}.mve1`;
  if (payloadFile !== expected) {
    throw new Error(`Recovery manifest contains an invalid payload path: ${payloadFile}`);
  }
}

function assertDescriptor(value: unknown): asserts value is RecoveryDescriptor {
  const descriptor = value as Partial<RecoveryDescriptor> | null;
  if (
    !descriptor ||
    descriptor.schema !== BUNDLE_SCHEMA ||
    typeof descriptor.bundleId !== "string" ||
    !BUNDLE_ID_PATTERN.test(descriptor.bundleId) ||
    typeof descriptor.createdAt !== "string" ||
    descriptor.manifestFile !== MANIFEST_FILE ||
    typeof descriptor.encryptedManifestSha256 !== "string" ||
    !SHA256_PATTERN.test(descriptor.encryptedManifestSha256) ||
    descriptor.encryptionFormat !== "mve1" ||
    typeof descriptor.encryptionKeyId !== "string" ||
    !Number.isInteger(descriptor.objectCount) ||
    (descriptor.objectCount ?? -1) < 0 ||
    !Number.isSafeInteger(descriptor.totalPlaintextBytes) ||
    (descriptor.totalPlaintextBytes ?? -1) < 0
  ) {
    throw new Error("Recovery bundle descriptor is invalid.");
  }
}

function assertManifest(
  value: unknown,
  descriptor: RecoveryDescriptor,
): asserts value is RecoveryManifest {
  const manifest = value as Partial<RecoveryManifest> | null;
  if (
    !manifest ||
    manifest.schema !== BUNDLE_SCHEMA ||
    manifest.bundleId !== descriptor.bundleId ||
    manifest.createdAt !== descriptor.createdAt ||
    !manifest.sourceStorage ||
    typeof manifest.sourceStorage !== "object" ||
    Array.isArray(manifest.sourceStorage) ||
    !Array.isArray(manifest.entries) ||
    manifest.objectCount !== descriptor.objectCount ||
    manifest.entries.length !== descriptor.objectCount ||
    manifest.totalPlaintextBytes !== descriptor.totalPlaintextBytes
  ) {
    throw new Error("Recovery bundle manifest is invalid.");
  }

  const objectPaths = new Set<string>();
  let total = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }
    validateObjectPath(entry.objectPath);
    assertSafePayloadFile(entry.payloadFile, index);
    if (
      objectPaths.has(entry.objectPath) ||
      !SHA256_PATTERN.test(entry.plaintextSha256) ||
      !SHA256_PATTERN.test(entry.encryptedSha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isSafeInteger(entry.encryptedSize) ||
      entry.encryptedSize < 1 ||
      typeof entry.contentType !== "string" ||
      entry.contentType.length < 1 ||
      entry.contentType.length > 255 ||
      (entry.sourceLastModified !== null && typeof entry.sourceLastModified !== "string")
    ) {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }
    objectPaths.add(entry.objectPath);
    total += entry.size;
  }
  if (!Number.isSafeInteger(total) || total !== manifest.totalPlaintextBytes) {
    throw new Error("Recovery bundle manifest byte total is invalid.");
  }
}

async function readBundle(bundleDir: string): Promise<{
  descriptor: RecoveryDescriptor;
  manifest: RecoveryManifest;
}> {
  const descriptorPath = join(resolve(bundleDir), DESCRIPTOR_FILE);
  const descriptorStat = await stat(descriptorPath);
  if (!descriptorStat.isFile() || descriptorStat.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Recovery bundle descriptor is missing or too large.");
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as unknown;
  assertDescriptor(descriptor);

  const encryptedManifest = await readFile(join(resolve(bundleDir), descriptor.manifestFile));
  try {
    if (sha256(encryptedManifest) !== descriptor.encryptedManifestSha256) {
      throw new Error("Encrypted recovery manifest checksum mismatch.");
    }
    const plaintextManifest = decryptBackupArtifactPayload(
      encryptedManifest,
      manifestContext(descriptor.bundleId),
    );
    try {
      const manifest = JSON.parse(plaintextManifest.toString("utf8")) as unknown;
      assertManifest(manifest, descriptor);
      return { descriptor, manifest };
    } finally {
      plaintextManifest.fill(0);
    }
  } finally {
    encryptedManifest.fill(0);
  }
}

export async function createObjectRecoveryBundle(
  storage: ObjectRecoveryStorage,
  outputDir: string,
): Promise<RecoveryBundleSummary> {
  if (!isAbsolute(outputDir)) {
    throw new Error("Recovery bundle output directory must be an absolute path.");
  }
  const resolvedOutput = resolve(outputDir);
  const bundleId = randomUUID();
  const createdAt = new Date().toISOString();
  let outputCreated = false;

  try {
    await mkdir(resolvedOutput, { mode: 0o700 });
    outputCreated = true;
    await mkdir(join(resolvedOutput, "objects"));

    const inventory = await storage.listPrivateObjectsForRecovery();
    const seen = new Set<string>();
    for (const item of inventory) {
      validateObjectPath(item.objectPath);
      if (seen.has(item.objectPath)) {
        throw new Error(`Duplicate private object path in inventory: ${item.objectPath}`);
      }
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        throw new Error(`Invalid object size in recovery inventory: ${item.objectPath}`);
      }
      seen.add(item.objectPath);
    }
    inventory.sort((a, b) => a.objectPath.localeCompare(b.objectPath));

    const entries: RecoveryEntry[] = [];
    let totalPlaintextBytes = 0;
    for (const [index, item] of inventory.entries()) {
      const { body, contentType } = await storage.readPrivateObjectForRecovery(item.objectPath);
      try {
        if (body.length !== item.size) {
          throw new Error(`Object changed during recovery snapshot: ${item.objectPath}`);
        }
        const encrypted = encryptBackupArtifactPayload(
          body,
          objectContext(bundleId, item.objectPath),
        );
        try {
          const payloadFile = `objects/${String(index + 1).padStart(8, "0")}.mve1`;
          await writeFile(join(resolvedOutput, payloadFile), encrypted.payload, {
            flag: "wx",
            mode: 0o600,
          });
          entries.push({
            objectPath: item.objectPath,
            payloadFile,
            plaintextSha256: sha256(body),
            encryptedSha256: sha256(encrypted.payload),
            size: body.length,
            encryptedSize: encrypted.payload.length,
            contentType: contentType || "application/octet-stream",
            sourceLastModified: item.lastModified,
          });
          totalPlaintextBytes += body.length;
          if (!Number.isSafeInteger(totalPlaintextBytes)) {
            throw new Error("Recovery bundle byte total exceeded the safe integer range.");
          }
        } finally {
          encrypted.payload.fill(0);
        }
      } finally {
        body.fill(0);
      }
    }

    const manifest: RecoveryManifest = {
      schema: BUNDLE_SCHEMA,
      bundleId,
      createdAt,
      sourceStorage: stableIdentity(storage.getRecoveryStorageIdentity()),
      objectCount: entries.length,
      totalPlaintextBytes,
      entries,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    let encryptedManifest: ReturnType<typeof encryptBackupArtifactPayload>;
    try {
      encryptedManifest = encryptBackupArtifactPayload(
        manifestBytes,
        manifestContext(bundleId),
      );
    } finally {
      manifestBytes.fill(0);
    }
    try {
      await writeFile(join(resolvedOutput, MANIFEST_FILE), encryptedManifest.payload, {
        flag: "wx",
        mode: 0o600,
      });
      const descriptor: RecoveryDescriptor = {
        schema: BUNDLE_SCHEMA,
        bundleId,
        createdAt,
        manifestFile: MANIFEST_FILE,
        encryptedManifestSha256: sha256(encryptedManifest.payload),
        encryptionFormat: encryptedManifest.format,
        encryptionKeyId: encryptedManifest.keyId,
        objectCount: entries.length,
        totalPlaintextBytes,
      };
      await writeFile(
        join(resolvedOutput, DESCRIPTOR_FILE),
        `${JSON.stringify(descriptor, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } finally {
      encryptedManifest.payload.fill(0);
    }

    return {
      bundleId,
      createdAt,
      objectCount: entries.length,
      totalPlaintextBytes,
      sourceStorage: manifest.sourceStorage,
    };
  } catch (error) {
    if (outputCreated) await rm(resolvedOutput, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyObjectRecoveryBundle(
  bundleDir: string,
): Promise<RecoveryBundleSummary> {
  const { manifest } = await readBundle(bundleDir);
  for (const entry of manifest.entries) {
    const encrypted = await readFile(join(resolve(bundleDir), entry.payloadFile));
    try {
      if (
        encrypted.length !== entry.encryptedSize ||
        sha256(encrypted) !== entry.encryptedSha256
      ) {
        throw new Error(`Encrypted recovery payload checksum mismatch: ${entry.objectPath}`);
      }
      const plaintext = decryptBackupArtifactPayload(
        encrypted,
        objectContext(manifest.bundleId, entry.objectPath),
      );
      try {
        if (plaintext.length !== entry.size || sha256(plaintext) !== entry.plaintextSha256) {
          throw new Error(`Recovery payload integrity mismatch: ${entry.objectPath}`);
        }
      } finally {
        plaintext.fill(0);
      }
    } finally {
      encrypted.fill(0);
    }
  }
  return {
    bundleId: manifest.bundleId,
    createdAt: manifest.createdAt,
    objectCount: manifest.objectCount,
    totalPlaintextBytes: manifest.totalPlaintextBytes,
    sourceStorage: manifest.sourceStorage,
  };
}

export async function restoreObjectRecoveryBundle(
  storage: ObjectRecoveryStorage,
  bundleDir: string,
  options: { confirmIsolatedTarget: boolean },
): Promise<RecoveryBundleSummary & { restoredObjects: number }> {
  if (!options.confirmIsolatedTarget) {
    throw new Error("Recovery restore requires explicit isolated-target confirmation.");
  }
  await verifyObjectRecoveryBundle(bundleDir);
  const { manifest } = await readBundle(bundleDir);
  const targetIdentity = stableIdentity(storage.getRecoveryStorageIdentity());
  if (identitiesMatch(manifest.sourceStorage, targetIdentity)) {
    throw new Error("Recovery restore refused to write into the source object store.");
  }

  const targetInventory = await storage.listPrivateObjectsForRecovery();
  if (targetInventory.length > 0) {
    throw new Error(
      `Recovery target private prefix is not empty (${targetInventory.length} objects).`,
    );
  }
  for (const entry of manifest.entries) {
    if (await storage.privateObjectExists(entry.objectPath)) {
      throw new Error(`Recovery target is not empty for ${entry.objectPath}.`);
    }
  }

  let restoredObjects = 0;
  for (const entry of manifest.entries) {
    const encrypted = await readFile(join(resolve(bundleDir), entry.payloadFile));
    try {
      const plaintext = decryptBackupArtifactPayload(
        encrypted,
        objectContext(manifest.bundleId, entry.objectPath),
      );
      try {
        await storage.putPrivateObject(entry.objectPath, plaintext, entry.contentType);
        const restored = await storage.readPrivateObjectForRecovery(entry.objectPath);
        try {
          if (
            restored.body.length !== entry.size ||
            sha256(restored.body) !== entry.plaintextSha256
          ) {
            throw new Error(`Restored object integrity mismatch: ${entry.objectPath}`);
          }
        } finally {
          restored.body.fill(0);
        }
        restoredObjects += 1;
      } finally {
        plaintext.fill(0);
      }
    } finally {
      encrypted.fill(0);
    }
  }

  return {
    bundleId: manifest.bundleId,
    createdAt: manifest.createdAt,
    objectCount: manifest.objectCount,
    totalPlaintextBytes: manifest.totalPlaintextBytes,
    sourceStorage: manifest.sourceStorage,
    restoredObjects,
  };
}
