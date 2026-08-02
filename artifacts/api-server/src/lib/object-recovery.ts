import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  decryptBackupArtifactPayload,
  encryptBackupArtifactPayload,
} from "./secret-envelope";

const DESCRIPTOR_FILE = "bundle.json";
const MANIFEST_FILE = "manifest.mve1";
const LEGACY_BUNDLE_SCHEMA = "modvolt-object-recovery/v1";
const BUNDLE_SCHEMA = "modvolt-object-recovery/v2";
const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_ENCRYPTED_MANIFEST_BYTES = 128 * 1024 * 1024;
const ENVELOPE_OVERHEAD_LIMIT = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUNDLE_ID_PATTERN = /^[a-f0-9-]{36}$/;

export type RecoveryStorageIdentity = Record<string, string>;

export type RecoveryInventoryItem = {
  objectPath: string;
  size: number;
  lastModified: string | null;
  /** Provider-specific immutable read token: S3 ETag or GCS generation. */
  snapshotToken?: string;
};

export interface ObjectRecoveryStorage {
  getRecoveryStorageIdentity(): RecoveryStorageIdentity;
  listPrivateObjectsForRecovery(): Promise<RecoveryInventoryItem[]>;
  privateObjectExists(objectPath: string): Promise<boolean>;
  openPrivateObjectRecoveryStream(
    objectPath: string,
    snapshotToken?: string,
  ): Promise<{ body: Readable; contentType: string }>;
  putPrivateObjectRecoveryStream(
    objectPath: string,
    body: Readable,
    contentLength: number,
    contentType: string,
    plaintextSha256: string,
  ): Promise<void>;
}

type LegacyRecoveryEntry = {
  objectPath: string;
  payloadFile: string;
  plaintextSha256: string;
  encryptedSha256: string;
  size: number;
  encryptedSize: number;
  contentType: string;
  sourceLastModified: string | null;
};

type RecoveryChunk = {
  payloadFile: string;
  plaintextSha256: string;
  encryptedSha256: string;
  size: number;
  encryptedSize: number;
};

type RecoveryEntry = {
  objectPath: string;
  plaintextSha256: string;
  size: number;
  contentType: string;
  sourceLastModified: string | null;
  chunks: RecoveryChunk[];
};

type LegacyRecoveryManifest = {
  schema: typeof LEGACY_BUNDLE_SCHEMA;
  bundleId: string;
  createdAt: string;
  sourceStorage: RecoveryStorageIdentity;
  objectCount: number;
  totalPlaintextBytes: number;
  entries: LegacyRecoveryEntry[];
};

type RecoveryManifest = {
  schema: typeof BUNDLE_SCHEMA;
  bundleId: string;
  createdAt: string;
  sourceStorage: RecoveryStorageIdentity;
  objectCount: number;
  totalPlaintextBytes: number;
  chunkSizeBytes: number;
  entries: RecoveryEntry[];
};

type RecoveryManifestUnion = LegacyRecoveryManifest | RecoveryManifest;

type LegacyRecoveryDescriptor = {
  schema: typeof LEGACY_BUNDLE_SCHEMA;
  bundleId: string;
  createdAt: string;
  manifestFile: typeof MANIFEST_FILE;
  encryptedManifestSha256: string;
  encryptionFormat: "mve1";
  encryptionKeyId: string;
  objectCount: number;
  totalPlaintextBytes: number;
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
  chunkSizeBytes: number;
};

type RecoveryDescriptorUnion = LegacyRecoveryDescriptor | RecoveryDescriptor;

export type RecoveryBundleSummary = {
  bundleId: string;
  createdAt: string;
  objectCount: number;
  totalPlaintextBytes: number;
  sourceStorage: RecoveryStorageIdentity;
};

