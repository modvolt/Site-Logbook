import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  readFile,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";

export const PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES = 512 * 1024;
export const PRODUCTION_ACTIVATION_PUBLIC_KEY_MAX_BYTES = 16 * 1024;
export const PRODUCTION_ACTIVATION_MAX_LIFETIME_MS = 10 * 60 * 1000;
export const PRODUCTION_ACTIVATION_MAX_CLOCK_SKEW_MS = 30 * 1000;
export const PRODUCTION_ACTIVATION_HEALTH_PATH =
  "/.well-known/site-logbook-container-health";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_PIN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const CONTAINER_ID = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
const NONCE = /^[0-9a-f]{64}$/;
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FORBIDDEN_KEY =
  /(?:password|secret|private.?key|access.?key|session|cookie|token|authorization|database.?url|mnemonic|passphrase)/i;
const PUBLIC_IDENTITY_OR_POLICY_KEYS = new Set([
  "adminSessionUser",
  "sessionUser",
  "requiresExplicitCoolifySecretTransfer",
]);

type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ProductionActivationExpectedBinding {
  sourceSha: string;
  apiImage: string;
  containerId: string;
  nonce: string;
}

export interface ProductionActivationBundleV2 {
  activation: Readonly<Record<string, JsonValue>>;
  activationSignature: Readonly<Record<string, JsonValue>>;
  hostAttestation: Readonly<Record<string, JsonValue>>;
  hostAttestationSignature: Readonly<Record<string, JsonValue>>;
}

export interface ProductionActivationChallenge extends ProductionActivationExpectedBinding {
  kind: "site-logbook-production-activation-challenge-v2";
}

export interface ProductionActivationSemanticVerifier<RuntimeAuthority = void> {
  (bundle: ProductionActivationBundleV2): Promise<RuntimeAuthority>;
}

export type ProductionActivationHoldState =
  | "HOLD"
  | "ACTIVATING"
  | "ACTIVE"
  | "STOPPED";

export interface ProductionActivationHoldOptions<RuntimeAuthority = void> {
  port: number;
  host?: string;
  evidenceFile: string;
  publisherPublicKeyFile: string;
  publisherPublicKeySha256: string;
  hostPublicKeyFile: string;
  hostPublicKeySha256: string;
  expected: Omit<ProductionActivationExpectedBinding, "nonce">;
  nonce?: string;
  pollIntervalMs?: number;
  closeTimeoutMs?: number;
  now?: () => number;
  loadSemanticVerifier: () => Promise<
    ProductionActivationSemanticVerifier<RuntimeAuthority>
  >;
  startRuntime: (authority: RuntimeAuthority) => Promise<void>;
  onFatal?: (error: unknown) => void;
  onEvent?: (event: Readonly<Record<string, JsonValue>>) => void;
}

export interface ProductionActivationHoldController {
  readonly challenge: ProductionActivationChallenge;
  readonly state: ProductionActivationHoldState;
  readonly lastRejectionCode: string | null;
  readonly port: number;
  checkNow(): Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
}

export class ProductionActivationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProductionActivationError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductionActivationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("PRODUCTION_ACTIVATION_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SCHEMA_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    (pattern && !pattern.test(value))
  ) {
    fail("PRODUCTION_ACTIVATION_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(
      "PRODUCTION_ACTIVATION_BINDING_MISMATCH",
      `${field} does not match the running immutable container.`,
    );
  }
}

