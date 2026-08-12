import { createHash, createPublicKey, verify } from "node:crypto";
import { PINNED_PRODUCTION_HOST_EVIDENCE_KEYS } from "./production-host-evidence-pinned-keys.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_ATTESTATION_LIFETIME_MS = 15 * 60_000;

const HOST_ATTESTATION_SCHEMA = "site-logbook.production-host-attestation/v1";
const HOST_ATTESTATION_KIND =
  "site-logbook-production-audit-0107-host-attestation";
const HOST_RUNNER_VERSION = "site-logbook-production-host-evidence-runner/v1";

const PRODUCTION_TARGET = Object.freeze({
  projectId: "bai77dzr0h7b5gu1jqwpriew",
  environmentId: "d5m70pb2i5s7c41n21vaokr7",
  applicationId: "ef09696arga7h9ox6ojgv7ru",
  environmentLabel: "production",
  logicalEnvironmentId: "site-logbook-production",
});

/**
 * Production keys are source-pinned, public SPKI PEM values. The signing key is
 * kept offline and is never accepted by the runtime or this repository.
 *
 * Activation remains fail-closed until the separate key-custody ceremony adds
 * one reviewed public key here. Unit tests inject a distinct ephemeral key.
 */
export const PINNED_PRODUCTION_HOST_ATTESTATION_KEYS: Readonly<
  Record<string, string>
> = PINNED_PRODUCTION_HOST_EVIDENCE_KEYS;

export interface ProductionObservedRunnerBinding {
  sourceSha: string;
  targetEvidenceSha256: string;
  releaseEvidenceSha256: string;
  activationApprovalSha256: string;
  apiImage: string;
  postgresImage: string;
  deployedConfigSha256: string;
  desiredConfigSha256: string;
  resolvedComposeSha256: string;
  livePostgresTargetSha256: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
}

export interface VerifiedProductionHostAttestation extends ProductionObservedRunnerBinding {
  keyId: string;
  attestationSha256: string;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface ProductionHostRunnerVerificationOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  trustedPublicKeys?: Readonly<Record<string, string>>;
}

export class ProductionHostRunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProductionHostRunnerError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductionHostRunnerError(code, message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): Record<string, unknown> {
  const object = objectAt(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SCHEMA_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return object;
}

function exactString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SCHEMA_INVALID",
      `${field} must be exact text.`,
    );
  }
  return value;
}

function exactSha(value: unknown, field: string): string {
  const result = exactString(value, field).toLowerCase();
  if (!SHA.test(result) || /^0{40}$/.test(result)) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_BINDING_INVALID",
      `${field} must be a Git SHA.`,
    );
  }
  return result;
}

function exactDigest(value: unknown, field: string): string {
  const result = exactString(value, field).toLowerCase();
  if (!DIGEST.test(result) || /^sha256:0{64}$/.test(result)) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_BINDING_INVALID",
      `${field} must be SHA-256.`,
    );
  }
  return result;
}

function exactImage(value: unknown, field: string): string {
  const result = exactString(value, field);
  if (!IMMUTABLE_IMAGE.test(result)) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_BINDING_INVALID",
      `${field} must be an immutable digest reference.`,
    );
  }
  return result;
}

function exactTime(
  value: unknown,
  field: string,
): { text: string; millis: number } {
  const text = exactString(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || !text.endsWith("Z")) {
    fail("PRODUCTION_HOST_ATTESTATION_TIME_INVALID", `${field} must be UTC.`);
  }
  return { text, millis };
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_BINDING_INVALID",
      `${field} does not match the reviewed runtime binding.`,
    );
  }
}

function strictBase64(value: string, field: string, maxBytes: number): Buffer {
  if (value.length === 0 || value.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_INVALID",
      `${field} is invalid or too large.`,
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString("base64") !== value
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_INVALID",
      `${field} is not canonical base64.`,
    );
  }
  return bytes;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("PRODUCTION_HOST_ATTESTATION_ENV_MISSING", `${key} is required.`);
  }
  return value;
}

const FORBIDDEN_KEY =
  /(password|passwd|secret|token|credential|private.?key|database.?url|access.?key|session|cookie)/i;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~+/-]+=*|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/i;

