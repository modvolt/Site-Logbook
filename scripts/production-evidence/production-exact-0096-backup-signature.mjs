import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  canonicalProductionExact0096BackupJson,
  createProductionExact0096BackupArtifact,
  exactBackupDigest,
  exactBackupImmutableImage,
  exactBackupObject,
  exactBackupSourceSha,
  exactBackupString,
  productionExact0096BackupFail,
} from "./production-exact-0096-backup-contract.mjs";
import { parseProductionExact0096BackupPlan } from "./production-exact-0096-backup-planner.mjs";
import {
  parseProductionExact0096BackupExecutorTrace,
  parseProductionExact0096BackupReceipt,
} from "./production-exact-0096-backup-receipt.mjs";

export const PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_SCHEMA =
  "site-logbook.production-exact-0096-backup-signature-envelope/v1";
export const PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_DOMAIN =
  "site-logbook.production-exact-0096-backup-executor-signature/v1";

const KEY_ID = /^ed25519:[a-z0-9][a-z0-9._-]{2,63}$/;

function signaturePayload(canonical) {
  return Buffer.concat([
    Buffer.from(`${PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_DOMAIN}\0`, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
}

function exactLowercase(value, field, maximumLength) {
  const text = exactBackupString(value, field, maximumLength);
  if (text !== text.toLowerCase()) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_BINDING_INVALID",
      `${field} must already be exact lowercase bytes.`,
    );
  }
  return text;
}

export function createProductionExact0096BackupSignatureEnvelope({
  planCanonical,
  executorTraceCanonical,
  receiptCanonical,
  keyId,
}) {
  const plan = parseProductionExact0096BackupPlan(planCanonical);
  const trace = parseProductionExact0096BackupExecutorTrace(
    executorTraceCanonical,
    planCanonical,
  );
  const receipt = parseProductionExact0096BackupReceipt(
    receiptCanonical,
    planCanonical,
    executorTraceCanonical,
  );
  const sourceSha = exactLowercase(plan.value.sourceSha, "plan.sourceSha", 40);
  exactBackupSourceSha(sourceSha, "plan.sourceSha");
  const executorImageRef = exactLowercase(
    trace.value.producer.executorImageRef,
    "trace.producer.executorImageRef",
    512,
  );
  exactBackupImmutableImage(
    executorImageRef,
    "trace.producer.executorImageRef",
  );
  const canonicalKeyId = exactLowercase(keyId, "keyId", 128);
  if (!KEY_ID.test(canonicalKeyId)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_KEY_INVALID",
      "Backup signature key id is invalid.",
    );
  }
  return createProductionExact0096BackupArtifact({
    schemaVersion: PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_SCHEMA,
    kind: "site-logbook-production-exact-0096-backup-signature-envelope",
    signatureDomain: PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_DOMAIN,
    keyId: canonicalKeyId,
    sourceSha,
    executorImageRef,
    planSha256: plan.sha256,
    executorTraceSha256: trace.sha256,
    receiptSha256: receipt.sha256,
    authorizesProductionMigration: false,
  });
}

export function parseProductionExact0096BackupSignatureEnvelope(
  canonical,
  { planCanonical, executorTraceCanonical, receiptCanonical },
) {
  const parsed = JSON.parse(canonical);
  const envelope = exactBackupObject(
    parsed,
    [
      "authorizesProductionMigration",
      "executorImageRef",
      "executorTraceSha256",
      "keyId",
      "kind",
      "planSha256",
      "receiptSha256",
      "schemaVersion",
      "signatureDomain",
      "sourceSha",
    ],
    "backupSignatureEnvelope",
  );
  if (canonicalProductionExact0096BackupJson(envelope) !== canonical) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_BINDING_INVALID",
      "Backup signature envelope must be canonical JSON with one LF.",
    );
  }
  const expected = createProductionExact0096BackupSignatureEnvelope({
    planCanonical,
    executorTraceCanonical,
    receiptCanonical,
    keyId: envelope.keyId,
  });
  if (expected.canonical !== canonical) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_BINDING_INVALID",
      "Backup signature envelope does not bind the exact plan, trace and receipt.",
    );
  }
  return expected;
}

export function verifyDetachedProductionExact0096BackupSignature({
  envelopeCanonical,
  detachedSignature,
  planCanonical,
  executorTraceCanonical,
  receiptCanonical,
  trustedHostAttestationKeys,
  expectedHostEvidencePublicKeySha256,
}) {
  const envelope = parseProductionExact0096BackupSignatureEnvelope(
    envelopeCanonical,
    { planCanonical, executorTraceCanonical, receiptCanonical },
  );
  if (
    !trustedHostAttestationKeys ||
    typeof trustedHostAttestationKeys !== "object" ||
    Array.isArray(trustedHostAttestationKeys)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_KEY_UNTRUSTED",
      "The source-pinned host/evidence public key map is unavailable.",
    );
  }
  const publicKeyPem = trustedHostAttestationKeys[envelope.value.keyId];
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_KEY_UNTRUSTED",
      "Backup signature key id is not in the source-pinned host/evidence trust domain.",
    );
  }
  const signature = Buffer.isBuffer(detachedSignature)
    ? detachedSignature
    : Buffer.from(
        exactBackupString(detachedSignature, "detachedSignature", 256),
        "base64",
      );
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_KEY_INVALID",
      "Backup signature public key is invalid.",
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    !verifySignature(
      null,
      signaturePayload(envelope.canonical),
      publicKey,
      signature,
    )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_INVALID",
      "Detached backup executor signature is invalid.",
    );
  }
  const publicKeySha256 = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  exactBackupDigest(
    expectedHostEvidencePublicKeySha256,
    "expectedHostEvidencePublicKeySha256",
  );
  if (publicKeySha256 !== expectedHostEvidencePublicKeySha256) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SIGNATURE_KEY_UNTRUSTED",
      "Backup signature key does not equal the approved host/evidence public-key pin.",
    );
  }
  return Object.freeze({
    ...envelope,
    publicKeySha256,
    detachedSignatureSha256: `sha256:${createHash("sha256")
      .update(signature)
      .digest("hex")}`,
  });
}

export function productionExact0096BackupSignaturePayload(envelopeCanonical) {
  return signaturePayload(envelopeCanonical);
}
