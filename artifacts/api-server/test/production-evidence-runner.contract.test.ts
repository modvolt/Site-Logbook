import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PINNED_PRODUCTION_HOST_ATTESTATION_KEYS,
  requireObservedProductionHostRunner,
} from "../src/lib/production-evidence-runner";
import {
  COOLIFY_EXPORT_SCHEMA,
  DOCKER_EXPORT_SCHEMA,
  ACTIVATION_APPROVAL_SCHEMA,
  IMAGE_PROVENANCE_SCHEMA,
  OBSERVATION_REQUEST_SCHEMA,
  POSTGRES_EXPORT_SCHEMA,
  canonicalJson,
  createProductionHostAttestationWithTestAuthority,
  createProductionTargetEvidenceWithTestAuthority,
} from "../../../scripts/production-evidence/host-attestation-contract.mjs";

const NOW = Date.parse("2026-08-12T10:01:00.000Z");
const SOURCE_SHA = "1".repeat(40);
const KEY_ID = "ed25519:production-test";
const PROVENANCE_KEY_ID = "ed25519:image-provenance-test";
const PROVENANCE_KEYS = generateKeyPairSync("ed25519");
const TRUSTED_PROVENANCE_KEYS = {
  [PROVENANCE_KEY_ID]: PROVENANCE_KEYS.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
};
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const image = (name: string, character: string) =>
  `ghcr.io/modvolt/${name}@sha256:${character.repeat(64)}`;