function canonicalize(value: unknown, field = "value"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail(
        "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
        `${field} contains a non-safe-integer number.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return result;
  }
  fail(
    "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
    `${field} contains a non-JSON value.`,
  );
}

export function canonicalProductionActivationJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

export async function readStableRegularFile(
  file: string,
  maximumBytes: number,
): Promise<Buffer> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(
      "PRODUCTION_ACTIVATION_FILE_UNSAFE",
      "evidence must be one regular, non-symlink, single-link file.",
    );
  }
  if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
    fail(
      "PRODUCTION_ACTIVATION_FILE_SIZE_INVALID",
      `evidence must be between 1 and ${maximumBytes} bytes.`,
    );
  }

  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) {
      fail(
        "PRODUCTION_ACTIVATION_FILE_CHANGED",
        "evidence changed while it was being opened.",
      );
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        maximumBytes + 1 - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      fail(
        "PRODUCTION_ACTIVATION_FILE_SIZE_INVALID",
        `evidence exceeds ${maximumBytes} bytes.`,
      );
    }
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(file, { bigint: true });
    if (
      !sameIdentity(opened, afterRead) ||
      !sameIdentity(afterRead, afterPath) ||
      BigInt(offset) !== afterRead.size
    ) {
      fail(
        "PRODUCTION_ACTIVATION_FILE_CHANGED",
        "evidence was not stable for the complete bounded read.",
      );
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseCanonicalBundle(bytes: Buffer): unknown {
  if (bytes.includes(0x0d)) {
    fail(
      "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
      "activation evidence must use canonical LF bytes.",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(
      "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
      "activation evidence must be valid UTF-8.",
    );
  }
  if (!text.endsWith("\n") || text.endsWith("\n\n")) {
    fail(
      "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
      "activation evidence must end in exactly one LF.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(
      "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
      "activation evidence must be valid JSON.",
    );
  }
  if (canonicalProductionActivationJson(parsed) !== text) {
    fail(
      "PRODUCTION_ACTIVATION_CANONICAL_INVALID",
      "activation evidence bytes are not canonical sorted-key JSON.",
    );
  }
  return parsed;
}

function scanForPrivateMaterial(value: unknown, field = "bundle"): void {
  if (typeof value === "string") {
    if (
      /-----BEGIN [^-]*PRIVATE KEY-----/i.test(value) ||
      /(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s/@:]+:[^\s/@]+@/i.test(
        value,
      ) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
      /\bSCRAM-SHA-256\$/.test(value) ||
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value) ||
      /\b(?:github_pat_|ghp_)[A-Za-z0-9_]+\b/.test(value)
    ) {
      fail(
        "PRODUCTION_ACTIVATION_PRIVATE_MATERIAL",
        `${field} contains forbidden private material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForPrivateMaterial(item, `${field}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key) && !PUBLIC_IDENTITY_OR_POLICY_KEYS.has(key)) {
        fail(
          "PRODUCTION_ACTIVATION_PRIVATE_MATERIAL",
          `${field}.${key} is a forbidden private-material field.`,
        );
      }
      scanForPrivateMaterial(item, `${field}.${key}`);
    }
  }
}

function validateArtifact(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const artifact = exactObject(value, ["kind", "payload", "sha256"], field);
  requiredString(artifact.kind, `${field}.kind`, ARTIFACT_KIND);
  const digest = requiredString(artifact.sha256, `${field}.sha256`, SHA256);
  const payloadBytes = canonicalProductionActivationJson(artifact.payload);
  requireEqual(sha256(payloadBytes), digest, `${field}.sha256`);
  return artifact;
}

function validateApiImageProvenance(value: unknown): void {
  const provenance = exactObject(
    value,
    ["canonical", "signatureB64"],
    "activation.evidence.apiImageProvenance",
  );
  requiredString(
    provenance.canonical,
    "activation.evidence.apiImageProvenance.canonical",
  );
  const signatureB64 = requiredString(
    provenance.signatureB64,
    "activation.evidence.apiImageProvenance.signatureB64",
    /^[A-Za-z0-9+/]{86}==$/,
  );
  const signature = Buffer.from(signatureB64, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureB64
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SCHEMA_INVALID",
      "activation.evidence.apiImageProvenance.signatureB64 must be one canonical padded-base64 Ed25519 signature.",
    );
  }
}

function validateEvidence(value: unknown): Record<string, unknown> {
  const evidence = exactObject(
    value,
    [
      "activationApproval",
      "apiImageProvenance",
      "exact0096Backup",
      "finalObservations",
      "migration0096To0107",
      "runtimeDatabaseCredentialCutover",
    ],
    "activation.evidence",
  );
  validateApiImageProvenance(evidence.apiImageProvenance);
  const backup = exactObject(
    evidence.exact0096Backup,
    ["detachedSignature", "passReceipt", "plan", "signature", "trace"],
    "activation.evidence.exact0096Backup",
  );
  for (const key of [
    "plan",
    "trace",
    "passReceipt",
    "signature",
    "detachedSignature",
  ] as const) {
    validateArtifact(backup[key], `activation.evidence.exact0096Backup.${key}`);
  }

  const migration = exactObject(
    evidence.migration0096To0107,
    [
      "finalLive",
      "intent",
      "persistence",
      "plan",
      "postcommit",
      "receipts",
      "role",
      "transitionPass",
    ],
    "activation.evidence.migration0096To0107",
  );
  for (const key of [
    "plan",
    "intent",
    "persistence",
    "finalLive",
    "role",
    "postcommit",
    "transitionPass",
  ] as const) {
    validateArtifact(
      migration[key],
      `activation.evidence.migration0096To0107.${key}`,
    );
  }
  if (!Array.isArray(migration.receipts) || migration.receipts.length !== 10) {
    fail(
      "PRODUCTION_ACTIVATION_SCHEMA_INVALID",
      "activation.evidence.migration0096To0107.receipts must contain exactly 10 artifacts.",
    );
  }
  migration.receipts.forEach((receipt, index) =>
    validateArtifact(
      receipt,
      `activation.evidence.migration0096To0107.receipts[${index}]`,
    ),
  );

  const credential = exactObject(
    evidence.runtimeDatabaseCredentialCutover,
    ["passReceipt", "request"],
    "activation.evidence.runtimeDatabaseCredentialCutover",
  );
  validateArtifact(
    credential.request,
    "activation.evidence.runtimeDatabaseCredentialCutover.request",
  );
  validateArtifact(
    credential.passReceipt,
    "activation.evidence.runtimeDatabaseCredentialCutover.passReceipt",
  );
  const observations = exactObject(
    evidence.finalObservations,
    ["coolify", "docker", "postgres"],
    "activation.evidence.finalObservations",
  );
  for (const key of ["coolify", "docker", "postgres"] as const) {
    validateArtifact(
      observations[key],
      `activation.evidence.finalObservations.${key}`,
    );
  }
  validateArtifact(
    evidence.activationApproval,
    "activation.evidence.activationApproval",
  );
  return evidence;
}

function parseTimestamp(value: unknown, field: string): number {
  const text = requiredString(value, field);
  const timestamp = Date.parse(text);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== text
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  return timestamp;
}

function validateTimeWindow(
  issuedAt: number,
  expiresAt: number,
  now: number,
): void {
  if (
    issuedAt > now + PRODUCTION_ACTIVATION_MAX_CLOCK_SKEW_MS ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > PRODUCTION_ACTIVATION_MAX_LIFETIME_MS ||
    now - issuedAt > PRODUCTION_ACTIVATION_MAX_LIFETIME_MS
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TIME_INVALID",
      "activation evidence is expired, future-dated, or outside its bounded lifetime.",
    );
  }
}

function validateSignatureObject(
  value: unknown,
  field: string,
  expectedKeyId: string,
): Buffer {
  const signature = exactObject(
    value,
    ["algorithm", "keyId", "signatureBase64"],
    field,
  );
  requireEqual(signature.algorithm, "Ed25519", `${field}.algorithm`);
  requireEqual(signature.keyId, expectedKeyId, `${field}.keyId`);
  const encoded = requiredString(
    signature.signatureBase64,
    `${field}.signatureBase64`,
    BASE64,
  );
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
    fail(
      "PRODUCTION_ACTIVATION_SIGNATURE_INVALID",
      `${field}.signatureBase64 is not one canonical Ed25519 signature.`,
    );
  }
  return decoded;
}

async function readTrustedPublicKey(
  file: string,
  expectedSha256: string,
): Promise<{
  key: ReturnType<typeof createPublicKey>;
  spkiDer: Buffer;
  fingerprint: string;
}> {
  requiredString(expectedSha256, "trustedPublicKeySha256", SHA256_PIN);
  const bytes = await readStableRegularFile(
    file,
    PRODUCTION_ACTIVATION_PUBLIC_KEY_MAX_BYTES,
  );
  if (
    bytes.includes(0x0d) ||
    !bytes.toString("utf8").endsWith("\n") ||
    /PRIVATE KEY/i.test(bytes.toString("utf8"))
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRUST_KEY_INVALID",
      "trusted public key must be canonical LF public PEM bytes.",
    );
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(bytes);
  } catch {
    fail(
      "PRODUCTION_ACTIVATION_TRUST_KEY_INVALID",
      "trusted public key cannot be parsed.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail(
      "PRODUCTION_ACTIVATION_TRUST_KEY_INVALID",
      "trusted public key must be Ed25519.",
    );
  }
  const canonicalPem = Buffer.from(
    key.export({ type: "spki", format: "pem" }).toString(),
    "utf8",
  );
  if (!bytes.equals(canonicalPem)) {
    fail(
      "PRODUCTION_ACTIVATION_TRUST_KEY_INVALID",
      "trusted public key must use the exact canonical SPKI PEM encoding.",
    );
  }
  const spkiDer = key.export({ type: "spki", format: "der" });
  const fingerprint = `sha256:${sha256(spkiDer)}`;
  requireEqual(fingerprint, expectedSha256, "trustedPublicKeySha256");
  return { key, spkiDer, fingerprint };
}

export async function validateProductionActivationBundleTransport(
  bytes: Buffer,
  expected: ProductionActivationExpectedBinding,
  publisherPublicKeyFile: string,
  publisherPublicKeySha256: string,
  hostPublicKeyFile: string,
  hostPublicKeySha256: string,
  now = Date.now(),
): Promise<ProductionActivationBundleV2> {
  const parsed = parseCanonicalBundle(bytes);
  scanForPrivateMaterial(parsed);
  const root = exactObject(
    parsed,
    [
      "activation",
      "activationSignature",
      "hostAttestation",
      "hostAttestationSignature",
    ],
    "bundle",
  );
  const activation = exactObject(
    root.activation,
    [
      "apiImage",
      "containerId",
      "deployedConfigSha256",
      "desiredConfigSha256",
      "evidence",
      "expiresAt",
      "hostAttestationSha256",
      "issuedAt",
      "kind",
      "nonce",
      "resolvedComposeSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "activation",
  );
  requireEqual(
    activation.kind,
    "site-logbook-production-activation-bundle-v2",
    "activation.kind",
  );
  requireEqual(activation.schemaVersion, 2, "activation.schemaVersion");
  requiredString(activation.sourceSha, "activation.sourceSha", SOURCE_SHA);
  requiredString(activation.apiImage, "activation.apiImage", IMAGE);
  requiredString(
    activation.containerId,
    "activation.containerId",
    CONTAINER_ID,
  );
  requiredString(activation.nonce, "activation.nonce", NONCE);
  for (const key of [
    "desiredConfigSha256",
    "deployedConfigSha256",
    "resolvedComposeSha256",
    "hostAttestationSha256",
  ] as const) {
    requiredString(activation[key], `activation.${key}`, SHA256);
  }
  const issuedAt = parseTimestamp(activation.issuedAt, "activation.issuedAt");
  const expiresAt = parseTimestamp(
    activation.expiresAt,
    "activation.expiresAt",
  );
  validateTimeWindow(issuedAt, expiresAt, now);

  requireEqual(
    activation.sourceSha,
    expected.sourceSha,
    "activation.sourceSha",
  );
  requireEqual(activation.apiImage, expected.apiImage, "activation.apiImage");
  requireEqual(
    activation.containerId,
    expected.containerId,
    "activation.containerId",
  );
  requireEqual(activation.nonce, expected.nonce, "activation.nonce");

  const evidence = validateEvidence(activation.evidence);
  const hostAttestation = exactObject(
    root.hostAttestation,
    [
      "activationEvidenceSha256",
      "apiImage",
      "containerId",
      "deployedConfigSha256",
      "desiredConfigSha256",
      "kind",
      "nonce",
      "observedAt",
      "resolvedComposeSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "hostAttestation",
  );
  requireEqual(
    hostAttestation.kind,
    "site-logbook-production-host-attestation-v2",
    "hostAttestation.kind",
  );
  requireEqual(
    hostAttestation.schemaVersion,
    2,
    "hostAttestation.schemaVersion",
  );
  for (const key of [
    "sourceSha",
    "apiImage",
    "desiredConfigSha256",
    "deployedConfigSha256",
    "resolvedComposeSha256",
    "containerId",
    "nonce",
  ] as const) {
    requireEqual(
      hostAttestation[key],
      activation[key],
      `hostAttestation.${key}`,
    );
  }
  const observedAt = parseTimestamp(
    hostAttestation.observedAt,
    "hostAttestation.observedAt",
  );
  if (
    observedAt > issuedAt ||
    now - observedAt > PRODUCTION_ACTIVATION_MAX_LIFETIME_MS
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TIME_INVALID",
      "host attestation is future-ordered or stale.",
    );
  }
  requireEqual(
    hostAttestation.activationEvidenceSha256,
    sha256(canonicalProductionActivationJson(evidence)),
    "hostAttestation.activationEvidenceSha256",
  );
  requireEqual(
    activation.hostAttestationSha256,
    sha256(canonicalProductionActivationJson(hostAttestation)),
    "activation.hostAttestationSha256",
  );

  const publisherTrust = await readTrustedPublicKey(
    publisherPublicKeyFile,
    publisherPublicKeySha256,
  );
  const hostTrust = await readTrustedPublicKey(
    hostPublicKeyFile,
    hostPublicKeySha256,
  );
  if (
    publisherTrust.fingerprint === hostTrust.fingerprint ||
    publisherTrust.spkiDer.equals(hostTrust.spkiDer)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRUST_KEY_INVALID",
      "publisher and host attestation must use distinct pinned Ed25519 SPKI keys.",
    );
  }
  const activationSignature = validateSignatureObject(
    root.activationSignature,
    "activationSignature",
    publisherPublicKeySha256,
  );
  const hostSignature = validateSignatureObject(
    root.hostAttestationSignature,
    "hostAttestationSignature",
    hostPublicKeySha256,
  );
  if (
    !verify(
      null,
      Buffer.from(canonicalProductionActivationJson(activation)),
      publisherTrust.key,
      activationSignature,
    )
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SIGNATURE_INVALID",
      "activation bundle signature does not verify against the pinned key.",
    );
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalProductionActivationJson(hostAttestation)),
      hostTrust.key,
      hostSignature,
    )
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SIGNATURE_INVALID",
      "host attestation signature does not verify against the pinned key.",
    );
  }

  return Object.freeze({
    activation: activation as Readonly<Record<string, JsonValue>>,
    activationSignature: root.activationSignature as Readonly<
      Record<string, JsonValue>
    >,
    hostAttestation: hostAttestation as Readonly<Record<string, JsonValue>>,
    hostAttestationSignature: root.hostAttestationSignature as Readonly<
      Record<string, JsonValue>
    >,
  });
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function productionHoldResponse(
  path: string,
  method: string | undefined,
  remoteAddress: string | undefined,
  challenge: ProductionActivationChallenge,
  rejectionCode: string | null,
): Readonly<{ status: number; body: Readonly<Record<string, JsonValue>> }> {
  if (
    path === PRODUCTION_ACTIVATION_HEALTH_PATH &&
    (method === "GET" || method === "HEAD") &&
    isLoopback(remoteAddress)
  ) {
    return Object.freeze({
      status: 200,
      body: Object.freeze({
        activation: "HOLD",
        processHealthy: true,
        status: "hold",
      }),
    });
  }
  return Object.freeze({
    status: 503,
    body: Object.freeze({
      activation: "HOLD",
      activationBlocked: true,
      containerId: challenge.containerId,
      nonce: challenge.nonce,
      rejectionCode,
      sourceSha: challenge.sourceSha,
      status: "service_unavailable",
    }),
  });
}

function responsePath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://hold.invalid").pathname;
  } catch {
    return "/";
  }
}

function closeServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new ProductionActivationError(
          "PRODUCTION_ACTIVATION_CLOSE_TIMEOUT",
          "HOLD listener did not close within the bounded timeout.",
        ),
      );
    }, timeoutMs);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function rejectionCode(error: unknown): string {
  if (error instanceof ProductionActivationError) return error.code;
  if (isRecord(error) && typeof error.code === "string") {
    if (error.code === "ENOENT") return "PRODUCTION_ACTIVATION_BUNDLE_ABSENT";
  }
  return "PRODUCTION_ACTIVATION_REJECTED";
}

export async function readContainerId(
  hostnameFile = "/etc/hostname",
): Promise<string> {
  const value = (await readFile(hostnameFile, "utf8")).trim().toLowerCase();
  return requiredString(value, "containerId", CONTAINER_ID);
}

export async function startProductionActivationHold<RuntimeAuthority = void>(
  options: ProductionActivationHoldOptions<RuntimeAuthority>,
): Promise<ProductionActivationHoldController> {
  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  requiredString(nonce, "nonce", NONCE);
  const challenge: ProductionActivationChallenge = Object.freeze({
    kind: "site-logbook-production-activation-challenge-v2",
    ...options.expected,
    nonce,
  });
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 25) {
    fail(
      "PRODUCTION_ACTIVATION_CONFIGURATION_INVALID",
      "pollIntervalMs must be an integer of at least 25ms.",
    );
  }

  let state: ProductionActivationHoldState = "HOLD";
  let lastRejectionCode: string | null = null;
  let activation: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopRequested = false;
  let fatalHandled = false;
  let activationStarted = false;
  let actualPort = options.port;

  const server = createServer((request, response) => {
    const result = productionHoldResponse(
      responsePath(request),
      request.method,
      request.socket.remoteAddress,
      challenge,
      lastRejectionCode,
    );
    const body = `${JSON.stringify(result.body)}\n`;
    response.statusCode = result.status;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(body));
    if (request.method === "HEAD") response.end();
    else response.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address === "object") actualPort = address.port;
      resolve();
    });
  });

  const emit = (event: Readonly<Record<string, JsonValue>>): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Telemetry is never allowed to suppress a safety transition or fatal
      // process termination.
    }
  };

  const handleFatal = async (error: unknown): Promise<void> => {
    if (fatalHandled) return;
    fatalHandled = true;
    stopRequested = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (server.listening) {
      server.closeAllConnections();
      try {
        await closeServer(server, closeTimeoutMs);
      } catch {
        server.closeAllConnections();
      }
    }
    state = "STOPPED";
    lastRejectionCode = rejectionCode(error);
    emit(
      Object.freeze({
        event: "production-activation-fatal",
        rejectionCode: lastRejectionCode,
      }),
    );
    try {
      options.onFatal?.(error);
    } catch {
      process.exitCode = 1;
    }
  };

  const checkNow = async (): Promise<void> => {
    if (state !== "HOLD") {
      if (activation) await activation;
      return;
    }
    if (activation) {
      await activation;
      return;
    }
    activation = (async () => {
      try {
        const bytes = await readStableRegularFile(
          options.evidenceFile,
          PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES,
        );
        const bundle = await validateProductionActivationBundleTransport(
          bytes,
          challenge,
          options.publisherPublicKeyFile,
          options.publisherPublicKeySha256,
          options.hostPublicKeyFile,
          options.hostPublicKeySha256,
          now(),
        );
        const semanticVerifier = await options.loadSemanticVerifier();
        const runtimeAuthority = await semanticVerifier(bundle);
        if (stopRequested || state !== "HOLD") return;
        state = "ACTIVATING";
        activationStarted = true;
        lastRejectionCode = null;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        await closeServer(server, closeTimeoutMs);
        if (stopRequested) return;
        await options.startRuntime(runtimeAuthority);
        if (stopRequested || state !== "ACTIVATING") return;
        state = "ACTIVE";
        emit(Object.freeze({ event: "production-activation-started" }));
      } catch (error) {
        if (activationStarted) {
          await handleFatal(error);
          throw error;
        }
        lastRejectionCode = rejectionCode(error);
        emit(
          Object.freeze({
            event: "production-activation-hold",
            rejectionCode: lastRejectionCode,
          }),
        );
      } finally {
        if (state === "HOLD") activation = null;
      }
    })();
    await activation;
  };

  timer = setInterval(() => {
    void checkNow().catch((error) => {
      void handleFatal(error);
    });
  }, pollIntervalMs);
  timer.unref();
  void checkNow().catch((error) => {
    void handleFatal(error);
  });

  return Object.freeze({
    challenge,
    get state() {
      return state;
    },
    get lastRejectionCode() {
      return lastRejectionCode;
    },
    get port() {
      return actualPort;
    },
    checkNow,
    async stop(timeoutMs = closeTimeoutMs): Promise<void> {
      stopRequested = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (state === "STOPPED") return;
      if (server.listening) await closeServer(server, timeoutMs);
      state = "STOPPED";
    },
  });
}