export type RecoveryFreshnessSummary = RecoveryBundleSummary & {
  ageHours: number;
  maxAgeHours: number;
  fresh: boolean;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableIdentity(
  identity: RecoveryStorageIdentity,
): RecoveryStorageIdentity {
  return Object.fromEntries(
    Object.entries(identity)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function recoveryStorageFingerprint(
  identity: RecoveryStorageIdentity,
): string {
  return sha256(Buffer.from(JSON.stringify(stableIdentity(identity)), "utf8"));
}

function identitiesMatch(
  a: RecoveryStorageIdentity,
  b: RecoveryStorageIdentity,
): boolean {
  const left = stableIdentity(a);
  const right = stableIdentity(b);
  const sameStorageNamespace = ["backend", "bucket", "privatePrefix"].every(
    (key) => left[key] !== undefined && left[key] === right[key],
  );
  return sameStorageNamespace || JSON.stringify(left) === JSON.stringify(right);
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
    throw new Error(
      `Invalid private object path in recovery inventory: ${objectPath}`,
    );
  }
}

function legacyObjectContext(bundleId: string, objectPath: string): string {
  return `object_recovery:${bundleId}:object:${sha256(Buffer.from(objectPath, "utf8"))}`;
}

function objectChunkContext(
  bundleId: string,
  objectPath: string,
  chunkIndex: number,
): string {
  return `${legacyObjectContext(bundleId, objectPath)}:chunk:${chunkIndex}`;
}

function manifestContext(bundleId: string): string {
  return `object_recovery:${bundleId}:manifest`;
}

function assertSafeLegacyPayloadFile(payloadFile: string, index: number): void {
  const expected = `objects/${String(index + 1).padStart(8, "0")}.mve1`;
  if (payloadFile !== expected) {
    throw new Error(
      `Recovery manifest contains an invalid payload path: ${payloadFile}`,
    );
  }
}

function chunkPayloadFile(objectIndex: number, chunkIndex: number): string {
  return (
    `objects/${String(objectIndex + 1).padStart(8, "0")}/` +
    `${String(chunkIndex + 1).padStart(8, "0")}.mve1`
  );
}

function assertSafeChunkPayloadFile(
  payloadFile: string,
  objectIndex: number,
  chunkIndex: number,
): void {
  const expected = chunkPayloadFile(objectIndex, chunkIndex);
  if (payloadFile !== expected) {
    throw new Error(
      `Recovery manifest contains an invalid chunk path: ${payloadFile}`,
    );
  }
}

function validCommonDescriptor(
  descriptor: Partial<RecoveryDescriptorUnion> | null,
): boolean {
  return Boolean(
    descriptor &&
    (descriptor.schema === BUNDLE_SCHEMA ||
      descriptor.schema === LEGACY_BUNDLE_SCHEMA) &&
    typeof descriptor.bundleId === "string" &&
    BUNDLE_ID_PATTERN.test(descriptor.bundleId) &&
    typeof descriptor.createdAt === "string" &&
    Number.isFinite(Date.parse(descriptor.createdAt)) &&
    descriptor.manifestFile === MANIFEST_FILE &&
    typeof descriptor.encryptedManifestSha256 === "string" &&
    SHA256_PATTERN.test(descriptor.encryptedManifestSha256) &&
    descriptor.encryptionFormat === "mve1" &&
    typeof descriptor.encryptionKeyId === "string" &&
    descriptor.encryptionKeyId.length > 0 &&
    Number.isInteger(descriptor.objectCount) &&
    (descriptor.objectCount ?? -1) >= 0 &&
    Number.isSafeInteger(descriptor.totalPlaintextBytes) &&
    (descriptor.totalPlaintextBytes ?? -1) >= 0,
  );
}

function assertDescriptor(
  value: unknown,
): asserts value is RecoveryDescriptorUnion {
  const descriptor = value as Partial<RecoveryDescriptorUnion> | null;
  if (!validCommonDescriptor(descriptor)) {
    throw new Error("Recovery bundle descriptor is invalid.");
  }
  if (descriptor?.schema === BUNDLE_SCHEMA) {
    const current = descriptor as Partial<RecoveryDescriptor>;
    if (
      !Number.isSafeInteger(current.chunkSizeBytes) ||
      (current.chunkSizeBytes ?? 0) < 1 ||
      (current.chunkSizeBytes ?? 0) > MAX_CHUNK_SIZE_BYTES
    ) {
      throw new Error("Recovery bundle descriptor has an invalid chunk size.");
    }
  }
}

function validManifestHeader(
  manifest: Partial<RecoveryManifestUnion> | null,
  descriptor: RecoveryDescriptorUnion,
): boolean {
  return Boolean(
    manifest &&
    manifest.schema === descriptor.schema &&
    manifest.bundleId === descriptor.bundleId &&
    manifest.createdAt === descriptor.createdAt &&
    manifest.sourceStorage &&
    typeof manifest.sourceStorage === "object" &&
    !Array.isArray(manifest.sourceStorage) &&
    Array.isArray(manifest.entries) &&
    manifest.objectCount === descriptor.objectCount &&
    manifest.entries.length === descriptor.objectCount &&
    manifest.totalPlaintextBytes === descriptor.totalPlaintextBytes,
  );
}

function assertLegacyManifest(
  manifest: LegacyRecoveryManifest,
  descriptor: LegacyRecoveryDescriptor,
): void {
  const objectPaths = new Set<string>();
  let total = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }
    validateObjectPath(entry.objectPath);
    assertSafeLegacyPayloadFile(entry.payloadFile, index);
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
      (entry.sourceLastModified !== null &&
        typeof entry.sourceLastModified !== "string")
    ) {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }
    objectPaths.add(entry.objectPath);
    total += entry.size;
  }
  if (!Number.isSafeInteger(total) || total !== manifest.totalPlaintextBytes) {
    throw new Error("Recovery bundle manifest byte total is invalid.");
  }
  if (descriptor.schema !== LEGACY_BUNDLE_SCHEMA) {
    throw new Error("Recovery bundle descriptor and manifest schemas differ.");
  }
}

