import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION,
  canonicalProductionActivationBundleJson,
  publishProductionActivationBundle,
} from "../production-evidence/run-production-activation-bundle.mjs";
import { verifyProductionApiImageProvenanceArtifactWithTestAuthority } from "../production-evidence/host-attestation-contract.mjs";
import { validateProductionActivationBundleTransport } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";

const NOW = Date.parse("2026-08-18T17:00:00.000Z");
const SOURCE_SHA = "1".repeat(40);
const API_IMAGE = `ghcr.io/modvolt/site-logbook-api@sha256:${"2".repeat(64)}`;
const DESIRED = "3".repeat(64);
const DEPLOYED = DESIRED;
const RESOLVED = "5".repeat(64);
const CONTAINER = "a".repeat(64);
const NONCE = "b".repeat(64);
const PUBLICATION_RECEIPT_SHA256 = `sha256:${"6".repeat(64)}`;
const REVIEWED_IMAGE_SET_SHA256 = `sha256:${"7".repeat(64)}`;
const API_RUNNABLE_MANIFEST_DIGEST = `sha256:${"8".repeat(64)}`;
const API_OCI_PROVENANCE_SHA256 = `sha256:${"9".repeat(64)}`;
const PROVENANCE_KEY = generateKeyPairSync("ed25519");

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

const PROVENANCE_KEY_ID = `sha256:${sha256(
  PROVENANCE_KEY.publicKey.export({ type: "spki", format: "der" }),
)}`;
const TRUSTED_PROVENANCE_KEYS = Object.freeze({
  [PROVENANCE_KEY_ID]: PROVENANCE_KEY.publicKey.export({
    type: "spki",
    format: "pem",
  }),
});

function apiImageProvenance(overrides = {}) {
  const value = {
    schemaVersion: "site-logbook.production-api-image-provenance/v2",
    keyId: PROVENANCE_KEY_ID,
    subjectImage: API_IMAGE,
    subjectDigest: `sha256:${"2".repeat(64)}`,
    sourceSha: SOURCE_SHA,
    publicationReceiptSha256: PUBLICATION_RECEIPT_SHA256,
    reviewedImageSetSha256: REVIEWED_IMAGE_SET_SHA256,
    subjectRunnableManifestDigest: API_RUNNABLE_MANIFEST_DIGEST,
    ociProvenanceSha256: API_OCI_PROVENANCE_SHA256,
    buildProfile: "production",
    mutatingEntrypointsPresent: false,
    ...overrides,
  };
  const canonical = canonicalProductionActivationBundleJson(value);
  return {
    canonical,
    signatureB64: sign(
      null,
      Buffer.from(canonical),
      PROVENANCE_KEY.privateKey,
    ).toString("base64"),
  };
}

const PROVENANCE_TEST_DEPENDENCY = Object.freeze({
  verifyApiImageProvenance: (input) =>
    verifyProductionApiImageProvenanceArtifactWithTestAuthority(input, {
      trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
    }),
});

function approval() {
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
    deployedConfigSha256: DEPLOYED,
    resolvedComposeSha256: RESOLVED,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: `sha256:${"6".repeat(64)}`,
    composeProject: "site_logbook",
    postgresService: "postgres",
    postgresVolumeDestination: "/var/lib/postgresql/data",
    expectedNetworkServices: ["api", "postgres", "web"],
    migrationTransitionSha256: `sha256:${"7".repeat(64)}`,
    finalLiveIdentitySha256: `sha256:${"8".repeat(64)}`,
    credentialRequestSha256: `sha256:${"9".repeat(64)}`,
    credentialReceiptSha256: `sha256:${"a".repeat(64)}`,
    coolifyObservationSha256: `sha256:${"b".repeat(64)}`,
    dockerObservationSha256: `sha256:${"c".repeat(64)}`,
    postgresObservationSha256: `sha256:${"d".repeat(64)}`,
    approvedAt: new Date(NOW - 1_000).toISOString(),
    operator: "modvolt-release-owner",
    authorizesApplicationStart: true,
    authorizesDeployment: false,
  };
}

