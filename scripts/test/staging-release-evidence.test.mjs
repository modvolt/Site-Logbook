import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { validateStagingReleaseEvidence } from "../check-staging-release-evidence.mjs";
import {
  canonicalJson,
  validateStagingProvisioning,
} from "../check-staging-provisioning.mjs";
import { buildStagingDeploymentInputs } from "../check-staging-deployment-binding.mjs";

const NOW = new Date("2026-08-02T12:30:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CALLER_REF =
  "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main";
const CALLER_WORKFLOW_SHA = "1".repeat(40);
const IMAGE_SPECS = {
  preflight: [
    "site-logbook-staging-preflight",
    "a",
    "BUILD_SHA",
    "deploy/staging/preflight/Dockerfile",
    "BUILD_SHA",
    ["sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"],
  ],
  mailpit: [
    "site-logbook-staging-mailpit",
    "b",
    "BUILD_SHA",
    "deploy/staging/mailpit/Dockerfile",
    "BUILD_SHA",
    [
      "sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d",
      "sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
    ],
  ],
  api: [
    "site-logbook-staging-api",
    "c",
    "BUILD_SHA",
    "artifacts/api-server/Dockerfile",
    "BUILD_SHA",
    ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7"],
  ],
  web: [
    "site-logbook-staging-web",
    "d",
    "VITE_BUILD_SHA",
    "artifacts/stavba/Dockerfile",
    "VITE_BUILD_SHA",
    [
      "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
      "sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10",
    ],
  ],
  alertReceiver: [
    "site-logbook-staging-alert-receiver",
    "e",
    "RECEIVER_BUILD_SHA",
    "deploy/operational-alert-receiver/Dockerfile",
    "BUILD_SHA",
    ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7"],
  ],
};

function canonicalCompactJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCompactJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalCompactJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateImageManifest() {
  const images = {};
  const packages = {};
  let id = 10;
  for (const [
    key,
    [
      packageName,
      seed,
      buildShaEnv,
      dockerfile,
      buildArg,
      verifiedBaseImageDigests,
    ],
  ] of Object.entries(IMAGE_SPECS)) {
    const registryRepository = `ghcr.io/modvolt/${packageName}`;
    const imageDigest = `sha256:${seed.repeat(64)}`;
    images[key] = `${registryRepository}@${imageDigest}`;
    packages[key] = {
      packageName,
      packageId: String(id++),
      visibility: "private",
      repository: "modvolt/site-logbook-registry",
      registryRepository,
      sourceSha: SHA,
      versionId: String(id++),
      digest: imageDigest,
      runnableManifestDigest: `sha256:${"f".repeat(64)}`,
      platform: "linux/amd64",
      activeInventoryPaginated: true,
      activeVersionCount: 1,
      packageVersionCount: 1,
      deletedInventoryMode: "not-queryable-exact-read-scope",
      visibleDeletedTagConflictChecked: false,
      deletedVersionCount: null,
      deletedHistoryScope: "external-audit-ledger-only",
      selectedVersionRefetched: true,
      remoteManifestVerified: true,
      runtimeMetadata: {
        source: "https://github.com/modvolt/Site-Logbook",
        revision: SHA,
        url: `https://github.com/modvolt/Site-Logbook/commit/${SHA}`,
        buildSha: SHA,
        buildShaEnv,
      },
      provenance: {
        buildType: "https://mobyproject.org/buildkit@v1",
        vcsSource: "https://github.com/modvolt/Site-Logbook",
        vcsRevision: SHA,
        dockerfile,
        buildArg,
        buildSha: SHA,
        verifiedBaseImageDigests,
      },
      sbom: { spdxVersion: "SPDX-2.3", packageCount: 1, relationshipCount: 1 },
    };
  }
  const registryLedger = {
    schemaVersion: 1,
    kind: "site-logbook-staging-registry-ledger-entry",
    sourceSha: SHA,
    stage: "complete",
    expectedInitialPackageState: "10000",
    packageNames: Object.values(IMAGE_SPECS).map(
      ([packageName]) => packageName,
    ),
    deletedHistoryControl: {
      mode: "reviewed-caller-visible-history-ledger",
      decision: "explicitly-accepted-external-ledger",
      deletedApiQueried: false,
      historicalAbsenceProven: false,
    },
    previousEntry: {
      ledgerEntrySha256: `sha256:${"3".repeat(64)}`,
      preflightDigest: images.preflight.split("@")[1],
    },
  };
  const ledgerEntrySha256 = `sha256:${crypto
    .createHash("sha256")
    .update(canonicalCompactJson(registryLedger))
    .digest("hex")}`;
  return {
    schemaVersion: 3,
    kind: "site-logbook-staging-images",
    publicationStage: "complete",
    sourceSha: SHA,
    callerRepository: "modvolt/site-logbook-registry",
    callerWorkflowRef: CALLER_REF,
    initialPackageState: "10000",
    registryAction: "published",
    publisherRun: { id: "987654321", attempt: "1" },
    deletedHistoryControl: {
      mode: "reviewed-caller-visible-history-ledger",
      decision: "explicitly-accepted-external-ledger",
      ledgerEntrySha256,
      callerWorkflowSha: CALLER_WORKFLOW_SHA,
      visibleRunUniquenessVerified: true,
      workflowRunHistoryScope:
        "github-visible-workflow-runs-below-1000-api-cap",
      deletedApiQueried: false,
    },
    registryLedger,
    toolchain: {
      buildx: "v0.34.1",
      buildkitImage:
        "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
    },
    images,
    packages,
  };
}

function provisioningManifest() {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../docs/audit/16-c3-staging-provisioning.template.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  delete manifest._templateStatus;
  Object.assign(manifest.coolify, {
    serverId: "staging-server",
    projectId: "staging-project",
    environmentId: "staging-environment",
    resourceId: "staging-resource",
  });
  manifest.coolify.source.exactCommitSha = SHA;
  Object.assign(manifest.forbiddenProductionTargets, {
    resourceIds: ["production-resource"],
    environmentIds: ["production-environment"],
    networkIds: ["production-network"],
    volumeNames: ["production-postgres-data"],
    s3Buckets: ["site-logbook-production"],
  });
  manifest.publicRoutes[0].origin = "https://stage-site-logbook.cz";
  manifest.publicRoutes[1].origin = "https://stage-alert-site-logbook.cz";
  Object.assign(manifest.network, {
    observedNetworkId: "staging-network",
    sharedResourceIds: ["staging-resource"],
  });
  const fingerprint = `sha256:${"a".repeat(64)}`;
  for (const volume of manifest.volumes) {
    volume.platformName = `site-logbook-staging-r1-${volume.name}`;
    volume.fingerprint = fingerprint;
  }
  Object.assign(manifest.s3, {
    endpoint: "https://fsn1.your-objectstorage.com",
    region: "fsn1",
    bucket: "site-logbook-staging-r1",
    targetFingerprint: fingerprint,
  });
  return manifest;
}

function fixtureArtifacts() {
  const compactBytes = (value) => Buffer.from(canonicalJson(value), "utf8");
  const prettyBytes = (value) =>
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const manifestValue = candidateImageManifest();
  const imageManifest = prettyBytes(manifestValue);
  const provisioningValue = provisioningManifest();
  const validatedProvisioning = validateStagingProvisioning(provisioningValue, {
    expectedSourceSha: SHA,
  });
  const provisioning = compactBytes(provisioningValue);
  const common = {
    images: manifestValue.images,
    imageManifestSha256: digest(imageManifest).slice("sha256:".length),
    provisioning: validatedProvisioning,
    backupEvidenceId: 71,
    backupRestoreMaxAgeHours: 24,
  };
  const inspectInputs = compactBytes(
    buildStagingDeploymentInputs({ ...common, schemaAction: "inspect" }),
  );
  const transitionInputs = compactBytes(
    buildStagingDeploymentInputs({ ...common, schemaAction: "apply-0105" }),
  );
  const steadyInputs = compactBytes(
    buildStagingDeploymentInputs({ ...common, schemaAction: "steady-0105" }),
  );
  const schemaGate = compactBytes({
    decision: "APPLIED",
    sourceSha: SHA,
    latestExpectedTag: "0105_smooth_nitro",
    expectedMigrations: 105,
    excludedMigration0100Present: false,
    externalStateRows: 0,
    backupEvidenceId: 71,
    backupRestoreAgeHours: 1,
    backupRestoreMaxAgeHours: 24,
    sourceBackupExecutionSha256: `sha256:${"9".repeat(64)}`,
    backupMaxPayloadBytes: 256 * 1024 * 1024,
    backupSizeBytes: 1024,
    inputSha256: digest(transitionInputs),
  });
  const backupEvidence = compactBytes({
    id: 71,
    status: "success",
    sizeBytes: 1024,
    encryptedBackupSha256: `sha256:${"a".repeat(64)}`,
    encryptionFormat: "mve1",
    restoreStatus: "ok",
    createdAt: "2026-08-02T07:45:00.000Z",
    restoreTestedAt: "2026-08-02T08:45:00.000Z",
    checkedAt: "2026-08-02T09:45:00.000Z",
    restoreAgeHours: 1,
    sourceExecutionSha256: `sha256:${"9".repeat(64)}`,
    maxPayloadBytes: 256 * 1024 * 1024,
  });
  const bootstrap = prettyBytes({
    schemaVersion: 1,
    sourceSha: SHA,
    workflowRun: { id: 123456789, attempt: 1 },
    bindings: {
      imageManifestSha256: digest(imageManifest).slice("sha256:".length),
      provisioningManifestSha256: digest(provisioning).slice("sha256:".length),
      deploymentInputsSha256: digest(steadyInputs).slice("sha256:".length),
    },
    environmentId: "site-logbook-staging",
    baseOrigin: "https://stage-site-logbook.cz",
    expectedBuildSha: SHA,
    isolationConfirmed: true,
    deepStorageProbeConfirmed: true,
    mailSandboxConfirmed: true,
    externalAccountsEnabled: false,
    adminUsernameConfigured: true,
    adminPasswordConfigured: true,
    capturedAt: "2026-08-02T11:30:00.000Z",
    readiness: {
      status: "ok",
      dbStatus: "ok",
      migrationParity: true,
      version: SHA,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      appliedMigrations: 105,
      missingMigrationTags: [],
      excludedMigration0100Present: false,
      schemaAction: "steady-0105",
    },
    darkRollout: {
      externalAccountsEnabled: false,
      externalAccountCount: 0,
    },
    authenticated: true,
  });
  return {
    imageManifest,
    inspectInputs,
    transitionInputs,
    steadyInputs,
    schemaGate,
    backupEvidence,
    provisioning,
    bootstrap,
  };
}

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function mutateArtifact(artifactBytes, key, mutate, { canonical = true } = {}) {
  const value = JSON.parse(artifactBytes[key].toString("utf8"));
  mutate(value);
  const pretty = key === "imageManifest" || key === "bootstrap";
  const bytes = canonical
    ? Buffer.from(
        pretty ? `${JSON.stringify(value, null, 2)}\n` : canonicalJson(value),
        "utf8",
      )
    : Buffer.from(JSON.stringify(value), "utf8");
  return { ...artifactBytes, [key]: bytes };
}

function validEvidence(artifactBytes = fixtureArtifacts()) {
  const hashes = Object.fromEntries(
    Object.entries(artifactBytes).map(([key, bytes]) => [key, digest(bytes)]),
  );
  return {
    schemaVersion: 4,
    run: {
      id: "phase16-20260802-001",
      environmentId: "site-logbook-staging",
      baseUrl: "https://stage-site-logbook.cz",
      commitSha: SHA,
      startedAt: "2026-08-02T10:00:00.000Z",
      completedAt: "2026-08-02T12:00:00.000Z",
    },
    isolation: {
      confirmed: true,
      productionTargetsTouched: false,
      productionCopyPresentInsideApprovedBoundary: true,
      rawProductionDataOutsideApprovedBoundary: false,
      mailSandbox: true,
    },
    ci: {
      conclusion: "success",
      runId: 123456789,
      runAttempt: 1,
      commitSha: SHA,
      workflowUrl:
        "https://github.com/modvolt/Site-Logbook/actions/runs/123456789",
    },
    deployment: {
      healthStatus: "ok",
      healthVersion: SHA,
      migrationParity: true,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      appliedMigrations: 105,
      missingMigrationTags: [],
      excludedMigration0100Present: false,
      schemaAction: "steady-0105",
      externalAccountsEnabled: false,
      externalState: {
        externalUsers: 0,
        externalAccounts: 0,
        externalScopes: 0,
        externalEvents: 0,
        totalRows: 0,
      },
      steadyInputSha256: hashes.steadyInputs,
    },
    schemaTransition: {
      decision: "APPLIED",
      sourceSha: SHA,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      externalStateRows: 0,
      backupEvidenceId: 71,
      backupRestoreAgeHours: 1,
      backupRestoreMaxAgeHours: 24,
      sourceBackupExecutionSha256: `sha256:${"9".repeat(64)}`,
      backupMaxPayloadBytes: 256 * 1024 * 1024,
      backupSizeBytes: 1024,
      inputSha256: hashes.transitionInputs,
      evidenceArtifactSha256: hashes.schemaGate,
    },
    backupEvidence: {
      id: 71,
      status: "success",
      sizeBytes: 1024,
      encryptedBackupSha256: `sha256:${"a".repeat(64)}`,
      encryptionFormat: "mve1",
      restoreStatus: "ok",
      createdAt: "2026-08-02T07:45:00.000Z",
      restoreTestedAt: "2026-08-02T08:45:00.000Z",
      checkedAt: "2026-08-02T09:45:00.000Z",
      restoreAgeHours: 1,
      sourceExecutionSha256: `sha256:${"9".repeat(64)}`,
      maxPayloadBytes: 256 * 1024 * 1024,
      evidenceArtifactSha256: hashes.backupEvidence,
    },
    artifacts: {
      imageManifest: {
        schemaVersion: 3,
        sourceSha: SHA,
        sha256: hashes.imageManifest,
        callerWorkflowSha: CALLER_WORKFLOW_SHA,
        publisherWorkflowUrl:
          "https://github.com/modvolt/site-logbook-registry/actions/runs/987654321",
        publisherRunId: "987654321",
        publisherRunAttempt: 1,
      },
      deploymentInputs: {
        inspectSha256: hashes.inspectInputs,
        transitionSha256: hashes.transitionInputs,
        steadySha256: hashes.steadyInputs,
      },
      provisioning: { schemaVersion: 1, sha256: hashes.provisioning },
      bootstrap: {
        schemaVersion: 1,
        sha256: hashes.bootstrap,
        workflowUrl:
          "https://github.com/modvolt/Site-Logbook/actions/runs/123456789",
        runId: 123456789,
        runAttempt: 1,
        sourceSha: SHA,
        capturedAt: "2026-08-02T11:30:00.000Z",
      },
    },
    storage: {
      policyPreflight: "pass",
      distinctTarget: true,
      versioning: "enabled",
      immutableRetention: "enabled",
      targetFingerprint: `sha256:${"b".repeat(64)}`,
    },
    recovery: {
      performed: true,
      dataClassification: "production-copy-restricted",
      databaseRestore: true,
      objectRestore: true,
      objectHashesVerified: true,
      businessSmoke: true,
      objectCountExpected: 13,
      objectCountRestored: 13,
      sourceCreatedAt: "2026-08-02T08:30:00.000Z",
      startedAt: "2026-08-02T10:15:00.000Z",
      completedAt: "2026-08-02T11:45:00.000Z",
      rpoMinutes: 195,
      approvedRpoMinutes: 240,
      rtoMinutes: 90,
      approvedRtoMinutes: 240,
    },
    browser: {
      authSmoke: "pass",
      adminHealth: "pass",
      pwaAssets: "pass",
      desktopSmoke: "pass",
      mobileSmoke: "pass",
    },
    mail: { sandboxDelivery: "pass" },
    alerts: {
      freshnessAlertDelivery: "pass",
      receiverHealth: "pass",
      receiverBuildSha: SHA,
      receiverSyntheticDelivery: "pass",
      durableOutboxDelivery: "pass",
      persistentIdempotency: "pass",
      deadManTrigger: "pass",
      deadManRecovery: "pass",
    },
    approvals: {
      mode: "dual_control",
      operator: "operator-a",
      reviewer: "reviewer-b",
      serviceOwner: "owner-c",
      approvedAt: "2026-08-02T12:10:00.000Z",
    },
  };
}

function validate(evidence, artifactBytes, options = {}) {
  return validateStagingReleaseEvidence(evidence, {
    now: NOW,
    artifactBytes,
    ...options,
  });
}

test("accepts complete schema-v4 exact-0105 staging evidence", () => {
  const artifactBytes = fixtureArtifacts();
  const summary = validate(validEvidence(artifactBytes), artifactBytes);
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.schemaVersion, 4);
  assert.equal(summary.expectedMigrations, 105);
  assert.equal(summary.latestExpectedTag, "0105_smooth_nitro");
  assert.equal(summary.approvalMode, "dual_control");
});