function assertCurrentManifest(
  manifest: RecoveryManifest,
  descriptor: RecoveryDescriptor,
): void {
  if (
    manifest.chunkSizeBytes !== descriptor.chunkSizeBytes ||
    !Number.isSafeInteger(manifest.chunkSizeBytes) ||
    manifest.chunkSizeBytes < 1 ||
    manifest.chunkSizeBytes > MAX_CHUNK_SIZE_BYTES
  ) {
    throw new Error("Recovery bundle manifest has an invalid chunk size.");
  }

  const objectPaths = new Set<string>();
  const payloadPaths = new Set<string>();
  let total = 0;
  for (const [objectIndex, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }
    validateObjectPath(entry.objectPath);
    if (
      objectPaths.has(entry.objectPath) ||
      !SHA256_PATTERN.test(entry.plaintextSha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.contentType !== "string" ||
      entry.contentType.length < 1 ||
      entry.contentType.length > 255 ||
      (entry.sourceLastModified !== null &&
        typeof entry.sourceLastModified !== "string") ||
      !Array.isArray(entry.chunks)
    ) {
      throw new Error("Recovery bundle manifest contains an invalid entry.");
    }

    const expectedChunks = Math.ceil(entry.size / manifest.chunkSizeBytes);
    if (entry.chunks.length !== expectedChunks) {
      throw new Error(
        `Recovery bundle has an invalid chunk count: ${entry.objectPath}`,
      );
    }
    let entryBytes = 0;
    for (const [chunkIndex, chunk] of entry.chunks.entries()) {
      if (!chunk || typeof chunk !== "object") {
        throw new Error("Recovery bundle manifest contains an invalid chunk.");
      }
      assertSafeChunkPayloadFile(chunk.payloadFile, objectIndex, chunkIndex);
      const isLast = chunkIndex === entry.chunks.length - 1;
      if (
        payloadPaths.has(chunk.payloadFile) ||
        !SHA256_PATTERN.test(chunk.plaintextSha256) ||
        !SHA256_PATTERN.test(chunk.encryptedSha256) ||
        !Number.isSafeInteger(chunk.size) ||
        chunk.size < 1 ||
        chunk.size > manifest.chunkSizeBytes ||
        (!isLast && chunk.size !== manifest.chunkSizeBytes) ||
        !Number.isSafeInteger(chunk.encryptedSize) ||
        chunk.encryptedSize < 1 ||
        chunk.encryptedSize > chunk.size + ENVELOPE_OVERHEAD_LIMIT
      ) {
        throw new Error("Recovery bundle manifest contains an invalid chunk.");
      }
      payloadPaths.add(chunk.payloadFile);
      entryBytes += chunk.size;
    }
    if (!Number.isSafeInteger(entryBytes) || entryBytes !== entry.size) {
      throw new Error(
        `Recovery bundle chunk byte total is invalid: ${entry.objectPath}`,
      );
    }
    objectPaths.add(entry.objectPath);
    total += entry.size;
  }
  if (!Number.isSafeInteger(total) || total !== manifest.totalPlaintextBytes) {
    throw new Error("Recovery bundle manifest byte total is invalid.");
  }
}

function assertManifest(
  value: unknown,
  descriptor: RecoveryDescriptorUnion,
): asserts value is RecoveryManifestUnion {
  const manifest = value as Partial<RecoveryManifestUnion> | null;
  if (!validManifestHeader(manifest, descriptor)) {
    throw new Error("Recovery bundle manifest is invalid.");
  }
  if (!manifest) {
    throw new Error("Recovery bundle manifest is invalid.");
  }
  if (manifest.schema === LEGACY_BUNDLE_SCHEMA) {
    assertLegacyManifest(
      manifest as LegacyRecoveryManifest,
      descriptor as LegacyRecoveryDescriptor,
    );
    return;
  }
  assertCurrentManifest(
    manifest as RecoveryManifest,
    descriptor as RecoveryDescriptor,
  );
}

async function readBundle(bundleDir: string): Promise<{
  descriptor: RecoveryDescriptorUnion;
  manifest: RecoveryManifestUnion;
}> {
  const resolvedBundle = resolve(bundleDir);
  const descriptorPath = join(resolvedBundle, DESCRIPTOR_FILE);
  const descriptorStat = await stat(descriptorPath);
  if (!descriptorStat.isFile() || descriptorStat.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Recovery bundle descriptor is missing or too large.");
  }
  const descriptor = JSON.parse(
    await readFile(descriptorPath, "utf8"),
  ) as unknown;
  assertDescriptor(descriptor);

  const manifestPath = join(resolvedBundle, descriptor.manifestFile);
  const manifestStat = await stat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.size > MAX_ENCRYPTED_MANIFEST_BYTES
  ) {
    throw new Error("Encrypted recovery manifest is missing or too large.");
  }
  const encryptedManifest = await readFile(manifestPath);
  try {
    if (sha256(encryptedManifest) !== descriptor.encryptedManifestSha256) {
      throw new Error("Encrypted recovery manifest checksum mismatch.");
    }
    const plaintextManifest = decryptBackupArtifactPayload(
      encryptedManifest,
      manifestContext(descriptor.bundleId),
    );
    try {
      const manifest = JSON.parse(
        plaintextManifest.toString("utf8"),
      ) as unknown;
      assertManifest(manifest, descriptor);
      return { descriptor, manifest };
    } finally {
      plaintextManifest.fill(0);
    }
  } finally {
    encryptedManifest.fill(0);
  }
}

