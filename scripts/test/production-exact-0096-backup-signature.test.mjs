import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  PINNED_PRODUCTION_HOST_EVIDENCE_KEYS,
  PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
} from "../../artifacts/api-server/src/lib/production-host-evidence-pinned-keys.mjs";
import { createProductionExact0096BackupPlan } from "../production-evidence/production-exact-0096-backup-planner.mjs";
import { runProductionExact0096BackupEvidenceExecutor } from "../production-evidence/production-exact-0096-backup-receipt.mjs";
import {
  createProductionExact0096BackupSignatureEnvelope,
  parseProductionExact0096BackupSignatureEnvelope,
  productionExact0096BackupSignaturePayload,
  verifyDetachedProductionExact0096BackupSignature,
} from "../production-evidence/production-exact-0096-backup-signature.mjs";
import {
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
} from "../production-evidence/production-migration-pinned-keys.mjs";
import {
  fixtureExecutorDependencies,
  fixturePlanInput,
} from "./production-exact-0096-backup-contract-fixtures.mjs";

async function fixture() {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const execution = await runProductionExact0096BackupEvidenceExecutor({
    planCanonical: plan.canonical,
    dependencies: fixtureExecutorDependencies(plan),
  });
  return { plan, execution };
}

test("migration backup authority aliases the single host/evidence trust root", () => {
  assert.strictEqual(
    PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
    PINNED_PRODUCTION_HOST_EVIDENCE_KEYS,
  );
  assert.strictEqual(
    PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
    PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
  );
  assert.deepEqual(PINNED_PRODUCTION_HOST_EVIDENCE_KEYS, {});
  assert.equal(PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256, null);
});

test("binds exact plan, executor trace and receipt to the host/evidence trust domain", async () => {
  const { plan, execution } = await fixture();
  const keyId = "ed25519:production-host-evidence-2026";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeySha256 = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const envelope = createProductionExact0096BackupSignatureEnvelope({
    planCanonical: plan.canonical,
    executorTraceCanonical: execution.trace.canonical,
    receiptCanonical: execution.receipt.canonical,
    keyId,
  });
  const detached = sign(
    null,
    productionExact0096BackupSignaturePayload(envelope.canonical),
    privateKey,
  );
  const verified = verifyDetachedProductionExact0096BackupSignature({
    envelopeCanonical: envelope.canonical,
    detachedSignature: detached,
    planCanonical: plan.canonical,
    executorTraceCanonical: execution.trace.canonical,
    receiptCanonical: execution.receipt.canonical,
    trustedHostAttestationKeys: { [keyId]: publicKeyPem },
    expectedHostEvidencePublicKeySha256: publicKeySha256,
  });
  assert.equal(verified.value.keyId, keyId);
  assert.equal(verified.publicKeySha256, publicKeySha256);
  assert.equal(verified.value.authorizesProductionMigration, false);
});

test("rejects uppercase normalization, unknown keys, wrong pins and substituted bytes", async () => {
  const { plan, execution } = await fixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const pin = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  assert.throws(
    () =>
      createProductionExact0096BackupSignatureEnvelope({
        planCanonical: plan.canonical,
        executorTraceCanonical: execution.trace.canonical,
        receiptCanonical: execution.receipt.canonical,
        keyId: "ED25519:production-host-evidence-2026",
      }),
    /exact lowercase/,
  );
  const keyId = "ed25519:production-host-evidence-2026";
  const envelope = createProductionExact0096BackupSignatureEnvelope({
    planCanonical: plan.canonical,
    executorTraceCanonical: execution.trace.canonical,
    receiptCanonical: execution.receipt.canonical,
    keyId,
  });
  const detached = sign(
    null,
    productionExact0096BackupSignaturePayload(envelope.canonical),
    privateKey,
  );
  const common = {
    envelopeCanonical: envelope.canonical,
    detachedSignature: detached,
    planCanonical: plan.canonical,
    executorTraceCanonical: execution.trace.canonical,
    receiptCanonical: execution.receipt.canonical,
    expectedHostEvidencePublicKeySha256: pin,
  };
  assert.throws(
    () =>
      verifyDetachedProductionExact0096BackupSignature({
        ...common,
        trustedHostAttestationKeys: {},
      }),
    /KEY_UNTRUSTED/,
  );
  assert.throws(
    () =>
      verifyDetachedProductionExact0096BackupSignature({
        ...common,
        trustedHostAttestationKeys: { [keyId]: publicKeyPem },
        expectedHostEvidencePublicKeySha256: `sha256:${"a".repeat(64)}`,
      }),
    /KEY_UNTRUSTED/,
  );
  const substituted = execution.receipt.canonical.replace(
    '"authorizesProductionMigration":false',
    '"authorizesProductionMigration":true',
  );
  assert.throws(
    () =>
      parseProductionExact0096BackupSignatureEnvelope(envelope.canonical, {
        planCanonical: plan.canonical,
        executorTraceCanonical: execution.trace.canonical,
        receiptCanonical: substituted,
      }),
    /authorizesProductionMigration|RECEIPT_INVALID/,
  );
});
