import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COOLIFY_EXPORT_SCHEMA,
  DOCKER_EXPORT_SCHEMA,
  ACTIVATION_APPROVAL_SCHEMA,
  IMAGE_PROVENANCE_SCHEMA,
  OBSERVATION_REQUEST_SCHEMA,
  POSTGRES_EXPORT_SCHEMA,
  assertSecretFree,
  canonicalJson,
  sha256,
  createProductionHostAttestation,
  createProductionHostAttestationWithTestAuthority,
  createProductionTargetEvidence,
  createProductionTargetEvidenceWithTestAuthority,
  deriveProductionReleaseBinding,
  verifyProductionObservationExports,
  verifyDetachedHostAttestation,
} from "../production-evidence/host-attestation-contract.mjs";
import { collectDockerReadOnlyExport } from "../production-evidence/docker-readonly-observer.mjs";
import { main as runProductionHostEvidence } from "../production-evidence/run-production-host-evidence.mjs";

const NOW = Date.parse("2026-08-12T10:01:00.000Z");
const SOURCE_SHA = "1".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (name, character) =>
  `ghcr.io/modvolt/${name}@sha256:${character.repeat(64)}`;
const CONTAINER_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const KEY_ID = "ed25519:production-2026-01";
const PROVENANCE_KEY_ID = "ed25519:image-provenance-test";
const PROVENANCE_KEYS = generateKeyPairSync("ed25519");
const TRUSTED_PROVENANCE_KEYS = {
  [PROVENANCE_KEY_ID]: PROVENANCE_KEYS.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
};

function targetEvidence(observation, now = NOW) {
  return createProductionTargetEvidenceWithTestAuthority(observation, {
    now,
    trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
  });
}

function fixtures() {
  const observedAt = "2026-08-12T10:00:00.000Z";
  const images = {
    api: image("site-logbook-api", "1"),
    postgres: image("postgres", "4"),
    web: image("site-logbook-web", "5"),
  };
  const request = {
    schemaVersion: OBSERVATION_REQUEST_SCHEMA,
    sourceSha: SOURCE_SHA,
    expectedApiImage: images.api,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_app",
    schemaFingerprintSha256: digest("6"),
    composeProject: "coolify-production-app",
    postgresService: "postgres",
    postgresVolumeDestination: "/var/lib/postgresql/data",
    expectedNetworkServices: ["api", "postgres", "web"],
  };
  const config = {
    configurationSha256: digest("7"),
    resolvedComposeSha256: digest("8"),
    images,
  };
  const coolify = {
    schemaVersion: COOLIFY_EXPORT_SCHEMA,
    observedAt,
    projectId: "bai77dzr0h7b5gu1jqwpriew",
    environmentId: "d5m70pb2i5s7c41n21vaokr7",
    environmentLabel: "production",
    applicationId: "ef09696arga7h9ox6ojgv7ru",
    pendingChanges: false,
    desiredConfig: structuredClone(config),
    deployedConfig: structuredClone(config),
  };
  const peer = (service, character) => ({
    containerId: character.repeat(64),
    name: `coolify-production-app-${service}-1`,
    composeProject: "coolify-production-app",
    service,
    state: "running",
    image: images[service === "postgres" ? "postgres" : service],
    imageId: digest(service === "postgres" ? "9" : character),
  });
  const docker = {
    schemaVersion: DOCKER_EXPORT_SCHEMA,
    observedAt,
    composeProject: "coolify-production-app",
    targetContainer: {
      id: CONTAINER_ID,
      name: "coolify-production-app-postgres-1",
      service: "postgres",
      image: images.postgres,
      imageId: digest("9"),
      state: "running",
      mounts: [
        {
          type: "volume",
          name: "coolify-production-postgres",
          destination: "/var/lib/postgresql/data",
          readOnly: false,
        },
      ],
      networks: [{ name: "coolify-production", id: NETWORK_ID }],
    },
    volume: { name: "coolify-production-postgres", driver: "local" },
    network: {
      name: "coolify-production",
      id: NETWORK_ID,
      driver: "bridge",
      internal: false,
    },
    volumePeers: [peer("postgres", "a")],
    networkPeers: [peer("api", "c"), peer("postgres", "a"), peer("web", "f")],
  };
  const postgres = {
    schemaVersion: POSTGRES_EXPORT_SCHEMA,
    observedAt,
    containerId: CONTAINER_ID,
    dockerExportSha256: `sha256:${createHash("sha256")
      .update(canonicalJson(docker))
      .digest("hex")}`,
    backendProofSha256: digest("a"),
    databaseName: "site_logbook",
    databaseUser: "site_logbook_app",
    schemaFingerprintSha256: digest("6"),
    serverVersion: "16.10",
    readOnlyObservation: true,
  };
  const imageProvenanceCanonical = canonicalJson({
    schemaVersion: IMAGE_PROVENANCE_SCHEMA,
    keyId: PROVENANCE_KEY_ID,
    subjectImage: images.api,
    subjectDigest: digest("1"),
    sourceSha: SOURCE_SHA,
    publicationReceiptSha256: digest("6"),
    reviewedImageSetSha256: digest("7"),
    subjectRunnableManifestDigest: digest("8"),
    ociProvenanceSha256: digest("9"),
    buildProfile: "production",
    mutatingEntrypointsPresent: false,
  });
  const imageProvenanceSignature = sign(
    null,
    Buffer.from(imageProvenanceCanonical),
    PROVENANCE_KEYS.privateKey,
  );
  return {
    request,
    imageProvenanceCanonical,
    imageProvenanceSignature,
    coolify,
    docker,
    postgres,
  };
}