async function writeEncryptedChunk(
  resolvedOutput: string,
  bundleId: string,
  objectPath: string,
  objectIndex: number,
  chunkIndex: number,
  plaintext: Buffer,
): Promise<RecoveryChunk> {
  const encrypted = encryptBackupArtifactPayload(
    plaintext,
    objectChunkContext(bundleId, objectPath, chunkIndex),
  );
  try {
    const payloadFile = chunkPayloadFile(objectIndex, chunkIndex);
    await writeFile(join(resolvedOutput, payloadFile), encrypted.payload, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      payloadFile,
      plaintextSha256: sha256(plaintext),
      encryptedSha256: sha256(encrypted.payload),
      size: plaintext.length,
      encryptedSize: encrypted.payload.length,
    };
  } finally {
    encrypted.payload.fill(0);
  }
}

async function snapshotObject(
  storage: ObjectRecoveryStorage,
  item: RecoveryInventoryItem,
  resolvedOutput: string,
  bundleId: string,
  objectIndex: number,
  chunkSizeBytes: number,
): Promise<RecoveryEntry> {
  await mkdir(
    join(resolvedOutput, "objects", String(objectIndex + 1).padStart(8, "0")),
  );
  const opened = await storage.openPrivateObjectRecoveryStream(
    item.objectPath,
    item.snapshotToken,
  );
  const objectHash = createHash("sha256");
  const chunks: RecoveryChunk[] = [];
  let totalBytes = 0;
  let pending = Buffer.allocUnsafe(chunkSizeBytes);
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const plaintext =
      pendingBytes === pending.length
        ? pending
        : Buffer.from(pending.subarray(0, pendingBytes));
    try {
      chunks.push(
        await writeEncryptedChunk(
          resolvedOutput,
          bundleId,
          item.objectPath,
          objectIndex,
          chunks.length,
          plaintext,
        ),
      );
    } finally {
      plaintext.fill(0);
      if (plaintext !== pending) pending.fill(0);
    }
    pending = Buffer.allocUnsafe(chunkSizeBytes);
    pendingBytes = 0;
  };

  try {
    for await (const value of opened.body) {
      const input = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      objectHash.update(input);
      totalBytes += input.length;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > item.size) {
        throw new Error(
          `Object changed during recovery snapshot: ${item.objectPath}`,
        );
      }
      let offset = 0;
      while (offset < input.length) {
        const copied = input.copy(
          pending,
          pendingBytes,
          offset,
          Math.min(input.length, offset + chunkSizeBytes - pendingBytes),
        );
        pendingBytes += copied;
        offset += copied;
        if (pendingBytes === chunkSizeBytes) await flush();
      }
    }
    await flush();
  } finally {
    pending.fill(0);
    if (!opened.body.destroyed) opened.body.destroy();
  }

  if (totalBytes !== item.size) {
    throw new Error(
      `Object changed during recovery snapshot: ${item.objectPath}`,
    );
  }
  return {
    objectPath: item.objectPath,
    plaintextSha256: objectHash.digest("hex"),
    size: totalBytes,
    contentType: opened.contentType || "application/octet-stream",
    sourceLastModified: item.lastModified,
    chunks,
  };
}

