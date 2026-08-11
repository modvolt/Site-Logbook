import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  verifyCanonicalAccountingDocumentVersionJsonBytes,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
  type AccountingLifecycleEventV1,
  type AccountingPaymentEventV1,
  type AccountingVersionRelationV1,
} from "./accounting-lifecycle-event-contract";
import {
  verifyCanonicalAccountingWarehousePriceObservationJsonBytes,
  type AccountingWarehousePriceObservationV1,
} from "./accounting-warehouse-price-observation-contract";
import {
  verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  verifyCanonicalAccountingReasonArtifactJsonBytes,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";
import {
  verifyCanonicalAccountingExportIntentJsonBytes,
  type AccountingExportIntentV1,
} from "./accounting-persistence-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const BUNDLE_SCHEMA = "site-logbook.accounting-archive-bundle/v1" as const;
const MANIFEST_SCHEMA = "site-logbook.accounting-archive-manifest/v1" as const;
const BUNDLE_HASH_DOMAIN = BUNDLE_SCHEMA;
const MANIFEST_HASH_DOMAIN = MANIFEST_SCHEMA;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

// The first implementation deliberately buffers canonical JSON so its hard
// ceiling stays well below the API container limit. Oversized evidence is a
// visible dead-letter/repair case until a later streaming canonicalizer exists.
export const MAX_ACCOUNTING_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES = 256 * 1024;
export const MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES = 256;

const entryKindSchema = z.enum([
  "document-version",
  "lifecycle-event",
  "payment-event",
  "version-relation",
  "warehouse-price-observation",
  "warehouse-price-legacy-observation",
  "reason-artifact",
]);
const archiveEntryRefSchema = z
  .object({
    kind: entryKindSchema,
    id: z.string().regex(UUID_PATTERN),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();
const archiveBundleEntrySchema = z
  .object({
    ...archiveEntryRefSchema.shape,
    evidence: z.unknown(),
  })
  .strict();
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const objectVersionSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);
const objectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^accounting-evidence(?:-restricted)?\/v1\/[0-9a-f-]{36}\/[0-9a-f]{64}\/(?:bundle\.json|bundle\.sha256|manifest\.json)$/,
  );
const objectArtifactSchema = z
  .object({
    objectKey: objectKeySchema,
    versionId: objectVersionSchema,
    mediaType: z.enum(["application/json", "text/plain"]),
    sizeBytes: z.string().regex(POSITIVE_DECIMAL_PATTERN),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const bundleSchema = z
  .object({
    schemaVersion: z.literal(BUNDLE_SCHEMA),
    intent: z.unknown(),
    entries: z.array(archiveBundleEntrySchema).min(1).max(3),
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(BUNDLE_HASH_DOMAIN),
        intentSha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA),
    archiveId: z.string().regex(UUID_PATTERN),
    operation: z.enum([
      "initial-version",
      "legacy-observation",
      "lifecycle-event",
      "payment-event",
      "correction-bundle",
      "warehouse-price-observation",
      "warehouse-price-legacy-observation",
      "reason-artifact",
    ]),
    recordedAt: timestampSchema,
    intent: z
      .object({
        intentId: z.string().regex(UUID_PATTERN),
        intentSha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
    entries: z.array(archiveEntryRefSchema).min(1).max(3),
    storage: z
      .object({
        namespace: z.enum([
          "accounting-evidence/v1",
          "accounting-evidence-restricted/v1",
        ]),
        writeMode: z.literal("immutable-versioned-create-only"),
        providerVersionIdsRequired: z.literal(true),
        manifestIsCommitMarker: z.literal(true),
      })
      .strict(),
    artifacts: z
      .object({
        bundle: objectArtifactSchema,
        checksum: objectArtifactSchema,
      })
      .strict(),
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(MANIFEST_HASH_DOMAIN),
      })
      .strict(),
  })
  .strict();

export type AccountingArchiveEntryKind = z.infer<typeof entryKindSchema>;
export type AccountingArchiveManifestV1 = z.infer<typeof manifestSchema>;
export type AccountingArchiveBundleV1 = z.infer<typeof bundleSchema> & {
  intent: AccountingExportIntentV1;
};
export type AccountingArchiveEvidence =
  | AccountingDocumentVersionV1
  | AccountingLifecycleEventV1
  | AccountingPaymentEventV1
  | AccountingVersionRelationV1
  | AccountingWarehousePriceObservationV1
  | AccountingWarehousePriceLegacyObservationV1
  | AccountingReasonArtifactV1;

export interface AccountingArchiveEntryBytes {
  kind: AccountingArchiveEntryKind;
  id: string;
  canonicalJson: string | Buffer;
}

export interface AccountingArchivePreparedPayload {
  intent: AccountingExportIntentV1;
  bundle: {
    objectKey: string;
    body: Buffer;
    sha256: string;
    mediaType: "application/json";
  };
  checksum: {
    objectKey: string;
    body: Buffer;
    sha256: string;
    mediaType: "text/plain";
  };
}

export interface AccountingArchiveObjectReceipt {
  objectKey: string;
  versionId: string;
}

export interface AccountingArchiveManifestArtifact {
  manifest: AccountingArchiveManifestV1;
  objectKey: string;
  body: Buffer;
  sha256: string;
  mediaType: "application/json";
}

export interface AccountingArchiveReceiptV1 {
  manifestObjectKey: string;
  manifestVersionId: string;
  manifestSha256: string;
  bundleSha256: string;
  checksumSha256: string;
}

export class AccountingArchiveContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingArchiveContractError";
  }
}

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function bytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, "utf8");
}

