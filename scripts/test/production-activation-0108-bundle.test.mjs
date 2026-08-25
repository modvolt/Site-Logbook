import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProductionActivationBundleTransport } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import {
  PRODUCTION_ACTIVATION_0108_BUNDLE_CONFIRMATION,
  canonicalProductionActivationBundleJson,
  publishProductionActivation0108Bundle,
} from "../production-evidence/run-production-activation-bundle.mjs";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const SOURCE_SHA = "1".repeat(40);
const API_IMAGE = `ghcr.io/modvolt/site-logbook-api@sha256:${"2".repeat(64)}`;
const CONTAINER = "a".repeat(64);
const NONCE = "b".repeat(64);
const DESIRED = "3".repeat(64);
const RESOLVED = "4".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(kind, payload) {
  return {
    kind,
    payload,
    sha256: sha256(canonicalProductionActivationBundleJson(payload)),
  };
}

function simple(kind, extra = {}) {
  return artifact(kind, { revision: 3, ...extra });
}

function predecessorApproval() {
  return {
    schemaVersion: "site-logbook.production-activation-approval/v2",
    kind: "site-logbook-production-activation-approval-v2",
    decision: "APPROVE",
    confirmation: "AUTHORIZE_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_V2",
    sourceSha: SOURCE_SHA,
    apiImage: API_IMAGE,
    nonce: NONCE,
    containerId: CONTAINER,
    desiredConfigSha256: DESIRED,
    deployedConfigSha256: DESIRED,
    resolvedComposeSha256: RESOLVED,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: `sha256:${"5".repeat(64)}`,
    composeProject: "site_logbook",
    postgresService: "postgres",
    postgresVolumeDestination: "/var/lib/postgresql/data",
    expectedNetworkServices: ["api", "postgres", "web"],
    migrationTransitionSha256: `sha256:${"6".repeat(64)}`,
    finalLiveIdentitySha256: `sha256:${"7".repeat(64)}`,
    credentialRequestSha256: `sha256:${"8".repeat(64)}`,
    credentialReceiptSha256: `sha256:${"9".repeat(64)}`,
    coolifyObservationSha256: `sha256:${"a".repeat(64)}`,
    dockerObservationSha256: `sha256:${"b".repeat(64)}`,
    postgresObservationSha256: `sha256:${"c".repeat(64)}`,
    approvedAt: new Date(NOW - 1_000).toISOString(),
    operator: "modvolt-release-owner",
    authorizesApplicationStart: true,
    authorizesDeployment: false,
  };
}