export async function createObjectRecoveryBundle(
  storage: ObjectRecoveryStorage,
  outputDir: string,
  options: { chunkSizeBytes?: number } = {},
): Promise<RecoveryBundleSummary> {
  if (!isAbsolute(outputDir)) {
    throw new Error(
      "Recovery bundle output directory must be an absolute path.",
    );
  }
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  if (
    !Number.isSafeInteger(chunkSizeBytes) ||
    chunkSizeBytes < 1 ||
    chunkSizeBytes > MAX_CHUNK_SIZE_BYTES
  ) {
    throw new Error(
      `Recovery chunk size must be between 1 and ${MAX_CHUNK_SIZE_BYTES} bytes.`,
    );
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
        throw new Error(
          `Duplicate private object path in inventory: ${item.objectPath}`,
        );
      }
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        throw new Error(
          `Invalid object size in recovery inventory: ${item.objectPath}`,
        );
      }
      if (
        item.snapshotToken !== undefined &&
        typeof item.snapshotToken !== "string"
      ) {
        throw new Error(`Invalid object snapshot token: ${item.objectPath}`);
      }
      seen.add(item.objectPath);
    }
    inventory.sort((a, b) => a.objectPath.localeCompare(b.objectPath));

    const entries: RecoveryEntry[] = [];
    let totalPlaintextBytes = 0;
    for (const [index, item] of inventory.entries()) {
      const entry = await snapshotObject(
        storage,
        item,
        resolvedOutput,
        bundleId,
        index,
        chunkSizeBytes,
      );
      entries.push(entry);
      totalPlaintextBytes += entry.size;
      if (!Number.isSafeInteger(totalPlaintextBytes)) {
        throw new Error(
          "Recovery bundle byte total exceeded the safe integer range.",
        );
      }
    }

    const manifest: RecoveryManifest = {
      schema: BUNDLE_SCHEMA,
      bundleId,
      createdAt,
      sourceStorage: stableIdentity(storage.getRecoveryStorageIdentity()),
      objectCount: entries.length,
      totalPlaintextBytes,
      chunkSizeBytes,
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
      await writeFile(
        join(resolvedOutput, MANIFEST_FILE),
        encryptedManifest.payload,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
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
        chunkSizeBytes,
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
    if (outputCreated)
      await rm(resolvedOutput, { recursive: true, force: true });
    throw error;
  }
}

async function readEncryptedPayload(
  resolvedBundle: string,
  payloadFile: string,
  expectedSize: number,
  maxSize: number,
): Promise<Buffer> {
  const payloadPath = join(resolvedBundle, payloadFile);
  const payloadStat = await stat(payloadPath);
  if (
    !payloadStat.isFile() ||
    payloadStat.size !== expectedSize ||
    payloadStat.size > maxSize
  ) {
    throw new Error(`Encrypted recovery payload size mismatch: ${payloadFile}`);
  }
  return readFile(payloadPath);
}