function releaseArtifacts(targetSha256) {
  const approvedAt = "2026-08-12T10:00:30.000Z";
  const operator = "release-reviewer";
  const activationApprovalCanonical = canonicalJson({
    schemaVersion: ACTIVATION_APPROVAL_SCHEMA,
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: targetSha256,
    confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    approvedAt,
    operator,
  });
  const activationApprovalSha256 = `sha256:${createHash("sha256")
    .update(activationApprovalCanonical)
    .digest("hex")}`;
  const linkedArtifact = (kind, extra = {}) =>
    canonicalJson({
      schemaVersion: 1,
      kind,
      sourceSha: SOURCE_SHA,
      targetEvidenceSha256: targetSha256,
      ...extra,
    });
  const intentEvidenceCanonical = linkedArtifact(
    "site-logbook-production-audit-0107-intent",
  );
  const executionEvidenceCanonical = linkedArtifact(
    "site-logbook-production-audit-0107-execution",
  );
  const steadyEvidenceCanonical = linkedArtifact(
    "site-logbook-production-audit-0107-steady",
  );
  const artifactSha256 = (canonical) =>
    `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  const releaseEvidenceCanonical = canonicalJson({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-release-evidence",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: targetSha256,
    intentEvidenceSha256: artifactSha256(intentEvidenceCanonical),
    executionEvidenceSha256: artifactSha256(executionEvidenceCanonical),
    steadyEvidenceSha256: artifactSha256(steadyEvidenceCanonical),
    confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    activationApprovalSha256,
    approvedAt,
    operator,
    productionTargetsTouched: true,
    authorizesApplicationStart: true,
  });
  return {
    intentEvidenceCanonical,
    executionEvidenceCanonical,
    steadyEvidenceCanonical,
    activationApprovalCanonical,
    releaseEvidenceCanonical,
  };
}

function signedAttestation(options = {}) {
  const observation = fixtures();
  const target = targetEvidence(observation);
  const release = releaseArtifacts(target.sha256);
  const attestation = createProductionHostAttestationWithTestAuthority(
    {
      targetCanonical: target.canonical,
      ...release,
      keyId: KEY_ID,
      currentObservation: observation,
      nonce: "e".repeat(32),
    },
    {
      now: options.now ?? NOW,
      lifetimeMs: options.lifetimeMs ?? 10 * 60_000,
      trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
    },
  );
  const keys = generateKeyPairSync("ed25519");
  const signature = sign(
    null,
    Buffer.from(attestation.canonical),
    keys.privateKey,
  );
  return { observation, target, release, attestation, keys, signature };
}

function verifierInput(fixture, publicKey = fixture.keys.publicKey) {
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    attestationCanonical: fixture.attestation.canonical,
    signature: fixture.signature,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    expectedPublicKeySha256: `sha256:${createHash("sha256")
      .update(publicKeyDer)
      .digest("hex")}`,
    expectedKeyId: KEY_ID,
    expectedBinding: deriveProductionReleaseBinding(
      fixture.target.canonical,
      fixture.release.intentEvidenceCanonical,
      fixture.release.executionEvidenceCanonical,
      fixture.release.steadyEvidenceCanonical,
      fixture.release.releaseEvidenceCanonical,
      fixture.release.activationApprovalCanonical,
    ),
    expectedTargetCanonical: fixture.target.canonical,
  };
}

test("produces the exact canonical production target from bounded read-only observations", () => {
  const artifact = targetEvidence(fixtures());
  assert.equal(artifact.canonical, canonicalJson(artifact.target));
  assert.equal(artifact.target.coolify.pendingChanges, false);
  assert.equal(artifact.target.build.sourceSha, SOURCE_SHA);
  assert.deepEqual(
    {
      publicationReceiptSha256: artifact.target.build.publicationReceiptSha256,
      reviewedImageSetSha256: artifact.target.build.reviewedImageSetSha256,
      apiRunnableManifestDigest:
        artifact.target.build.apiRunnableManifestDigest,
      apiOciProvenanceSha256: artifact.target.build.apiOciProvenanceSha256,
    },
    {
      publicationReceiptSha256: digest("6"),
      reviewedImageSetSha256: digest("7"),
      apiRunnableManifestDigest: digest("8"),
      apiOciProvenanceSha256: digest("9"),
    },
  );
  assert.equal(artifact.target.livePostgresTarget.containerId, CONTAINER_ID);
  assert.equal(
    artifact.target.livePostgresTarget.dockerExportSha256,
    fixtures().postgres.dockerExportSha256,
  );
  assert.equal(
    artifact.target.livePostgresTarget.backendProofSha256,
    digest("a"),
  );
  assert.match(artifact.sha256, /^sha256:[0-9a-f]{64}$/);
});

test("authoritatively verifies canonical Coolify, Docker and PostgreSQL observation exports", () => {
  const observation = fixtures();
  const verdict = verifyProductionObservationExports({
    request: observation.request,
    coolifyCanonical: canonicalJson(observation.coolify),
    dockerCanonical: canonicalJson(observation.docker),
    postgresCanonical: canonicalJson(observation.postgres),
    activationIssuedAt: "2026-08-12T10:01:00.000Z",
  });
  assert.deepEqual(
    {
      sourceSha: verdict.sourceSha,
      apiImage: verdict.apiImage,
      databaseName: verdict.databaseName,
      databaseUser: verdict.databaseUser,
      capturedAt: verdict.capturedAt,
      apiContainerId: verdict.apiContainerId,
    },
    {
      sourceSha: SOURCE_SHA,
      apiImage: observation.request.expectedApiImage,
      databaseName: observation.request.databaseName,
      databaseUser: observation.request.databaseUser,
      capturedAt: observation.coolify.observedAt,
      apiContainerId: "c".repeat(64),
    },
  );
  assert.equal(
    verdict.dockerExportSha256,
    observation.postgres.dockerExportSha256,
  );
  assert.throws(
    () =>
      verifyProductionObservationExports({
        request: observation.request,
        coolifyCanonical: canonicalJson(observation.coolify),
        dockerCanonical: canonicalJson(observation.docker),
        postgresCanonical: canonicalJson({
          ...observation.postgres,
          dockerExportSha256: digest("f"),
        }),
        activationIssuedAt: "2026-08-12T10:01:00.000Z",
      }),
    /PRODUCTION_HOST_BINDING_INVALID/,
  );
});

test("rejects a v2 PostgreSQL export not bound to the exact Docker export", () => {
  const observation = fixtures();
  observation.postgres.dockerExportSha256 = digest("f");
  assert.throws(
    () => targetEvidence(observation),
    /postgresExport\.dockerExportSha256/,
  );
});

test("production runner is wired to sealed live observers and rejects caller-built host exports", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "site-logbook-host-observer-"),
  );
  try {
    const requestPath = join(directory, "request.json");
    const coolifyRequestPath = join(directory, "coolify-request.json");
    const journalPath = join(directory, "journal.json");
    const requestFixture = fixtures().request;
    await Promise.all([
      writeFile(requestPath, JSON.stringify(requestFixture)),
      writeFile(
        coolifyRequestPath,
        JSON.stringify({
          transport: {},
          expected: {
            deploymentId: "deployment-production-0107",
            revision: SOURCE_SHA,
            deployedNotBefore: "2026-08-12T09:59:00.000Z",
            configurationSha256: digest("7"),
            resolvedComposeSha256: digest("8"),
            images: {
              api: image("site-logbook-api", "1"),
              postgres: image("postgres", "4"),
              web: image("site-logbook-web", "5"),
            },
          },
        }),
      ),
      writeFile(journalPath, "[]"),
    ]);
    const output = (name) => join(directory, name);
    const runnerSource = await readFile(
      new URL(
        "../production-evidence/run-production-host-evidence.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(runnerSource, /await collectCoolifyReadOnlyExport\(\{/);
    await assert.rejects(
      runProductionHostEvidence([
        "observe",
        "--request",
        requestPath,
        "--coolify-request",
        coolifyRequestPath,
        "--journal",
        journalPath,
        "--image-provenance",
        output("not-read-before-live-preflight.json"),
        "--image-provenance-signature",
        output("not-read-before-live-preflight.sig"),
        "--coolify-export-out",
        output("coolify.json"),
        "--docker-export-out",
        output("docker.json"),
        "--postgres-export-out",
        output("postgres.json"),
        "--target-out",
        output("target.json"),
      ]),
      /PRODUCTION_HOST_INPUT_INVALID/,
    );
    await assert.rejects(
      runProductionHostEvidence([
        "observe",
        "--request",
        requestPath,
        "--coolify-export",
        output("caller-built.json"),
      ]),
      /PRODUCTION_HOST_USAGE_INVALID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production runner rejects oversized and symlinked evidence inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "site-logbook-host-input-"));
  const verifyArgs = (targetPath) => [
    "verify",
    "--attestation",
    join(directory, "unused-attestation"),
    "--signature",
    join(directory, "unused-signature"),
    "--public-key",
    join(directory, "unused-public-key"),
    "--public-key-sha256",
    digest("1"),
    "--key-id",
    KEY_ID,
    "--target",
    targetPath,
    "--intent-evidence",
    join(directory, "unused-intent"),
    "--execution-evidence",
    join(directory, "unused-execution"),
    "--steady-evidence",
    join(directory, "unused-steady"),
    "--release-evidence",
    join(directory, "unused-release"),
    "--activation-approval",
    join(directory, "unused-approval"),
  ];
  try {
    const oversized = join(directory, "oversized-target.json");
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x61));
    await assert.rejects(
      runProductionHostEvidence(verifyArgs(oversized)),
      /PRODUCTION_HOST_INPUT_INVALID: targetEvidence/,
    );

    const target = join(directory, "target.json");
    const linkedTarget = join(directory, "linked-target.json");
    await writeFile(target, targetEvidence(fixtures()).canonical);
    try {
      await symlink(target, linkedTarget, "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.diagnostic("Symlink creation is unavailable on this Windows host.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      runProductionHostEvidence(verifyArgs(linkedTarget)),
      /PRODUCTION_HOST_INPUT_INVALID: targetEvidence/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects the retired MinIO services from the production runtime set", () => {
  const observation = fixtures();
  observation.request.expectedNetworkServices = [
    "api",
    "minio",
    "postgres",
    "web",
  ];
  assert.throws(
    () => targetEvidence(observation),
    /exact binary-sorted production runtime service set/,
  );
});

test("verifies a detached Ed25519 signature from the selected public key", () => {
  const fixture = signedAttestation();
  const verified = verifyDetachedHostAttestation(verifierInput(fixture), {
    now: NOW + 60_000,
  });
  assert.equal(verified.sha256, fixture.attestation.sha256);
});

test("standalone derive and signed verifier reject a canonical v1 target", () => {
  const fixture = signedAttestation();
  const v1Target = structuredClone(fixture.target.target);
  v1Target.schemaVersion = 1;
  const v1Canonical = canonicalJson(v1Target);
  const v1Sha256 = `sha256:${createHash("sha256")
    .update(v1Canonical)
    .digest("hex")}`;
  const v1Release = releaseArtifacts(v1Sha256);
  assert.throws(
    () =>
      deriveProductionReleaseBinding(
        v1Canonical,
        v1Release.intentEvidenceCanonical,
        v1Release.executionEvidenceCanonical,
        v1Release.steadyEvidenceCanonical,
        v1Release.releaseEvidenceCanonical,
        v1Release.activationApprovalCanonical,
      ),
    /targetEvidence\.schemaVersion/,
  );

  const signedV1 = structuredClone(fixture.attestation.attestation);
  signedV1.targetEvidenceSha256 = v1Sha256;
  const signedV1Canonical = canonicalJson(signedV1);
  const input = verifierInput(fixture);
  assert.throws(
    () =>
      verifyDetachedHostAttestation(
        {
          ...input,
          attestationCanonical: signedV1Canonical,
          signature: sign(
            null,
            Buffer.from(signedV1Canonical),
            fixture.keys.privateKey,
          ),
          expectedBinding: {
            ...input.expectedBinding,
            targetEvidenceSha256: v1Sha256,
          },
          expectedTargetCanonical: v1Canonical,
        },
        { now: NOW + 60_000 },
      ),
    /expectedTargetEvidence\.schemaVersion/,
  );
});

test("rejects attestation tampering and a signature from the wrong key", () => {
  const fixture = signedAttestation();
  const wrongKeys = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      verifyDetachedHostAttestation({
        ...verifierInput(fixture),
        attestationCanonical: fixture.attestation.canonical.replace(
          fixture.attestation.attestation.releaseEvidenceSha256,
          digest("f"),
        ),
      }),
    /SIGNATURE_INVALID/,
  );
  assert.throws(
    () =>
      verifyDetachedHostAttestation(
        verifierInput(fixture, wrongKeys.publicKey),
      ),
    /SIGNATURE_INVALID/,
  );
});

test("standalone verifier rejects a signed minimal payload and an unpinned key fingerprint", () => {
  const fixture = signedAttestation();
  const minimal = canonicalJson({
    schemaVersion: "site-logbook.production-host-attestation/v1",
    kind: "site-logbook-production-audit-0107-host-attestation",
    keyId: KEY_ID,
    observedAt: "2026-08-12T10:00:00.000Z",
    issuedAt: "2026-08-12T10:01:00.000Z",
    expiresAt: "2026-08-12T10:02:00.000Z",
  });
  assert.throws(
    () =>
      verifyDetachedHostAttestation({
        ...verifierInput(fixture),
        attestationCanonical: minimal,
        signature: sign(null, Buffer.from(minimal), fixture.keys.privateKey),
      }),
    /SCHEMA_INVALID/,
  );
  assert.throws(
    () =>
      verifyDetachedHostAttestation({
        ...verifierInput(fixture),
        expectedPublicKeySha256: digest("f"),
      }),
    /BINDING_INVALID/,
  );
});

test("rejects expired bounded evidence and release/source/target mismatches", () => {
  const fixture = signedAttestation({ lifetimeMs: 60_000 });
  assert.throws(
    () =>
      verifyDetachedHostAttestation(verifierInput(fixture), {
        now: NOW + 61_000,
      }),
    /ATTESTATION_EXPIRED/,
  );

  const observation = fixtures();
  const target = targetEvidence(observation);
  const release = releaseArtifacts(target.sha256);
  for (const releaseEvidenceCanonical of [
    release.releaseEvidenceCanonical.replace(SOURCE_SHA, "2".repeat(40)),
    release.releaseEvidenceCanonical.replace(target.sha256, digest("f")),
  ]) {
    assert.throws(
      () =>
        createProductionHostAttestationWithTestAuthority(
          {
            targetCanonical: target.canonical,
            intentEvidenceCanonical: release.intentEvidenceCanonical,
            executionEvidenceCanonical: release.executionEvidenceCanonical,
            steadyEvidenceCanonical: release.steadyEvidenceCanonical,
            releaseEvidenceCanonical,
            activationApprovalCanonical: release.activationApprovalCanonical,
            keyId: KEY_ID,
            currentObservation: observation,
            nonce: "e".repeat(32),
          },
          {
            now: NOW,
            lifetimeMs: 10 * 60_000,
            trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
          },
        ),
      /BINDING_INVALID/,
    );
  }
});

test("rejects mutable image refs and pending Coolify configuration", () => {
  const mutable = fixtures();
  mutable.coolify.desiredConfig.images.api =
    "ghcr.io/modvolt/site-logbook-api:latest";
  mutable.coolify.deployedConfig.images.api =
    "ghcr.io/modvolt/site-logbook-api:latest";
  mutable.request.expectedApiImage = "ghcr.io/modvolt/site-logbook-api:latest";
  assert.throws(() => targetEvidence(mutable), /IMAGE_MUTABLE/);

  const pending = fixtures();
  pending.coolify.pendingChanges = true;
  assert.throws(() => targetEvidence(pending), /BINDING_INVALID/);
});

test("rejects self-authored or tampered image provenance", () => {
  const untrusted = fixtures();
  assert.throws(
    () =>
      createProductionTargetEvidenceWithTestAuthority(untrusted, {
        now: NOW,
        trustedImageProvenanceKeys: {},
      }),
    /PROVENANCE_KEY_UNTRUSTED/,
  );
  const tampered = fixtures();
  tampered.imageProvenanceCanonical = tampered.imageProvenanceCanonical.replace(
    SOURCE_SHA,
    "2".repeat(40),
  );
  assert.throws(() => targetEvidence(tampered), /PROVENANCE_SIGNATURE_INVALID/);

  const legacy = fixtures();
  const legacyValue = JSON.parse(legacy.imageProvenanceCanonical);
  legacyValue.schemaVersion = "site-logbook.production-api-image-provenance/v1";
  delete legacyValue.publicationReceiptSha256;
  delete legacyValue.reviewedImageSetSha256;
  delete legacyValue.subjectRunnableManifestDigest;
  delete legacyValue.ociProvenanceSha256;
  legacy.imageProvenanceCanonical = canonicalJson(legacyValue);
  legacy.imageProvenanceSignature = sign(
    null,
    Buffer.from(legacy.imageProvenanceCanonical),
    PROVENANCE_KEYS.privateKey,
  );
  assert.throws(() => targetEvidence(legacy), /SCHEMA_INVALID/);

  for (const field of [
    "publicationReceiptSha256",
    "reviewedImageSetSha256",
    "subjectRunnableManifestDigest",
    "ociProvenanceSha256",
  ]) {
    const invalid = fixtures();
    const value = JSON.parse(invalid.imageProvenanceCanonical);
    value[field] = "sha256:not-a-digest";
    invalid.imageProvenanceCanonical = canonicalJson(value);
    invalid.imageProvenanceSignature = sign(
      null,
      Buffer.from(invalid.imageProvenanceCanonical),
      PROVENANCE_KEYS.privateKey,
    );
    assert.throws(() => targetEvidence(invalid), /DIGEST_INVALID/);
  }
});

test("production target and host producers seal the pinned provenance authority", () => {
  assert.equal(createProductionTargetEvidence.length, 1);
  assert.equal(createProductionHostAttestation.length, 1);

  const observation = fixtures();
  assert.throws(
    () =>
      createProductionTargetEvidence(observation, {
        now: NOW,
        trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
      }),
    /PRODUCTION_HOST_PROVENANCE_AUTHORITY_INVALID/,
  );
  assert.throws(
    () => createProductionTargetEvidence(observation),
    /PRODUCTION_HOST_PROVENANCE_KEY_UNTRUSTED/,
  );

  const fixture = signedAttestation();
  const input = {
    targetCanonical: fixture.target.canonical,
    ...fixture.release,
    keyId: KEY_ID,
    currentObservation: fixture.observation,
    nonce: "e".repeat(32),
  };
  assert.throws(
    () =>
      createProductionHostAttestation(input, {
        now: NOW,
        lifetimeMs: 10 * 60_000,
        trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
      }),
    /PRODUCTION_HOST_PROVENANCE_AUTHORITY_INVALID/,
  );
  assert.throws(
    () => createProductionHostAttestation(input),
    /PRODUCTION_HOST_PROVENANCE_KEY_UNTRUSTED/,
  );
});

test("rejects foreign volume and network peers", () => {
  const foreignVolume = fixtures();
  foreignVolume.docker.volumePeers.push({
    containerId: "f".repeat(64),
    name: "foreign",
    composeProject: "foreign",
    service: "postgres",
    state: "running",
    image: image("postgres", "f"),
    imageId: digest("f"),
  });
  assert.throws(() => targetEvidence(foreignVolume), /FOREIGN_PEER/);

  const foreignNetwork = fixtures();
  foreignNetwork.docker.networkPeers.push({
    containerId: "0".repeat(63) + "1",
    name: "foreign",
    composeProject: "foreign",
    service: "sidecar",
    state: "running",
    image: image("sidecar", "f"),
    imageId: digest("f"),
  });
  assert.throws(() => targetEvidence(foreignNetwork), /FOREIGN_PEER/);
});

test("accepts one exact running Coolify proxy infrastructure peer", () => {
  const observation = fixtures();
  observation.docker.networkPeers.push({
    containerId: "0".repeat(63) + "1",
    name: "coolify-proxy",
    composeProject: "coolify-proxy",
    service: "traefik",
    state: "running",
    image: "traefik:v3.6",
    imageId: digest("8"),
  });
  observation.postgres.dockerExportSha256 = sha256(
    canonicalJson(observation.docker),
  );
  assert.doesNotThrow(() => targetEvidence(observation));

  observation.docker.networkPeers.push({
    ...observation.docker.networkPeers.at(-1),
    containerId: "0".repeat(62) + "12",
    name: "coolify-proxy-2",
  });
  observation.postgres.dockerExportSha256 = sha256(
    canonicalJson(observation.docker),
  );
  assert.throws(() => targetEvidence(observation), /FOREIGN_PEER/);
});

test("rejects secret-shaped fields and values without echoing them", () => {
  const secret = "github_pat_this_must_never_be_echoed_123456";
  const scramVerifier =
    "SCRAM-SHA-256$4096:c2FsdHNhbHQ=$c3RvcmVka2V5:c2VydmVya2V5";
  assert.throws(
    () => assertSecretFree({ apiToken: secret }),
    (error) => {
      assert.match(error.message, /SECRET_MATERIAL/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => assertSecretFree({ harmless: secret }),
    /SECRET_MATERIAL/,
  );
  assert.throws(
    () => assertSecretFree({ harmless: scramVerifier }),
    (error) => {
      assert.match(error.message, /SECRET_MATERIAL/);
      assert.doesNotMatch(error.message, new RegExp(scramVerifier));
      return true;
    },
  );
});

test("Docker observer uses only read-only inventory verbs and includes stopped peers", async () => {
  const base = fixtures();
  const makeContainer = (service, character, state = "running") => ({
    Id: character.repeat(64),
    Name: `/coolify-production-app-${service}-1`,
    Config: {
      Image:
        service === "postgres"
          ? base.coolify.deployedConfig.images.postgres
          : base.coolify.deployedConfig.images.api,
      Labels: {
        "com.docker.compose.project":
          service === "foreign" ? "foreign" : "coolify-production-app",
        "com.docker.compose.service": service,
      },
    },
    Image: digest(character),
    State: { Status: state },
    Mounts:
      service === "postgres" || service === "foreign"
        ? [
            {
              Type: "volume",
              Name: "coolify-production-postgres",
              Destination: "/var/lib/postgresql/data",
              RW: true,
            },
          ]
        : [],
    NetworkSettings: {
      Networks: {
        "coolify-production": { NetworkID: NETWORK_ID },
      },
    },
  });
  const containers = [
    makeContainer("postgres", "a"),
    makeContainer("api", "c"),
    makeContainer("web", "f"),
    makeContainer("foreign", "7", "exited"),
  ];
  const commands = [];
  let clock = NOW;
  const runDocker = async (args) => {
    commands.push(args);
    if (args.join(" ") === "container ls --all --quiet --no-trunc") {
      return `${containers.map((container) => container.Id).join("\n")}\n`;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return JSON.stringify(
        containers.find((container) => container.Id === args.at(-1)),
      );
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return JSON.stringify({
        Name: "coolify-production-postgres",
        Driver: "local",
      });
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return JSON.stringify({
        Name: "coolify-production",
        Id: NETWORK_ID,
        Driver: "bridge",
        Internal: false,
        Containers: Object.fromEntries(
          containers.map((container) => [
            container.Id,
            { Name: container.Name },
          ]),
        ),
      });
    }
    throw new Error("unexpected docker command");
  };
  const result = await collectDockerReadOnlyExport(base.request, {
    runDocker,
    now: () => clock++,
  });
  assert.equal(result.value.volumePeers.length, 2);
  assert.equal(result.value.networkPeers.length, 4);
  assert.deepEqual(
    commands.filter((args) => args[0] === "container" && args[1] === "ls"),
    [
      ["container", "ls", "--all", "--quiet", "--no-trunc"],
      ["container", "ls", "--all", "--quiet", "--no-trunc"],
    ],
  );
  assert.ok(
    commands.every(
      (args) =>
        (args[0] === "container" && ["ls", "inspect"].includes(args[1])) ||
        (args[0] === "volume" && args[1] === "inspect") ||
        (args[0] === "network" && args[1] === "inspect"),
    ),
  );
  const containerTemplates = commands
    .filter((args) => args[0] === "container" && args[1] === "inspect")
    .map((args) => args[3]);
  assert.ok(containerTemplates.every((template) => template.includes(".Id")));
  assert.ok(
    containerTemplates.every(
      (template) =>
        !template.includes(".Config.Env") &&
        !template.includes("{{json .Config}}"),
    ),
  );
});

test("rejects a peer image mismatch and Docker inventory race", async () => {
  const wrongPeer = fixtures();
  wrongPeer.docker.networkPeers.find((peer) => peer.service === "api").image =
    image("attacker", "f");
  assert.throws(() => targetEvidence(wrongPeer), /TARGET_INVALID/);

  const base = fixtures();
  let listCount = 0;
  const container = {
    Id: CONTAINER_ID,
    Name: "/coolify-production-app-postgres-1",
    Config: {
      Image: base.coolify.deployedConfig.images.postgres,
      Labels: {
        "com.docker.compose.project": "coolify-production-app",
        "com.docker.compose.service": "postgres",
      },
    },
    Image: digest("9"),
    State: { Status: "running" },
    Mounts: [
      {
        Type: "volume",
        Name: "coolify-production-postgres",
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
    NetworkSettings: {
      Networks: { "coolify-production": { NetworkID: NETWORK_ID } },
    },
  };
  const runDocker = async (args) => {
    if (args.join(" ") === "container ls --all --quiet --no-trunc") {
      listCount += 1;
      return listCount === 1
        ? `${CONTAINER_ID}\n`
        : `${CONTAINER_ID}\n${"f".repeat(64)}\n`;
    }
    if (args[0] === "container") return JSON.stringify(container);
    if (args[0] === "volume") {
      return JSON.stringify({
        Name: "coolify-production-postgres",
        Driver: "local",
      });
    }
    return JSON.stringify({
      Name: "coolify-production",
      Id: NETWORK_ID,
      Driver: "bridge",
      Internal: false,
      Containers: { [CONTAINER_ID]: { Name: container.Name } },
    });
  };
  await assert.rejects(
    collectDockerReadOnlyExport(base.request, {
      runDocker,
      now: () => NOW,
    }),
    /inventory changed/,
  );
});