function assertSecretFree(value: unknown, field: string): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      fail(
        "PRODUCTION_HOST_ATTESTATION_SECRET_MATERIAL",
        `${field} contains secret-shaped material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(
        "PRODUCTION_HOST_ATTESTATION_SECRET_MATERIAL",
        `${field} contains a forbidden secret field.`,
      );
    }
    assertSecretFree(entry, `${field}.${key}`);
  }
}

function parseAttestation(bytes: Buffer): Record<string, unknown> {
  const raw = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_HOST_ATTESTATION_INVALID", "Attestation must be JSON.");
  }
  if (canonicalJson(value) !== raw) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_INVALID",
      "Attestation must be canonical JSON with one trailing LF.",
    );
  }
  assertSecretFree(value, "hostAttestation");
  return exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "runnerVersion",
      "keyId",
      "sourceSha",
      "logicalEnvironmentId",
      "coolify",
      "targetEvidenceSha256",
      "releaseEvidenceSha256",
      "activationApprovalSha256",
      "observedState",
      "observedAt",
      "issuedAt",
      "expiresAt",
      "nonce",
    ],
    "hostAttestation",
  );
}

/**
 * Verifies a fresh, detached, offline-signed host observation. Artifact and
 * signature may be transported through environment variables because neither
 * is trusted without a signature from a source-pinned public key.
 */
export async function requireObservedProductionHostRunner(
  rawBinding: ProductionObservedRunnerBinding,
  options: ProductionHostRunnerVerificationOptions = {},
): Promise<VerifiedProductionHostAttestation> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const trustedKeys =
    options.trustedPublicKeys ?? PINNED_PRODUCTION_HOST_ATTESTATION_KEYS;
  if (Object.keys(trustedKeys).length === 0) {
    fail(
      "PRODUCTION_HOST_TRUST_ROOT_UNPROVISIONED",
      "No reviewed production host attestation public key is source-pinned.",
    );
  }
  const binding = {
    sourceSha: exactSha(rawBinding.sourceSha, "binding.sourceSha"),
    targetEvidenceSha256: exactDigest(
      rawBinding.targetEvidenceSha256,
      "binding.targetEvidenceSha256",
    ),
    releaseEvidenceSha256: exactDigest(
      rawBinding.releaseEvidenceSha256,
      "binding.releaseEvidenceSha256",
    ),
    activationApprovalSha256: exactDigest(
      rawBinding.activationApprovalSha256,
      "binding.activationApprovalSha256",
    ),
    apiImage: exactImage(rawBinding.apiImage, "binding.apiImage"),
    postgresImage: exactImage(
      rawBinding.postgresImage,
      "binding.postgresImage",
    ),
    deployedConfigSha256: exactDigest(
      rawBinding.deployedConfigSha256,
      "binding.deployedConfigSha256",
    ),
    desiredConfigSha256: exactDigest(
      rawBinding.desiredConfigSha256,
      "binding.desiredConfigSha256",
    ),
    resolvedComposeSha256: exactDigest(
      rawBinding.resolvedComposeSha256,
      "binding.resolvedComposeSha256",
    ),
    livePostgresTargetSha256: exactDigest(
      rawBinding.livePostgresTargetSha256,
      "binding.livePostgresTargetSha256",
    ),
    databaseName: exactString(rawBinding.databaseName, "binding.databaseName"),
    databaseUser: exactString(rawBinding.databaseUser, "binding.databaseUser"),
    schemaFingerprintSha256: exactDigest(
      rawBinding.schemaFingerprintSha256,
      "binding.schemaFingerprintSha256",
    ),
  };
  requireEqual(
    binding.desiredConfigSha256,
    binding.deployedConfigSha256,
    "binding.desiredConfigSha256",
  );
  const attestationBytes = strictBase64(
    required(env, "PRODUCTION_HOST_ATTESTATION_B64"),
    "PRODUCTION_HOST_ATTESTATION_B64",
    MAX_ATTESTATION_BYTES,
  );
  const signature = strictBase64(
    required(env, "PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64"),
    "PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64",
    64,
  );
  if (signature.length !== 64) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SIGNATURE_INVALID",
      "Detached Ed25519 signature must be 64 bytes.",
    );
  }
  const attestation = parseAttestation(attestationBytes);
  const keyId = exactString(attestation.keyId, "hostAttestation.keyId");
  const publicKeyPem = trustedKeys[keyId];
  if (!publicKeyPem) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_KEY_UNTRUSTED",
      "Attestation key id is not source-pinned.",
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail(
      "PRODUCTION_HOST_ATTESTATION_KEY_INVALID",
      "Pinned public key is invalid.",
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(null, attestationBytes, publicKey, signature)
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SIGNATURE_INVALID",
      "Detached host attestation signature verification failed.",
    );
  }

  requireEqual(
    attestation.schemaVersion,
    HOST_ATTESTATION_SCHEMA,
    "hostAttestation.schemaVersion",
  );
  requireEqual(attestation.kind, HOST_ATTESTATION_KIND, "hostAttestation.kind");
  requireEqual(
    attestation.runnerVersion,
    HOST_RUNNER_VERSION,
    "hostAttestation.runnerVersion",
  );
  requireEqual(
    attestation.logicalEnvironmentId,
    PRODUCTION_TARGET.logicalEnvironmentId,
    "hostAttestation.logicalEnvironmentId",
  );
  requireEqual(
    exactSha(attestation.sourceSha, "hostAttestation.sourceSha"),
    binding.sourceSha,
    "hostAttestation.sourceSha",
  );
  requireEqual(
    exactDigest(
      attestation.targetEvidenceSha256,
      "hostAttestation.targetEvidenceSha256",
    ),
    binding.targetEvidenceSha256,
    "hostAttestation.targetEvidenceSha256",
  );
  requireEqual(
    exactDigest(
      attestation.releaseEvidenceSha256,
      "hostAttestation.releaseEvidenceSha256",
    ),
    binding.releaseEvidenceSha256,
    "hostAttestation.releaseEvidenceSha256",
  );
  requireEqual(
    exactDigest(
      attestation.activationApprovalSha256,
      "hostAttestation.activationApprovalSha256",
    ),
    binding.activationApprovalSha256,
    "hostAttestation.activationApprovalSha256",
  );

  const coolify = exactKeys(
    attestation.coolify,
    ["projectId", "environmentId", "applicationId", "environmentLabel"],
    "hostAttestation.coolify",
  );
  for (const key of [
    "projectId",
    "environmentId",
    "applicationId",
    "environmentLabel",
  ] as const) {
    requireEqual(
      coolify[key],
      PRODUCTION_TARGET[key],
      `hostAttestation.coolify.${key}`,
    );
  }

  const observedState = exactKeys(
    attestation.observedState,
    [
      "deployedConfigSha256",
      "desiredConfigSha256",
      "resolvedComposeSha256",
      "apiImage",
      "postgresImage",
      "livePostgresTargetSha256",
      "databaseName",
      "databaseUser",
      "schemaFingerprintSha256",
    ],
    "hostAttestation.observedState",
  );
  const deployedConfigSha256 = exactDigest(
    observedState.deployedConfigSha256,
    "hostAttestation.observedState.deployedConfigSha256",
  );
  requireEqual(
    deployedConfigSha256,
    binding.deployedConfigSha256,
    "hostAttestation.observedState.deployedConfigSha256",
  );
  requireEqual(
    exactDigest(
      observedState.desiredConfigSha256,
      "hostAttestation.observedState.desiredConfigSha256",
    ),
    deployedConfigSha256,
    "hostAttestation.observedState.desiredConfigSha256",
  );
  requireEqual(
    exactDigest(
      observedState.resolvedComposeSha256,
      "hostAttestation.observedState.resolvedComposeSha256",
    ),
    binding.resolvedComposeSha256,
    "hostAttestation.observedState.resolvedComposeSha256",
  );
  requireEqual(
    exactImage(
      observedState.apiImage,
      "hostAttestation.observedState.apiImage",
    ),
    binding.apiImage,
    "hostAttestation.observedState.apiImage",
  );
  requireEqual(
    exactImage(
      observedState.postgresImage,
      "hostAttestation.observedState.postgresImage",
    ),
    binding.postgresImage,
    "hostAttestation.observedState.postgresImage",
  );
  requireEqual(
    exactDigest(
      observedState.livePostgresTargetSha256,
      "hostAttestation.observedState.livePostgresTargetSha256",
    ),
    binding.livePostgresTargetSha256,
    "hostAttestation.observedState.livePostgresTargetSha256",
  );
  requireEqual(
    exactString(
      observedState.databaseName,
      "hostAttestation.observedState.databaseName",
    ),
    binding.databaseName,
    "hostAttestation.observedState.databaseName",
  );
  requireEqual(
    exactString(
      observedState.databaseUser,
      "hostAttestation.observedState.databaseUser",
    ),
    binding.databaseUser,
    "hostAttestation.observedState.databaseUser",
  );
  requireEqual(
    exactDigest(
      observedState.schemaFingerprintSha256,
      "hostAttestation.observedState.schemaFingerprintSha256",
    ),
    binding.schemaFingerprintSha256,
    "hostAttestation.observedState.schemaFingerprintSha256",
  );

  const observedAt = exactTime(
    attestation.observedAt,
    "hostAttestation.observedAt",
  );
  const issuedAt = exactTime(attestation.issuedAt, "hostAttestation.issuedAt");
  const expiresAt = exactTime(
    attestation.expiresAt,
    "hostAttestation.expiresAt",
  );
  if (
    observedAt.millis > issuedAt.millis ||
    issuedAt.millis > now + MAX_CLOCK_SKEW_MS ||
    expiresAt.millis <= issuedAt.millis ||
    expiresAt.millis - issuedAt.millis > MAX_ATTESTATION_LIFETIME_MS ||
    now > expiresAt.millis ||
    now - observedAt.millis > MAX_ATTESTATION_LIFETIME_MS
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_EXPIRED",
      "Host attestation is stale, expired or temporally invalid.",
    );
  }
  const nonce = exactString(attestation.nonce, "hostAttestation.nonce");
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_SCHEMA_INVALID",
      "hostAttestation.nonce must be 128-bit hex.",
    );
  }

  return Object.freeze({
    ...binding,
    keyId,
    attestationSha256: sha256(attestationBytes),
    observedAt: observedAt.text,
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
    nonce,
  });
}