async function verifyLegacyEntry(
  resolvedBundle: string,
  manifest: LegacyRecoveryManifest,
  entry: LegacyRecoveryEntry,
): Promise<void> {
  const encrypted = await readEncryptedPayload(
    resolvedBundle,
    entry.payloadFile,
    entry.encryptedSize,
    Number.MAX_SAFE_INTEGER,
  );
  try {
    if (sha256(encrypted) !== entry.encryptedSha256) {
      throw new Error(
        `Encrypted recovery payload checksum mismatch: ${entry.objectPath}`,
      );
    }
    const plaintext = decryptBackupArtifactPayload(
      encrypted,
      legacyObjectContext(manifest.bundleId, entry.objectPath),
    );
    try {
      if (
        plaintext.length !== entry.size ||
        sha256(plaintext) !== entry.plaintextSha256
      ) {
        throw new Error(
          `Recovery payload integrity mismatch: ${entry.objectPath}`,
        );
      }
    } finally {
      plaintext.fill(0);
    }
  } finally {
    encrypted.fill(0);
  }
}

async function readAndDecryptChunk(
  resolvedBundle: string,
  manifest: RecoveryManifest,
  entry: RecoveryEntry,
  chunk: RecoveryChunk,
  chunkIndex: number,
): Promise<Buffer> {
  const encrypted = await readEncryptedPayload(
    resolvedBundle,
    chunk.payloadFile,
    chunk.encryptedSize,
    manifest.chunkSizeBytes + ENVELOPE_OVERHEAD_LIMIT,
  );
  try {
    if (sha256(encrypted) !== chunk.encryptedSha256) {
      throw new Error(
        `Encrypted recovery payload checksum mismatch: ${entry.objectPath}`,
      );
    }
    const plaintext = decryptBackupArtifactPayload(
      encrypted,
      objectChunkContext(manifest.bundleId, entry.objectPath, chunkIndex),
    );
    if (
      plaintext.length !== chunk.size ||
      sha256(plaintext) !== chunk.plaintextSha256
    ) {
      plaintext.fill(0);
      throw new Error(
        `Recovery payload integrity mismatch: ${entry.objectPath}`,
      );
    }
    return plaintext;
  } finally {
    encrypted.fill(0);
  }
}

async function verifyCurrentEntry(
  resolvedBundle: string,
  manifest: RecoveryManifest,
  entry: RecoveryEntry,
): Promise<void> {
  const objectHash = createHash("sha256");
  let bytes = 0;
  for (const [chunkIndex, chunk] of entry.chunks.entries()) {
    const plaintext = await readAndDecryptChunk(
      resolvedBundle,
      manifest,
      entry,
      chunk,
      chunkIndex,
    );
    try {
      bytes += plaintext.length;
      objectHash.update(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }
  if (
    bytes !== entry.size ||
    objectHash.digest("hex") !== entry.plaintextSha256
  ) {
    throw new Error(`Recovery payload integrity mismatch: ${entry.objectPath}`);
  }
}

export async function verifyObjectRecoveryBundle(
  bundleDir: string,
): Promise<RecoveryBundleSummary> {
  const { manifest } = await readBundle(bundleDir);
  const resolvedBundle = resolve(bundleDir);
  if (manifest.schema === LEGACY_BUNDLE_SCHEMA) {
    for (const entry of manifest.entries) {
      await verifyLegacyEntry(resolvedBundle, manifest, entry);
    }
  } else {
    for (const entry of manifest.entries) {
      await verifyCurrentEntry(resolvedBundle, manifest, entry);
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

async function hashRecoveryObject(
  storage: ObjectRecoveryStorage,
  objectPath: string,
): Promise<{ size: number; plaintextSha256: string; contentType: string }> {
  const opened = await storage.openPrivateObjectRecoveryStream(objectPath);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const value of opened.body) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (!Number.isSafeInteger(size)) {
        throw new Error(
          `Restored object is too large to verify: ${objectPath}`,
        );
      }
      hash.update(chunk);
    }
  } finally {
    if (!opened.body.destroyed) opened.body.destroy();
  }
  return {
    size,
    plaintextSha256: hash.digest("hex"),
    contentType: opened.contentType || "application/octet-stream",
  };
}

function legacyPlaintextStream(
  resolvedBundle: string,
  manifest: LegacyRecoveryManifest,
  entry: LegacyRecoveryEntry,
): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const encrypted = await readEncryptedPayload(
      resolvedBundle,
      entry.payloadFile,
      entry.encryptedSize,
      Number.MAX_SAFE_INTEGER,
    );
    try {
      if (sha256(encrypted) !== entry.encryptedSha256) {
        throw new Error(
          `Encrypted recovery payload checksum mismatch: ${entry.objectPath}`,
        );
      }
      const plaintext = decryptBackupArtifactPayload(
        encrypted,
        legacyObjectContext(manifest.bundleId, entry.objectPath),
      );
      // Ownership passes to the Readable consumer. Zeroing after `yield` is
      // unsafe because Readable.from may prefetch the next generator value
      // before the provider has consumed the current bytes.
      yield plaintext;
    } finally {
      encrypted.fill(0);
    }
  }
  return Readable.from(generate(), { objectMode: false });
}