function evidence(overrides = {}) {
  const simple = (kind, extra = {}) =>
    artifact(kind, { revision: 2, ...extra });
  const value = {
    activationApproval: artifact("activation-approval", approval()),
    apiImageProvenance: apiImageProvenance(),
    exact0096Backup: {
      plan: simple("backup-plan", {
        publicIdentityPolicy: {
          activeApplicationSessions: 0,
          snapshotTokenSha256: `sha256:${"e".repeat(64)}`,
          "public.user_sessions": 0,
          "public.work_session_billing_links": 0,
          "public.work_session_breaks": 0,
          "public.work_session_events": 0,
          "public.work_sessions": 0,
          user_sessions: 0,
          work_session_billing_links: 0,
          work_session_breaks: 0,
          work_session_events: 0,
          work_sessions: 0,
        },
      }),
      trace: simple("backup-trace"),
      passReceipt: simple("backup-pass-receipt"),
      signature: simple("backup-signature-envelope"),
      detachedSignature: artifact("backup-detached-signature", {
        signatureBase64: Buffer.alloc(64, 7).toString("base64"),
      }),
    },
    migration0096To0107: {
      plan: simple("migration-plan"),
      intent: simple("migration-intent"),
      persistence: simple("migration-persistence"),
      receipts: Array.from({ length: 10 }, (_, index) =>
        simple(`migration-receipt-${String(index + 1).padStart(2, "0")}`, {
          index,
        }),
      ),
      finalLive: simple("migration-final-live"),
      role: simple("migration-role"),
      postcommit: simple("migration-postcommit"),
      transitionPass: simple("migration-transition-pass"),
    },
    runtimeDatabaseCredentialCutover: {
      request: simple("runtime-credential-request"),
      passReceipt: simple("runtime-credential-pass-receipt"),
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
  };
  return Object.assign(value, overrides);
}

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "activation-producer-test-"),
  );
  const inputs = path.join(root, "inputs");
  const outputDirectory = path.join(root, "host-evidence");
  await Promise.all([mkdir(inputs), mkdir(outputDirectory)]);
  const challengeFile = path.join(inputs, "challenge.json");
  const evidenceFile = path.join(inputs, "evidence.json");
  const publisherPublicKeyFile = path.join(inputs, "publisher-public.pem");
  const hostPublicKeyFile = path.join(inputs, "host-public.pem");
  const output = path.join(outputDirectory, "activation-bundle-v2.json");
  const challenge = {
    kind: "site-logbook-production-activation-challenge-v2",
    sourceSha: SOURCE_SHA,
    apiImage: API_IMAGE,
    containerId: CONTAINER,
    nonce: NONCE,
  };
  const publisher = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  await Promise.all([
    writeFile(
      challengeFile,
      canonicalProductionActivationBundleJson(challenge),
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(
      evidenceFile,
      canonicalProductionActivationBundleJson(evidence()),
      {
        flag: "wx",
        mode: 0o600,
      },
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
    challengeFile,
    evidenceFile,
    publisherPublicKeyFile,
    hostPublicKeyFile,
    publisher,
    host,
    output,
    options: {
      challenge: challengeFile,
      confirm: PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION,
      evidence: evidenceFile,
      "host-public-key": hostPublicKeyFile,
      output,
      "publisher-public-key": publisherPublicKeyFile,
      vault: path.join(root, "outside-repository-dpapi-vault"),
    },
  };
}

function signerFor(files, calls) {
  return async ({ purpose, input, output, vault }) => {
    calls.push({ purpose, input, output, vault });
    const bytes = await readFile(input);
    const privateKey =
      purpose === "publisher-provenance"
        ? files.publisher.privateKey
        : files.host.privateKey;
    const signature = sign(null, bytes, privateKey);
    await writeFile(output, signature, { flag: "wx", mode: 0o600 });
    return signature;
  };
}

async function transportVerifier(input) {
  const parsed = await validateProductionActivationBundleTransport(
    input.bundleBytes,
    {
      sourceSha: input.challenge.sourceSha,
      apiImage: input.challenge.apiImage,
      containerId: input.challenge.containerId,
      nonce: input.challenge.nonce,
    },
    input.publisherPublicKeyFile,
    input.publisherPublicKeySha256,
    input.hostPublicKeyFile,
    input.hostPublicKeySha256,
    input.now,
  );
  assert.deepEqual(parsed.activation, input.bundle.activation);
}

test("assembles, custody-signs, runtime-validates and atomically publishes exact v2 bytes", async () => {
  const files = await fixture();
  const calls = [];
  try {
    const result = await publishProductionActivationBundle(files.options, {
      ...PROVENANCE_TEST_DEPENDENCY,
      now: () => NOW,
      signWithCustody: signerFor(files, calls),
      verifyBundle: transportVerifier,
    });
    assert.equal(result.output, files.output);
    assert.equal(result.signaturesVerified, true);
    assert.equal(result.semanticContractVerified, true);
    assert.deepEqual(
      calls.map(({ purpose }) => purpose),
      ["publisher-provenance", "host-attestation"],
    );
    assert.ok(calls.every(({ vault }) => vault === files.options.vault));
    const bytes = await readFile(files.output);
    const bundle = JSON.parse(bytes);
    assert.equal(
      canonicalProductionActivationBundleJson(bundle),
      bytes.toString("utf8"),
    );
    assert.equal(bundle.activation.sourceSha, SOURCE_SHA);
    assert.equal(bundle.activation.containerId, CONTAINER);
    assert.equal(bundle.activation.nonce, NONCE);
    assert.equal(bundle.activation.desiredConfigSha256, DESIRED);
    assert.equal(bundle.activation.deployedConfigSha256, DEPLOYED);
    assert.equal(bundle.activation.resolvedComposeSha256, RESOLVED);
    assert.equal(
      bundle.activation.evidence.apiImageProvenance.canonical,
      apiImageProvenance().canonical,
    );
    assert.equal(
      Buffer.from(
        bundle.activation.evidence.apiImageProvenance.signatureB64,
        "base64",
      ).length,
      64,
    );
    assert.equal("desiredConfigSha256" in files.challenge, false);
    assert.equal(
      bundle.hostAttestation.observedAt,
      new Date(NOW - 2_000).toISOString(),
    );
    assert.equal(bundle.activationSignature.signatureBase64.length, 88);
    assert.equal(bundle.hostAttestationSignature.signatureBase64.length, 88);
    assert.equal((await lstat(files.output)).nlink, 1);
    assert.equal(
      result.sha256,
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("refuses clobber before either custody key is used", async () => {
  const files = await fixture();
  let signerCalls = 0;
  let verifierCalls = 0;
  try {
    await writeFile(files.output, "operator-owned-sentinel\n", { flag: "wx" });
    await assert.rejects(
      publishProductionActivationBundle(files.options, {
        ...PROVENANCE_TEST_DEPENDENCY,
        now: () => NOW,
        signWithCustody: async () => {
          signerCalls += 1;
          return Buffer.alloc(64);
        },
        verifyBundle: async () => {
          verifierCalls += 1;
        },
      }),
      /PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_EXISTS/,
    );
    assert.equal(signerCalls, 0);
    assert.equal(verifierCalls, 0);
    assert.equal(
      await readFile(files.output, "utf8"),
      "operator-owned-sentinel\n",
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("rejects desired/deployed observer drift before custody signing", async () => {
  const files = await fixture();
  let signerCalls = 0;
  try {
    const drifted = evidence({
      activationApproval: artifact("activation-approval", {
        ...approval(),
        deployedConfigSha256: "4".repeat(64),
      }),
    });
    await writeFile(
      files.evidenceFile,
      canonicalProductionActivationBundleJson(drifted),
      { flag: "w" },
    );
    await assert.rejects(
      publishProductionActivationBundle(files.options, {
        ...PROVENANCE_TEST_DEPENDENCY,
        now: () => NOW,
        signWithCustody: async () => {
          signerCalls += 1;
          return Buffer.alloc(64);
        },
        verifyBundle: transportVerifier,
      }),
      /PRODUCTION_ACTIVATION_BUNDLE_BINDING_INVALID/,
    );
    assert.equal(signerCalls, 0);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

for (const [label, mutate, expectedError] of [
  [
    "missing signed API image provenance",
    (candidate) => {
      delete candidate.apiImageProvenance;
    },
    /PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID/,
  ],
  [
    "tampered API image provenance canonical bytes",
    (candidate) => {
      const provenance = JSON.parse(candidate.apiImageProvenance.canonical);
      provenance.reviewedImageSetSha256 = `sha256:${"e".repeat(64)}`;
      candidate.apiImageProvenance.canonical =
        canonicalProductionActivationBundleJson(provenance);
    },
    /PRODUCTION_ACTIVATION_BUNDLE_PROVENANCE_INVALID/,
  ],
  [
    "API image provenance signed by the wrong key",
    (candidate) => {
      candidate.apiImageProvenance.signatureB64 = Buffer.alloc(64, 11).toString(
        "base64",
      );
    },
    /PRODUCTION_ACTIVATION_BUNDLE_PROVENANCE_INVALID/,
  ],
  [
    "valid API image provenance replayed from another source",
    (candidate) => {
      candidate.apiImageProvenance = apiImageProvenance({
        sourceSha: "e".repeat(40),
      });
    },
    /PRODUCTION_ACTIVATION_BUNDLE_PROVENANCE_INVALID/,
  ],
]) {
  test(`rejects ${label} before custody signing`, async () => {
    const files = await fixture();
    let signerCalls = 0;
    try {
      const candidate = evidence();
      mutate(candidate);
      await writeFile(
        files.evidenceFile,
        canonicalProductionActivationBundleJson(candidate),
        { flag: "w" },
      );
      await assert.rejects(
        publishProductionActivationBundle(files.options, {
          ...PROVENANCE_TEST_DEPENDENCY,
          now: () => NOW,
          signWithCustody: async () => {
            signerCalls += 1;
            return Buffer.alloc(64);
          },
          verifyBundle: transportVerifier,
        }),
        expectedError,
      );
      assert.equal(signerCalls, 0);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
}

for (const secret of [
  "github_pat_neutral_value_must_not_escape_123456",
  "ghp_neutralValueMustNotEscape1234567890",
]) {
  test(`rejects ${secret.slice(0, secret.indexOf("_"))} private material under a neutral field before signing`, async () => {
    const files = await fixture();
    let signerCalls = 0;
    try {
      const poisoned = evidence();
      poisoned.exact0096Backup.plan = artifact("backup-plan", {
        harmless: secret,
      });
      await writeFile(
        files.evidenceFile,
        canonicalProductionActivationBundleJson(poisoned),
        { flag: "w" },
      );
      await assert.rejects(
        publishProductionActivationBundle(files.options, {
          ...PROVENANCE_TEST_DEPENDENCY,
          now: () => NOW,
          signWithCustody: async () => {
            signerCalls += 1;
            return Buffer.alloc(64);
          },
          verifyBundle: transportVerifier,
        }),
        (error) => {
          assert.match(error.message, /PRIVATE_MATERIAL/);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        },
      );
      assert.equal(signerCalls, 0);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
}

test("rejects a hard-linked or noncanonical challenge before signing", async () => {
  const hardlinked = await fixture();
  let signerCalls = 0;
  try {
    const alias = path.join(
      path.dirname(hardlinked.challengeFile),
      "alias.json",
    );
    await link(hardlinked.challengeFile, alias);
    await assert.rejects(
      publishProductionActivationBundle(
        { ...hardlinked.options, challenge: alias },
        {
          ...PROVENANCE_TEST_DEPENDENCY,
          now: () => NOW,
          signWithCustody: async () => {
            signerCalls += 1;
            return Buffer.alloc(64);
          },
          verifyBundle: transportVerifier,
        },
      ),
      /PRODUCTION_ACTIVATION_BUNDLE_INPUT_UNSAFE/,
    );
    assert.equal(signerCalls, 0);
  } finally {
    await rm(hardlinked.root, { recursive: true, force: true });
  }

  const noncanonical = await fixture();
  try {
    await writeFile(
      noncanonical.challengeFile,
      `${JSON.stringify(noncanonical.challenge, null, 2)}\n`,
      { flag: "w" },
    );
    await assert.rejects(
      publishProductionActivationBundle(noncanonical.options, {
        ...PROVENANCE_TEST_DEPENDENCY,
        now: () => NOW,
        signWithCustody: async () => {
          signerCalls += 1;
          return Buffer.alloc(64);
        },
        verifyBundle: transportVerifier,
      }),
      /PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID/,
    );
    assert.equal(signerCalls, 0);
  } finally {
    await rm(noncanonical.root, { recursive: true, force: true });
  }
});

test("rejects a custody signature from the wrong key and leaves no bundle", async () => {
  const files = await fixture();
  try {
    const wrong = generateKeyPairSync("ed25519");
    await assert.rejects(
      publishProductionActivationBundle(files.options, {
        ...PROVENANCE_TEST_DEPENDENCY,
        now: () => NOW,
        signWithCustody: async ({ input, output }) => {
          const signature = sign(null, await readFile(input), wrong.privateKey);
          await writeFile(output, signature, { flag: "wx" });
          return signature;
        },
        verifyBundle: transportVerifier,
      }),
      /PRODUCTION_ACTIVATION_BUNDLE_SIGNATURE_INVALID/,
    );
    await assert.rejects(lstat(files.output), { code: "ENOENT" });
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("production semantic verifier blocks a transport-valid synthetic chain", async () => {
  const files = await fixture();
  const calls = [];
  try {
    await assert.rejects(
      publishProductionActivationBundle(files.options, {
        ...PROVENANCE_TEST_DEPENDENCY,
        now: () => NOW,
        signWithCustody: signerFor(files, calls),
      }),
      /PRODUCTION_/,
    );
    assert.deepEqual(
      calls.map(({ purpose }) => purpose),
      ["publisher-provenance", "host-attestation"],
    );
    await assert.rejects(lstat(files.output), { code: "ENOENT" });
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("production CLI is hard-wired to custody and the runtime semantic verifier", async () => {
  const source = await readFile(
    path.resolve(
      "scripts/production-evidence/run-production-activation-bundle.mjs",
    ),
    "utf8",
  );
  assert.match(source, /production-signing-custody\.mjs/);
  assert.match(source, /purpose: "publisher-provenance"/);
  assert.match(source, /purpose: "host-attestation"/);
  assert.match(source, /verifyProductionActivationContractV2/);
  assert.doesNotMatch(source, /--private-key|--password|--passphrase|--secret/);
  assert.match(source, /privateMaterialPrinted=false/);
});