test("rejects production targets, secrets, stale evidence, and commit drift", () => {
  const artifactBytes = fixtureArtifacts();
  const production = validEvidence(artifactBytes);
  production.run.baseUrl = "https://modvoltapp.cz";
  assert.throws(
    () => validate(production, artifactBytes),
    /EVIDENCE_TARGET_UNSAFE/,
  );

  const logicalEnvironmentDrift = validEvidence(artifactBytes);
  logicalEnvironmentDrift.run.environmentId = "modvolt-staging-eu1";
  assert.throws(
    () => validate(logicalEnvironmentDrift, artifactBytes),
    /EVIDENCE_ENVIRONMENT_UNSAFE/,
  );

  const secret = validEvidence(artifactBytes);
  secret.notes = { apiToken: "must-never-be-here" };
  assert.throws(
    () => validate(secret, artifactBytes),
    /EVIDENCE_CONTAINS_SECRET/,
  );

  assert.throws(
    () =>
      validate(validEvidence(artifactBytes), artifactBytes, {
        now: new Date("2026-08-05T12:01:00.000Z"),
      }),
    /EVIDENCE_STALE/,
  );
  const drift = validEvidence(artifactBytes);
  drift.deployment.healthVersion = "f".repeat(40);
  assert.throws(
    () => validate(drift, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );
});

test("rejects every exact-0105 dark-rollout invariant drift", () => {
  const artifactBytes = fixtureArtifacts();
  for (const mutate of [
    (evidence) => (evidence.deployment.latestExpectedTag = "0104_previous"),
    (evidence) => (evidence.deployment.expectedMigrations = 104),
    (evidence) => (evidence.deployment.appliedMigrations = 105.5),
    (evidence) => (evidence.deployment.excludedMigration0100Present = true),
    (evidence) => (evidence.deployment.externalAccountsEnabled = true),
    (evidence) => (evidence.deployment.externalState.externalAccounts = 1),
  ]) {
    const evidence = validEvidence(artifactBytes);
    mutate(evidence);
    assert.throws(() => validate(evidence, artifactBytes));
  }
});

test("recomputes every artifact hash and rejects byte tampering", () => {
  const artifactBytes = fixtureArtifacts();
  const evidence = validEvidence(artifactBytes);
  const tampered = { ...artifactBytes, bootstrap: Buffer.from("tampered\n") };
  assert.throws(
    () => validate(evidence, tampered),
    /EVIDENCE_ARTIFACT_MISMATCH/,
  );
  const missing = { ...artifactBytes };
  delete missing.schemaGate;
  assert.throws(() => validate(evidence, missing), /EVIDENCE_ARTIFACT_MISSING/);
});

test("strictly verifies the complete schema-v3 image manifest before trusting release evidence", () => {
  const artifactBytes = fixtureArtifacts();
  for (const [mutate, pattern] of [
    [
      (manifest) => {
        manifest.packages.api.sbom.packageCount = 0;
      },
      /EVIDENCE_IMAGE_MANIFEST_INVALID.*IMAGE_MANIFEST_SBOM_INVALID/,
    ],
    [
      (manifest) => {
        manifest.deletedHistoryControl.visibleRunUniquenessVerified = false;
      },
      /EVIDENCE_IMAGE_MANIFEST_INVALID.*IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID/,
    ],
    [
      (manifest) => {
        manifest.registryLedger.previousEntry.preflightDigest = `sha256:${"0".repeat(64)}`;
      },
      /EVIDENCE_IMAGE_MANIFEST_INVALID.*IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID/,
    ],
  ]) {
    const manifest = candidateImageManifest();
    mutate(manifest);
    const invalidBytes = {
      ...artifactBytes,
      imageManifest: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    };
    const evidence = validEvidence(invalidBytes);
    assert.throws(() => validate(evidence, invalidBytes), pattern);
  }

  const callerDrift = validEvidence(artifactBytes);
  callerDrift.artifacts.imageManifest.callerWorkflowSha = "2".repeat(40);
  assert.throws(
    () => validate(callerDrift, artifactBytes),
    /EVIDENCE_IMAGE_MANIFEST_INVALID.*IMAGE_MANIFEST_CALLER_MISMATCH/,
  );
});

test("requires canonical exact bytes for all eight raw artifacts", () => {
  for (const key of [
    "imageManifest",
    "inspectInputs",
    "transitionInputs",
    "steadyInputs",
    "schemaGate",
    "backupEvidence",
    "provisioning",
    "bootstrap",
  ]) {
    const noncanonical = mutateArtifact(
      fixtureArtifacts(),
      key,
      () => undefined,
      { canonical: false },
    );
    assert.throws(
      () => validate(validEvidence(noncanonical), noncanonical),
      /EVIDENCE_ARTIFACT_NOT_CANONICAL/,
      key,
    );
  }
});

test("rejects secret-bearing raw artifacts before they can become release evidence", () => {
  for (const key of [
    "imageManifest",
    "inspectInputs",
    "transitionInputs",
    "steadyInputs",
    "schemaGate",
    "backupEvidence",
    "provisioning",
    "bootstrap",
  ]) {
    const secretBearing = mutateArtifact(fixtureArtifacts(), key, (value) => {
      value.credential = "must-not-be-retained";
    });
    assert.throws(
      () => validate(validEvidence(secretBearing), secretBearing),
      /EVIDENCE_CONTAINS_SECRET|EVIDENCE_PROVISIONING_INVALID.*PROVISIONING_SECRET_MATERIAL/,
      key,
    );
  }
});

test("strictly revalidates provisioning, deployment inputs and final raw schemas", () => {
  const mutations = [
    [
      "provisioning",
      (value) => {
        value.validationMode = "plan";
      },
      /EVIDENCE_PROVISIONING_INVALID|EVIDENCE_GATE_NOT_PASSED/,
    ],
    [
      "provisioning",
      (value) => {
        value.observations = { note: `ghp_${"A".repeat(32)}` };
      },
      /EVIDENCE_PROVISIONING_INVALID.*(?:PROVISIONING_SECRET_MATERIAL|PROVISIONING_SCHEMA_INVALID)/,
    ],
    [
      "inspectInputs",
      (value) => {
        value.coolifyEnvironmentId = value.environmentId;
      },
      /EVIDENCE_DEPLOYMENT_INPUT_INVALID/,
    ],
    [
      "inspectInputs",
      (value) => {
        value.backupRestoreMaxAgeHours = 23;
      },
      /EVIDENCE_GATE_NOT_PASSED/,
    ],
    [
      "transitionInputs",
      (value) => {
        value.unexpected = false;
      },
      /EVIDENCE_DEPLOYMENT_INPUT_INVALID/,
    ],
    [
      "schemaGate",
      (value) => {
        value.unexpected = false;
      },
      /EVIDENCE_ARTIFACT_SCHEMA_INVALID/,
    ],
    [
      "backupEvidence",
      (value) => {
        value.unexpected = false;
      },
      /EVIDENCE_ARTIFACT_SCHEMA_INVALID/,
    ],
    [
      "bootstrap",
      (value) => {
        value.readiness.unexpected = false;
      },
      /EVIDENCE_ARTIFACT_SCHEMA_INVALID/,
    ],
    [
      "bootstrap",
      (value) => {
        value.readiness.missingMigrationTags = ["0105_smooth_nitro"];
      },
      /EVIDENCE_GATE_NOT_PASSED/,
    ],
  ];
  for (const [key, mutate, expected] of mutations) {
    const invalid = mutateArtifact(fixtureArtifacts(), key, mutate);
    assert.throws(
      () => validate(validEvidence(invalid), invalid),
      expected,
      key,
    );
  }
});

test("records the restricted production copy without denying its presence", () => {
  const artifactBytes = fixtureArtifacts();
  const oldField = validEvidence(artifactBytes);
  delete oldField.isolation.productionCopyPresentInsideApprovedBoundary;
  oldField.isolation.rawProductionDataExposed = false;
  assert.throws(
    () => validate(oldField, artifactBytes),
    /EVIDENCE_ARTIFACT_SCHEMA_INVALID/,
  );

  for (const [field, value] of [
    ["productionCopyPresentInsideApprovedBoundary", false],
    ["rawProductionDataOutsideApprovedBoundary", true],
  ]) {
    const invalid = validEvidence(artifactBytes);
    invalid.isolation[field] = value;
    assert.throws(
      () => validate(invalid, artifactBytes),
      /EVIDENCE_GATE_NOT_PASSED/,
    );
  }
});

test("derives restore age from raw timestamps instead of trusting declarations", () => {
  const artifactBytes = mutateArtifact(
    fixtureArtifacts(),
    "backupEvidence",
    (value) => {
      value.createdAt = "2026-08-01T07:45:00.000Z";
      value.restoreTestedAt = "2026-08-01T08:45:00.000Z";
      value.checkedAt = "2026-08-02T09:45:00.000Z";
      value.restoreAgeHours = 1;
    },
  );
  const evidence = validEvidence(artifactBytes);
  evidence.backupEvidence.createdAt = "2026-08-01T07:45:00.000Z";
  evidence.backupEvidence.restoreTestedAt = "2026-08-01T08:45:00.000Z";
  evidence.backupEvidence.checkedAt = "2026-08-02T09:45:00.000Z";
  evidence.backupEvidence.restoreAgeHours = 1;
  assert.throws(
    () => validate(evidence, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED|EVIDENCE_BACKUP_STALE/,
  );
});

test("rejects backup, transition, workflow-run, and input-binding drift", () => {
  const artifactBytes = fixtureArtifacts();
  const staleBackup = validEvidence(artifactBytes);
  staleBackup.schemaTransition.backupRestoreAgeHours = 25;
  assert.throws(
    () => validate(staleBackup, artifactBytes),
    /EVIDENCE_BACKUP_STALE/,
  );

  const wrongBackup = validEvidence(artifactBytes);
  wrongBackup.backupEvidence.id = 72;
  assert.throws(
    () => validate(wrongBackup, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );

  const oversized = validEvidence(artifactBytes);
  oversized.schemaTransition.backupSizeBytes = 256 * 1024 * 1024 + 1;
  assert.throws(
    () => validate(oversized, artifactBytes),
    /EVIDENCE_BACKUP_SIZE_INVALID/,
  );

  const wrongBackupExecution = validEvidence(artifactBytes);
  wrongBackupExecution.backupEvidence.sourceExecutionSha256 = `sha256:${"8".repeat(64)}`;
  assert.throws(
    () => validate(wrongBackupExecution, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );

  const wrongWorkflow = validEvidence(artifactBytes);
  wrongWorkflow.ci.workflowUrl =
    "https://github.com/example/modvolt/actions/runs/123456789";
  assert.throws(
    () => validate(wrongWorkflow, artifactBytes),
    /EVIDENCE_WORKFLOW_URL_INVALID/,
  );

  const wrongBinding = validEvidence(artifactBytes);
  wrongBinding.artifacts.deploymentInputs.steadySha256 = `sha256:${"c".repeat(64)}`;
  assert.throws(
    () => validate(wrongBinding, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );
});

test("accepts solo-maintainer controls and rejects a fake reviewer", () => {
  const artifactBytes = fixtureArtifacts();
  const solo = validEvidence(artifactBytes);
  solo.approvals = {
    mode: "solo_maintainer",
    operator: "owner-a",
    reviewer: null,
    serviceOwner: "owner-a",
    soloMaintainerRiskAccepted: true,
    compensatingControls: {
      mainBranchProtected: true,
      exactShaQualityGateRequired: true,
      environmentBranchRestricted: true,
    },
    approvedAt: "2026-08-02T12:10:00.000Z",
  };
  assert.equal(validate(solo, artifactBytes).approvalMode, "solo_maintainer");
  solo.approvals.reviewer = "owner-a";
  assert.throws(
    () => validate(solo, artifactBytes),
    /EVIDENCE_SOLO_MAINTAINER_INVALID/,
  );
});