function currentPlaintextStream(
  resolvedBundle: string,
  manifest: RecoveryManifest,
  entry: RecoveryEntry,
): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const objectHash = createHash("sha256");
    let bytes = 0;
    for (const [chunkIndex, chunk] of entry.chunks.entries()) {
      const plaintext = await readAndDecryptChunk(
        resolvedBundle,
        manifest,
        entry,
        chunk,
        chunkIndex,
      );
      bytes += plaintext.length;
      objectHash.update(plaintext);
      // The upload stream owns this buffer after it is yielded; do not mutate
      // it while Readable/provider backpressure may still reference it.
      yield plaintext;
    }
    if (
      bytes !== entry.size ||
      objectHash.digest("hex") !== entry.plaintextSha256
    ) {
      throw new Error(
        `Recovery payload integrity mismatch: ${entry.objectPath}`,
      );
    }
  }
  return Readable.from(generate(), { objectMode: false });
}

export async function restoreObjectRecoveryBundle(
  storage: ObjectRecoveryStorage,
  bundleDir: string,
  options: { confirmIsolatedTarget: boolean },
): Promise<RecoveryBundleSummary & { restoredObjects: number }> {
  if (!options.confirmIsolatedTarget) {
    throw new Error(
      "Recovery restore requires explicit isolated-target confirmation.",
    );
  }
  await verifyObjectRecoveryBundle(bundleDir);
  const { manifest } = await readBundle(bundleDir);
  const targetIdentity = stableIdentity(storage.getRecoveryStorageIdentity());
  if (identitiesMatch(manifest.sourceStorage, targetIdentity)) {
    throw new Error(
      "Recovery restore refused to write into the source object store.",
    );
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

  const resolvedBundle = resolve(bundleDir);
  let restoredObjects = 0;
  if (manifest.schema === LEGACY_BUNDLE_SCHEMA) {
    for (const entry of manifest.entries) {
      const body = legacyPlaintextStream(resolvedBundle, manifest, entry);
      await storage.putPrivateObjectRecoveryStream(
        entry.objectPath,
        body,
        entry.size,
        entry.contentType,
        entry.plaintextSha256,
      );
      const restored = await hashRecoveryObject(storage, entry.objectPath);
      if (
        restored.size !== entry.size ||
        restored.plaintextSha256 !== entry.plaintextSha256 ||
        restored.contentType !== entry.contentType
      ) {
        throw new Error(
          `Restored object integrity mismatch: ${entry.objectPath}`,
        );
      }
      restoredObjects += 1;
    }
  } else {
    for (const entry of manifest.entries) {
      const body = currentPlaintextStream(resolvedBundle, manifest, entry);
      await storage.putPrivateObjectRecoveryStream(
        entry.objectPath,
        body,
        entry.size,
        entry.contentType,
        entry.plaintextSha256,
      );
      const restored = await hashRecoveryObject(storage, entry.objectPath);
      if (
        restored.size !== entry.size ||
        restored.plaintextSha256 !== entry.plaintextSha256 ||
        restored.contentType !== entry.contentType
      ) {
        throw new Error(
          `Restored object integrity mismatch: ${entry.objectPath}`,
        );
      }
      restoredObjects += 1;
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

export async function checkObjectRecoveryBundleFreshness(
  bundleDir: string,
  maxAgeHours: number,
  now = new Date(),
): Promise<RecoveryFreshnessSummary> {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error(
      "Recovery freshness maximum age must be greater than zero hours.",
    );
  }
  const summary = await verifyObjectRecoveryBundle(bundleDir);
  const createdAt = Date.parse(summary.createdAt);
  const ageHours = (now.getTime() - createdAt) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) {
    throw new Error("Recovery bundle timestamp is invalid or in the future.");
  }
  return {
    ...summary,
    ageHours,
    maxAgeHours,
    fresh: ageHours <= maxAgeHours,
  };
}