function createFixture(lifetimeMs = 10 * 60_000) {
  const observedAt = "2026-08-12T10:00:00.000Z";
  const containerId = "a".repeat(64);
  const networkId = "b".repeat(64);
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
  const peer = (service: string, character: string) => ({
    containerId: character.repeat(64),
    name: `coolify-production-app-${service}-1`,
    composeProject: "coolify-production-app",
    service,
    state: "running",
    image: images[service as keyof typeof images],
    imageId: digest(service === "postgres" ? "9" : character),
  });
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
  const observation = {
    request,
    imageProvenanceCanonical,
    imageProvenanceSignature,
    coolify: {
      schemaVersion: COOLIFY_EXPORT_SCHEMA,
      observedAt,
      projectId: "bai77dzr0h7b5gu1jqwpriew",
      environmentId: "d5m70pb2i5s7c41n21vaokr7",
      environmentLabel: "production",
      applicationId: "ef09696arga7h9ox6ojgv7ru",
      pendingChanges: false,
      desiredConfig: structuredClone(config),
      deployedConfig: structuredClone(config),
    },
    docker: {
      schemaVersion: DOCKER_EXPORT_SCHEMA,
      observedAt,
      composeProject: "coolify-production-app",
      targetContainer: {
        id: containerId,
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
        networks: [{ name: "coolify-production", id: networkId }],
      },
      volume: { name: "coolify-production-postgres", driver: "local" },
      network: {
        name: "coolify-production",
        id: networkId,
        driver: "bridge",
        internal: false,
      },
      volumePeers: [peer("postgres", "a")],
      networkPeers: [peer("api", "c"), peer("postgres", "a"), peer("web", "f")],
    },
    postgres: {
      schemaVersion: POSTGRES_EXPORT_SCHEMA,
      observedAt,
      containerId,
      databaseName: "site_logbook",
      databaseUser: "site_logbook_app",
      schemaFingerprintSha256: digest("6"),
      serverVersion: "16.10",
      readOnlyObservation: true,
    },
  };
  Object.assign(observation.postgres, {
    dockerExportSha256: `sha256:${createHash("sha256")
      .update(canonicalJson(observation.docker))
      .digest("hex")}`,
    backendProofSha256: digest("a"),
  });
  const target = createProductionTargetEvidenceWithTestAuthority(observation, {
    now: NOW,
    trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
  });
  const approvedAt = "2026-08-12T10:00:30.000Z";
  const operator = "release-reviewer";
  const activationApprovalCanonical = canonicalJson({
    schemaVersion: ACTIVATION_APPROVAL_SCHEMA,
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    approvedAt,
    operator,
  });
  const activationApprovalSha256 = `sha256:${createHash("sha256")
    .update(activationApprovalCanonical)
    .digest("hex")}`;
  const linkedArtifact = (kind: string) =>
    canonicalJson({
      schemaVersion: 1,
      kind,
      sourceSha: SOURCE_SHA,
      targetEvidenceSha256: target.sha256,
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
  const artifactSha256 = (canonical: string) =>
    `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  const releaseEvidenceCanonical = canonicalJson({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-release-evidence",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
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
  const releaseEvidenceSha256 = `sha256:${createHash("sha256")
    .update(releaseEvidenceCanonical)
    .digest("hex")}`;
  const attestation = createProductionHostAttestationWithTestAuthority(
    {
      targetCanonical: target.canonical,
      intentEvidenceCanonical,
      executionEvidenceCanonical,
      steadyEvidenceCanonical,
      releaseEvidenceCanonical,
      activationApprovalCanonical,
      keyId: KEY_ID,
      currentObservation: observation,
      nonce: "e".repeat(32),
    },
    {
      now: NOW,
      lifetimeMs,
      trustedImageProvenanceKeys: TRUSTED_PROVENANCE_KEYS,
    },
  );
  const keys = generateKeyPairSync("ed25519");
  const signature = sign(
    null,
    Buffer.from(attestation.canonical),
    keys.privateKey,
  );
  const env = {
    PRODUCTION_HOST_ATTESTATION_B64: Buffer.from(
      attestation.canonical,
    ).toString("base64"),
    PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64: signature.toString("base64"),
  };
  const binding = {
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    releaseEvidenceSha256,
    activationApprovalSha256,
    apiImage: images.api,
    postgresImage: images.postgres,
    deployedConfigSha256: digest("7"),
    desiredConfigSha256: digest("7"),
    resolvedComposeSha256: digest("8"),
    livePostgresTargetSha256: target.target.livePostgresTarget.projectionSha256,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_app",
    schemaFingerprintSha256: digest("6"),
  };
  const trustedPublicKeys = {
    [KEY_ID]: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return { attestation, binding, env, keys, trustedPublicKeys };
}

describe("production host attestation runtime trust boundary", () => {
  it("uses the reviewed source pin and rejects an attestation from any other key", async () => {
    const fixture = createFixture();
    expect(Object.keys(PINNED_PRODUCTION_HOST_ATTESTATION_KEYS)).toEqual([
      "ed25519:production-host-evidence-2026-08",
    ]);
    await expect(
      requireObservedProductionHostRunner(fixture.binding, {
        env: fixture.env,
        now: NOW,
      }),
    ).rejects.toThrow(/PRODUCTION_HOST_ATTESTATION_KEY_UNTRUSTED/);
  });

  it("accepts a fresh exact binding signed by an injected test trust root", async () => {
    const fixture = createFixture();
    const result = await requireObservedProductionHostRunner(fixture.binding, {
      env: fixture.env,
      now: NOW + 60_000,
      trustedPublicKeys: fixture.trustedPublicKeys,
    });
    expect(result).toMatchObject({
      ...fixture.binding,
      keyId: KEY_ID,
      nonce: "e".repeat(32),
    });
  });

  it("rejects tampering and a wrong public key", async () => {
    const fixture = createFixture();
    const bytes = Buffer.from(
      fixture.env.PRODUCTION_HOST_ATTESTATION_B64,
      "base64",
    );
    const tampered = bytes
      .toString("utf8")
      .replace(fixture.binding.releaseEvidenceSha256, digest("f"));
    await expect(
      requireObservedProductionHostRunner(fixture.binding, {
        env: {
          ...fixture.env,
          PRODUCTION_HOST_ATTESTATION_B64:
            Buffer.from(tampered).toString("base64"),
        },
        now: NOW,
        trustedPublicKeys: fixture.trustedPublicKeys,
      }),
    ).rejects.toThrow(/SIGNATURE_INVALID/);

    const wrongKeys = generateKeyPairSync("ed25519");
    await expect(
      requireObservedProductionHostRunner(fixture.binding, {
        env: fixture.env,
        now: NOW,
        trustedPublicKeys: {
          [KEY_ID]: wrongKeys.publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
      }),
    ).rejects.toThrow(/SIGNATURE_INVALID/);
  });

  it("rejects expired evidence and source, target, release or approval mismatch", async () => {
    const replay = createFixture(60_000);
    await expect(
      requireObservedProductionHostRunner(replay.binding, {
        env: replay.env,
        now: NOW + 61_000,
        trustedPublicKeys: replay.trustedPublicKeys,
      }),
    ).rejects.toThrow(/ATTESTATION_EXPIRED/);

    const fixture = createFixture();
    for (const binding of [
      { ...fixture.binding, sourceSha: "2".repeat(40) },
      { ...fixture.binding, targetEvidenceSha256: digest("f") },
      { ...fixture.binding, releaseEvidenceSha256: digest("f") },
      { ...fixture.binding, activationApprovalSha256: digest("f") },
      { ...fixture.binding, apiImage: image("site-logbook-api", "f") },
      { ...fixture.binding, postgresImage: image("postgres", "f") },
      { ...fixture.binding, deployedConfigSha256: digest("f") },
      { ...fixture.binding, livePostgresTargetSha256: digest("f") },
      { ...fixture.binding, databaseName: "foreign_database" },
      { ...fixture.binding, schemaFingerprintSha256: digest("f") },
    ]) {
      await expect(
        requireObservedProductionHostRunner(binding, {
          env: fixture.env,
          now: NOW,
          trustedPublicKeys: fixture.trustedPublicKeys,
        }),
      ).rejects.toThrow(/BINDING_INVALID/);
    }
  });

  it("rejects secret material before trusting a signed payload", async () => {
    const fixture = createFixture();
    const value = JSON.parse(
      Buffer.from(
        fixture.env.PRODUCTION_HOST_ATTESTATION_B64,
        "base64",
      ).toString("utf8"),
    );
    value.apiToken = "github_pat_do_not_echo_this_value_123456";
    const raw = canonicalJson(value);
    const signature = sign(null, Buffer.from(raw), fixture.keys.privateKey);
    await expect(
      requireObservedProductionHostRunner(fixture.binding, {
        env: {
          PRODUCTION_HOST_ATTESTATION_B64: Buffer.from(raw).toString("base64"),
          PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64:
            signature.toString("base64"),
        },
        now: NOW,
        trustedPublicKeys: fixture.trustedPublicKeys,
      }),
    ).rejects.toThrow(/SECRET_MATERIAL/);
  });
});