function evidence() {
  return {
    activationApproval: artifact(
      "predecessor-activation-approval",
      predecessorApproval(),
    ),
    apiImageProvenance: {
      canonical: canonicalProductionActivationBundleJson({ revision: 2 }),
      signatureB64: Buffer.alloc(64, 7).toString("base64"),
    },
    exact0096Backup: {
      plan: simple("backup-plan"),
      trace: simple("backup-trace"),
      passReceipt: simple("backup-pass-receipt"),
      signature: simple("backup-signature"),
      detachedSignature: simple("backup-detached-signature"),
    },
    migration0096To0107: {
      plan: simple("migration-plan"),
      intent: simple("migration-intent"),
      persistence: simple("migration-persistence"),
      receipts: Array.from({ length: 10 }, (_, index) =>
        simple(`migration-receipt-${index + 1}`, { index }),
      ),
      finalLive: simple("migration-final-live"),
      role: simple("migration-role"),
      postcommit: simple("migration-postcommit"),
      transitionPass: simple("migration-transition-pass"),
    },
    runtimeDatabaseCredentialCutover: {
      request: simple("runtime-credential-request"),
      passReceipt: simple("runtime-credential-pass-receipt", {
        verification: {
          freshSecretGeneratedByControlPlane: true,
          secretBytesAbsentFromEvidenceAndLogs: true,
        },
      }),
    },
    finalObservations: {
      coolify: artifact("coolify-observation", {
        observedAt: new Date(NOW - 4_000).toISOString(),
      }),
      docker: artifact("docker-observation", {
        observedAt: new Date(NOW - 3_000).toISOString(),
      }),
      postgres: artifact("postgres-observation", {
        observedAt: new Date(NOW - 2_000).toISOString(),
      }),
    },
    migration0107To0108: {
      activationApproval: simple("invoice-0108-activation-approval"),
      backupRestoreReference: simple("invoice-0108-backup-reference"),
      intent: simple("invoice-0108-intent"),
      migrationReceipt: simple("invoice-0108-migration-receipt"),
      plan: simple("invoice-0108-plan"),
      roleReceipt: simple("invoice-0108-role-receipt"),
      schemaReadiness: simple("invoice-0108-schema-readiness"),
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "activation-0108-test-"));
  const inputs = path.join(root, "inputs");
  const outputs = path.join(root, "outputs");
  await Promise.all([mkdir(inputs), mkdir(outputs)]);
  const challengeFile = path.join(inputs, "challenge.json");
  const evidenceFile = path.join(inputs, "evidence.json");
  const publisherPublicKeyFile = path.join(inputs, "publisher.pem");
  const hostPublicKeyFile = path.join(inputs, "host.pem");
  const output = path.join(outputs, "activation-bundle-v3.json");
  const publisher = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  const challenge = {
    kind: "site-logbook-production-activation-challenge-v3",
    sourceSha: SOURCE_SHA,
    apiImage: API_IMAGE,
    containerId: CONTAINER,
    nonce: NONCE,
  };
  await Promise.all([
    writeFile(
      challengeFile,
      canonicalProductionActivationBundleJson(challenge),
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(
      evidenceFile,
      canonicalProductionActivationBundleJson(evidence()),
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(
      publisherPublicKeyFile,
      publisher.publicKey.export({ type: "spki", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(
      hostPublicKeyFile,
      host.publicKey.export({ type: "spki", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    ),
  ]);
  return {
    root,
    challenge,
    publisher,
    host,
    output,
    options: {
      challenge: challengeFile,
      confirm: PRODUCTION_ACTIVATION_0108_BUNDLE_CONFIRMATION,
      evidence: evidenceFile,
      "host-public-key": hostPublicKeyFile,
      output,
      "publisher-public-key": publisherPublicKeyFile,
      vault: path.join(root, "outside-repository-vault"),
    },
  };
}

function signerFor(files, calls) {
  return async ({ purpose, input, output }) => {
    calls.push(purpose);
    const privateKey =
      purpose === "publisher-provenance"
        ? files.publisher.privateKey
        : files.host.privateKey;
    const signature = sign(null, await readFile(input), privateKey);
    await writeFile(output, signature, { flag: "wx", mode: 0o600 });
    return signature;
  };
}

const provenanceVerifier = () => ({
  sourceSha: SOURCE_SHA,
  subjectImage: API_IMAGE,
  publicationReceiptSha256: `sha256:${"d".repeat(64)}`,
  reviewedImageSetSha256: `sha256:${"e".repeat(64)}`,
  subjectRunnableManifestDigest: `sha256:${"f".repeat(64)}`,
  ociProvenanceSha256: `sha256:${"0".repeat(64)}`,
});

test("assembles, signs, transport-validates and publishes exact v3 bytes", async () => {
  const files = await fixture();
  const calls = [];
  try {
    const result = await publishProductionActivation0108Bundle(files.options, {
      now: () => NOW,
      signWithCustody: signerFor(files, calls),
      verifyApiImageProvenance: provenanceVerifier,
      verifyBundle: async (input) => {
        const parsed = await validateProductionActivationBundleTransport(
          input.bundleBytes,
          input.challenge,
          input.publisherPublicKeyFile,
          input.publisherPublicKeySha256,
          input.hostPublicKeyFile,
          input.hostPublicKeySha256,
          input.now,
          3,
        );
        assert.deepEqual(parsed.activation, input.bundle.activation);
      },
    });
    assert.equal(result.semanticContractVerified, true);
    assert.deepEqual(calls, ["publisher-provenance", "host-attestation"]);
    const bytes = await readFile(files.output);
    const bundle = JSON.parse(bytes);
    assert.equal(bundle.activation.schemaVersion, 3);
    assert.equal(
      bundle.activation.kind,
      "site-logbook-production-activation-bundle-v3",
    );
    assert.equal(
      bundle.hostAttestation.kind,
      "site-logbook-production-host-attestation-v3",
    );
    assert.equal(
      bundle.activation.evidence.migration0107To0108.plan.kind,
      "invoice-0108-plan",
    );
    assert.equal((await lstat(files.output)).nlink, 1);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("rejects a tampered 0108 artifact before custody signing", async () => {
  const files = await fixture();
  let signerCalls = 0;
  try {
    const candidate = evidence();
    candidate.migration0107To0108.plan.payload.revision = 4;
    await writeFile(
      files.options.evidence,
      canonicalProductionActivationBundleJson(candidate),
      { flag: "w" },
    );
    await assert.rejects(
      publishProductionActivation0108Bundle(files.options, {
        now: () => NOW,
        verifyApiImageProvenance: provenanceVerifier,
        signWithCustody: async () => {
          signerCalls += 1;
          return Buffer.alloc(64);
        },
      }),
      /PRODUCTION_ACTIVATION_BUNDLE_BINDING_INVALID/,
    );
    assert.equal(signerCalls, 0);
    await assert.rejects(lstat(files.output), { code: "ENOENT" });
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});