function assertSize(name: string, value: Buffer, maximum: number): void {
  if (value.byteLength === 0 || value.byteLength > maximum) {
    throw new AccountingArchiveContractError(
      `${name} must contain between 1 and ${maximum} bytes.`,
    );
  }
}

function parseCanonicalJson(
  name: string,
  value: string | Buffer,
  maximum: number,
): { parsed: unknown; text: string; raw: Buffer } {
  const raw = bytes(value);
  assertSize(name, raw, maximum);
  const text = raw.toString("utf8");
  if (
    Buffer.byteLength(text, "utf8") !== raw.byteLength ||
    text.charCodeAt(0) === 0xfeff ||
    text.includes("\r")
  ) {
    throw new AccountingArchiveContractError(
      `${name} is not canonical UTF-8 JSON.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AccountingArchiveContractError(`${name} is not valid JSON.`);
  }
  if (canonicalEvidenceJson(parsed) !== text) {
    throw new AccountingArchiveContractError(`${name} is not canonical JSON.`);
  }
  return { parsed, text, raw };
}

function entryIdentity(
  kind: AccountingArchiveEntryKind,
  evidence: AccountingArchiveEvidence,
): { kind: AccountingArchiveEntryKind; id: string; sha256: string } {
  if (kind === "document-version") {
    if (
      !("versionId" in evidence) ||
      !("versionSha256" in evidence.integrity)
    ) {
      throw new AccountingArchiveContractError(
        "Archive entry kind does not match document evidence.",
      );
    }
    return {
      kind,
      id: evidence.versionId,
      sha256: evidence.integrity.versionSha256,
    };
  }
  if (kind === "lifecycle-event") {
    if (!("eventId" in evidence)) {
      throw new AccountingArchiveContractError(
        "Archive entry kind does not match lifecycle evidence.",
      );
    }
    return {
      kind,
      id: evidence.eventId,
      sha256: evidence.integrity.entrySha256,
    };
  }
  if (kind === "payment-event") {
    if (!("paymentEventId" in evidence)) {
      throw new AccountingArchiveContractError(
        "Archive entry kind does not match payment evidence.",
      );
    }
    return {
      kind,
      id: evidence.paymentEventId,
      sha256: evidence.integrity.entrySha256,
    };
  }
  if (
    kind === "warehouse-price-observation" ||
    kind === "warehouse-price-legacy-observation"
  ) {
    if (!("observationId" in evidence)) {
      throw new AccountingArchiveContractError(
        "Archive entry kind does not match warehouse-price evidence.",
      );
    }
    return {
      kind,
      id: evidence.observationId,
      sha256: evidence.integrity.entrySha256,
    };
  }
  if (kind === "reason-artifact") {
    if (!("artifactId" in evidence)) {
      throw new AccountingArchiveContractError(
        "Archive entry kind does not match reason-artifact evidence.",
      );
    }
    return {
      kind,
      id: evidence.artifactId,
      sha256: evidence.integrity.artifactSha256,
    };
  }
  if (!("relationId" in evidence)) {
    throw new AccountingArchiveContractError(
      "Archive entry kind does not match relation evidence.",
    );
  }
  return {
    kind,
    id: evidence.relationId,
    sha256: evidence.integrity.entrySha256,
  };
}

function verifyEntryBytes(
  kind: AccountingArchiveEntryKind,
  value: string | Buffer,
): AccountingArchiveEvidence {
  const raw = bytes(value);
  assertSize(
    "Accounting archive entry",
    raw,
    MAX_ACCOUNTING_ARCHIVE_ENTRY_BYTES,
  );
  try {
    if (kind === "document-version") {
      return verifyCanonicalAccountingDocumentVersionJsonBytes(raw);
    }
    if (kind === "warehouse-price-observation") {
      return verifyCanonicalAccountingWarehousePriceObservationJsonBytes(raw);
    }
    if (kind === "warehouse-price-legacy-observation") {
      return verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes(
        raw,
      );
    }
    if (kind === "reason-artifact") {
      return verifyCanonicalAccountingReasonArtifactJsonBytes(raw);
    }
    return verifyCanonicalAccountingLifecycleEntryJsonBytes(raw);
  } catch (error) {
    throw new AccountingArchiveContractError(
      `Accounting archive entry verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function verifyIntentEvidenceBinding(
  intent: AccountingExportIntentV1,
  kind: AccountingArchiveEntryKind,
  evidence: AccountingArchiveEvidence,
): void {
  if (kind === "reason-artifact") {
    if (!("artifactId" in evidence)) {
      throw new AccountingArchiveContractError(
        "Reason archive entry has the wrong evidence shape.",
      );
    }
    const affected = intent.affectedAggregates;
    if (
      affected.length !== 1 ||
      affected[0]?.kind !== evidence.aggregate.kind ||
      affected[0].id !== evidence.aggregate.id ||
      intent.destination.namespace !== "accounting-evidence-restricted/v1"
    ) {
      throw new AccountingArchiveContractError(
        "Reason archive aggregate or restricted namespace does not match its evidence.",
      );
    }
    return;
  }
  if (
    kind !== "warehouse-price-observation" &&
    kind !== "warehouse-price-legacy-observation"
  ) {
    return;
  }
  if (!("observationId" in evidence)) {
    throw new AccountingArchiveContractError(
      "Warehouse-price archive entry has the wrong evidence shape.",
    );
  }
  const affected = intent.affectedAggregates;
  if (kind === "warehouse-price-legacy-observation") {
    if (
      evidence.schemaVersion !==
        "site-logbook.warehouse-price-legacy-observation/v1" ||
      affected.length !== 1 ||
      affected[0]?.kind !== "warehouse-item" ||
      affected[0].id !== evidence.warehouseItemId
    ) {
      throw new AccountingArchiveContractError(
        "Legacy warehouse-price archive aggregate does not match its item evidence.",
      );
    }
    return;
  }
  if (
    evidence.schemaVersion !== "site-logbook.warehouse-price-observation/v1" ||
    affected.length !== 1 ||
    affected[0]?.kind !== "incoming-cost-document" ||
    affected[0].id !== evidence.source.aggregateId
  ) {
    throw new AccountingArchiveContractError(
      "Warehouse-price archive aggregate does not match its source evidence.",
    );
  }
}

function archivePrefix(intent: AccountingExportIntentV1): string {
  return `${intent.destination.namespace}/${intent.intentId}/${intent.integrity.intentSha256}`;
}

function expectedObjectKeys(intent: AccountingExportIntentV1) {
  const prefix = archivePrefix(intent);
  return {
    bundle: `${prefix}/bundle.json`,
    checksum: `${prefix}/bundle.sha256`,
    manifest: `${prefix}/manifest.json`,
  } as const;
}

function verifyIntentBytes(value: string | Buffer): AccountingExportIntentV1 {
  try {
    return verifyCanonicalAccountingExportIntentJsonBytes(value);
  } catch (error) {
    throw new AccountingArchiveContractError(
      `Accounting archive intent verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export function prepareAccountingArchivePayload(input: {
  canonicalIntentJson: string | Buffer;
  entries: AccountingArchiveEntryBytes[];
}): AccountingArchivePreparedPayload {
  const intent = verifyIntentBytes(input.canonicalIntentJson);
  if (input.entries.length !== intent.entries.length) {
    throw new AccountingArchiveContractError(
      "Archive entry count does not match the export intent.",
    );
  }
  const supplied = new Map<string, AccountingArchiveEntryBytes>();
  for (const entry of input.entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (supplied.has(key)) {
      throw new AccountingArchiveContractError(
        "Archive contains duplicate entry identities.",
      );
    }
    supplied.set(key, entry);
  }
  const archiveEntries = intent.entries.map((expected) => {
    const key = `${expected.kind}:${expected.id}`;
    const candidate = supplied.get(key);
    if (!candidate) {
      throw new AccountingArchiveContractError(
        `Archive entry ${key} is missing.`,
      );
    }
    const evidence = verifyEntryBytes(candidate.kind, candidate.canonicalJson);
    verifyIntentEvidenceBinding(intent, candidate.kind, evidence);
    const actual = entryIdentity(candidate.kind, evidence);
    if (
      actual.id !== expected.id ||
      !safeEqualHex(actual.sha256, expected.sha256)
    ) {
      throw new AccountingArchiveContractError(
        `Archive entry ${key} does not match the export intent.`,
      );
    }
    supplied.delete(key);
    return { ...expected, evidence };
  });
  if (supplied.size !== 0) {
    throw new AccountingArchiveContractError(
      "Archive contains entries not declared by the export intent.",
    );
  }
  const bundle = bundleSchema.parse({
    schemaVersion: BUNDLE_SCHEMA,
    intent,
    entries: archiveEntries,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: BUNDLE_HASH_DOMAIN,
      intentSha256: intent.integrity.intentSha256,
    },
  });
  const bundleBody = Buffer.from(canonicalEvidenceJson(bundle), "utf8");
  assertSize(
    "Accounting archive bundle",
    bundleBody,
    MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES,
  );
  const bundleSha256 = sha256Hex(bundleBody);
  const checksumBody = Buffer.from(`${bundleSha256}  bundle.json\n`, "utf8");
  assertSize(
    "Accounting archive checksum",
    checksumBody,
    MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES,
  );
  const keys = expectedObjectKeys(intent);
  return {
    intent,
    bundle: {
      objectKey: keys.bundle,
      body: bundleBody,
      sha256: bundleSha256,
      mediaType: "application/json",
    },
    checksum: {
      objectKey: keys.checksum,
      body: checksumBody,
      sha256: sha256Hex(checksumBody),
      mediaType: "text/plain",
    },
  };
}

function assertReceipt(
  expectedKey: string,
  receipt: AccountingArchiveObjectReceipt,
): void {
  if (
    receipt.objectKey !== expectedKey ||
    !objectVersionSchema.safeParse(receipt.versionId).success
  ) {
    throw new AccountingArchiveContractError(
      "Immutable object receipt is invalid.",
    );
  }
}

export function createAccountingArchiveManifest(input: {
  payload: AccountingArchivePreparedPayload;
  bundleReceipt: AccountingArchiveObjectReceipt;
  checksumReceipt: AccountingArchiveObjectReceipt;
}): AccountingArchiveManifestArtifact {
  const { payload } = input;
  assertReceipt(payload.bundle.objectKey, input.bundleReceipt);
  assertReceipt(payload.checksum.objectKey, input.checksumReceipt);
  const keys = expectedObjectKeys(payload.intent);
  const manifest = manifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA,
    archiveId: payload.intent.intentId,
    operation: payload.intent.operation,
    recordedAt: payload.intent.recordedAt,
    intent: {
      intentId: payload.intent.intentId,
      intentSha256: payload.intent.integrity.intentSha256,
    },
    entries: payload.intent.entries,
    storage: {
      namespace: payload.intent.destination.namespace,
      writeMode: "immutable-versioned-create-only",
      providerVersionIdsRequired: true,
      manifestIsCommitMarker: true,
    },
    artifacts: {
      bundle: {
        objectKey: payload.bundle.objectKey,
        versionId: input.bundleReceipt.versionId,
        mediaType: payload.bundle.mediaType,
        sizeBytes: String(payload.bundle.body.byteLength),
        sha256: payload.bundle.sha256,
      },
      checksum: {
        objectKey: payload.checksum.objectKey,
        versionId: input.checksumReceipt.versionId,
        mediaType: payload.checksum.mediaType,
        sizeBytes: String(payload.checksum.body.byteLength),
        sha256: payload.checksum.sha256,
      },
    },
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: MANIFEST_HASH_DOMAIN,
    },
  });
  const body = Buffer.from(canonicalEvidenceJson(manifest), "utf8");
  assertSize(
    "Accounting archive manifest",
    body,
    MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES,
  );
  return {
    manifest,
    objectKey: keys.manifest,
    body,
    sha256: sha256Hex(body),
    mediaType: "application/json",
  };
}

export function verifyCanonicalAccountingArchiveBundleBytes(
  value: string | Buffer,
): AccountingArchiveBundleV1 {
  const decoded = parseCanonicalJson(
    "Accounting archive bundle",
    value,
    MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES,
  );
  const bundle = bundleSchema.parse(decoded.parsed);
  const intent = verifyIntentBytes(canonicalEvidenceJson(bundle.intent));
  if (
    !safeEqualHex(bundle.integrity.intentSha256, intent.integrity.intentSha256)
  ) {
    throw new AccountingArchiveContractError(
      "Archive bundle intent digest does not match.",
    );
  }
  if (bundle.entries.length !== intent.entries.length) {
    throw new AccountingArchiveContractError(
      "Archive bundle entry count does not match its intent.",
    );
  }
  bundle.entries.forEach((entry, index) => {
    const expected = intent.entries[index];
    if (
      !expected ||
      canonicalEvidenceJson({
        kind: entry.kind,
        id: entry.id,
        sha256: entry.sha256,
      }) !== canonicalEvidenceJson(expected)
    ) {
      throw new AccountingArchiveContractError(
        "Archive bundle entry order or identity does not match its intent.",
      );
    }
    const evidenceBytes = canonicalEvidenceJson(entry.evidence);
    const evidence = verifyEntryBytes(entry.kind, evidenceBytes);
    verifyIntentEvidenceBinding(intent, entry.kind, evidence);
    const actual = entryIdentity(entry.kind, evidence);
    if (actual.id !== entry.id || !safeEqualHex(actual.sha256, entry.sha256)) {
      throw new AccountingArchiveContractError(
        "Archive bundle contains mismatched evidence.",
      );
    }
  });
  return { ...bundle, intent };
}

export function verifyCanonicalAccountingArchiveManifestBytes(
  value: string | Buffer,
): AccountingArchiveManifestV1 {
  const decoded = parseCanonicalJson(
    "Accounting archive manifest",
    value,
    MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES,
  );
  return manifestSchema.parse(decoded.parsed);
}

export function verifyAccountingArchive(input: {
  bundleBytes: string | Buffer;
  checksumBytes: string | Buffer;
  manifestBytes: string | Buffer;
  observedManifestVersionId: string;
  expectedReceipt?: AccountingArchiveReceiptV1;
}): {
  intent: AccountingExportIntentV1;
  manifest: AccountingArchiveManifestV1;
  receipt: AccountingArchiveReceiptV1;
} {
  const bundleRaw = bytes(input.bundleBytes);
  const checksumRaw = bytes(input.checksumBytes);
  const manifestRaw = bytes(input.manifestBytes);
  assertSize(
    "Accounting archive checksum",
    checksumRaw,
    MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES,
  );
  const bundle = verifyCanonicalAccountingArchiveBundleBytes(bundleRaw);
  const manifest = verifyCanonicalAccountingArchiveManifestBytes(manifestRaw);
  const keys = expectedObjectKeys(bundle.intent);
  const bundleSha256 = sha256Hex(bundleRaw);
  const checksumSha256 = sha256Hex(checksumRaw);
  const manifestSha256 = sha256Hex(manifestRaw);
  const expectedChecksum = `${bundleSha256}  bundle.json\n`;
  if (!objectVersionSchema.safeParse(input.observedManifestVersionId).success) {
    throw new AccountingArchiveContractError(
      "Observed manifest provider version ID is invalid.",
    );
  }
  if (checksumRaw.toString("utf8") !== expectedChecksum) {
    throw new AccountingArchiveContractError(
      "Accounting archive checksum does not bind the bundle bytes.",
    );
  }
  if (
    manifest.archiveId !== bundle.intent.intentId ||
    manifest.operation !== bundle.intent.operation ||
    manifest.recordedAt !== bundle.intent.recordedAt ||
    manifest.intent.intentId !== bundle.intent.intentId ||
    !safeEqualHex(
      manifest.intent.intentSha256,
      bundle.intent.integrity.intentSha256,
    ) ||
    canonicalEvidenceJson(manifest.entries) !==
      canonicalEvidenceJson(bundle.intent.entries) ||
    manifest.storage.namespace !== bundle.intent.destination.namespace
  ) {
    throw new AccountingArchiveContractError(
      "Accounting archive manifest does not bind the export intent.",
    );
  }
  const bundleRef = manifest.artifacts.bundle;
  const checksumRef = manifest.artifacts.checksum;
  if (
    bundleRef.objectKey !== keys.bundle ||
    bundleRef.mediaType !== "application/json" ||
    bundleRef.sizeBytes !== String(bundleRaw.byteLength) ||
    !safeEqualHex(bundleRef.sha256, bundleSha256) ||
    checksumRef.objectKey !== keys.checksum ||
    checksumRef.mediaType !== "text/plain" ||
    checksumRef.sizeBytes !== String(checksumRaw.byteLength) ||
    !safeEqualHex(checksumRef.sha256, checksumSha256)
  ) {
    throw new AccountingArchiveContractError(
      "Accounting archive manifest artifact binding failed.",
    );
  }
  const receipt = {
    manifestObjectKey: keys.manifest,
    manifestVersionId: input.observedManifestVersionId,
    manifestSha256,
    bundleSha256,
    checksumSha256,
  };
  if (input.expectedReceipt) {
    const expected = input.expectedReceipt;
    if (
      expected.manifestObjectKey !== receipt.manifestObjectKey ||
      !objectVersionSchema.safeParse(expected.manifestVersionId).success ||
      expected.manifestVersionId !== receipt.manifestVersionId ||
      !safeEqualHex(expected.manifestSha256, receipt.manifestSha256) ||
      !safeEqualHex(expected.bundleSha256, receipt.bundleSha256) ||
      !safeEqualHex(expected.checksumSha256, receipt.checksumSha256)
    ) {
      throw new AccountingArchiveContractError(
        "Accounting archive receipt does not match the verified bytes.",
      );
    }
  }
  return { intent: bundle.intent, manifest, receipt };
}
