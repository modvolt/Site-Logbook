import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StagingImageManifestError,
  validateStagingImageManifest,
} from "../verify-staging-image-manifest.mjs";
import {
  StagingProvisioningError,
  validateStagingProvisioning,
} from "../check-staging-provisioning.mjs";
import {
  buildStagingDeploymentInputs,
  createStagingDeploymentBinding,
  deploymentInputsSha256,
  validateStagingDeploymentInputs,
  writeBindingArtifacts,
} from "../check-staging-deployment-binding.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CALLER_REF =
  "modvolt/site-logbook-registry/.github/workflows/publish.yml@refs/heads/main";
const CALLER_WORKFLOW_SHA = "f".repeat(40);
const SPECS = {
  preflight: [
    "site-logbook-staging-preflight",
    "1",
    "BUILD_SHA",
    "deploy/staging/preflight/Dockerfile",
    "BUILD_SHA",
    ["sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"],
  ],
  mailpit: [
    "site-logbook-staging-mailpit",
    "2",
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
    "3",
    "BUILD_SHA",
    "artifacts/api-server/Dockerfile",
    "BUILD_SHA",
    ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7"],
  ],
  web: [
    "site-logbook-staging-web",
    "4",
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
    "5",
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

function manifestFixture() {
  const images = {};
  const packages = {};
  let index = 10;
  for (const [
    key,
    [packageName, seed, buildShaEnv, dockerfile, buildArg, baseImageDigests],
  ] of Object.entries(SPECS)) {
    const repository = `ghcr.io/modvolt/${packageName}`;
    const digest = `sha256:${seed.repeat(64)}`;
    images[key] = `${repository}@${digest}`;
    packages[key] = {
      packageName,
      packageId: String(index++),
      visibility: "private",
      repository: "modvolt/site-logbook-registry",
      registryRepository: repository,
      sourceSha: SOURCE_SHA,
      versionId: String(index++),
      digest,
      runnableManifestDigest: digest,
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
        revision: SOURCE_SHA,
        url: `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
        buildSha: SOURCE_SHA,
        buildShaEnv,
      },
      provenance: {
        buildType: "https://mobyproject.org/buildkit@v1",
        vcsSource: "https://github.com/modvolt/Site-Logbook",
        vcsRevision: SOURCE_SHA,
        dockerfile,
        buildArg,
        buildSha: SOURCE_SHA,
        verifiedBaseImageDigests: baseImageDigests,
      },
      sbom: { spdxVersion: "SPDX-2.3", packageCount: 1, relationshipCount: 1 },
    };
  }
  const registryLedger = {
    schemaVersion: 1,
    kind: "site-logbook-staging-registry-ledger-entry",
    sourceSha: SOURCE_SHA,
    stage: "complete",
    expectedInitialPackageState: "10000",
    packageNames: Object.values(SPECS).map(([packageName]) => packageName),
    deletedHistoryControl: {
      mode: "reviewed-caller-visible-history-ledger",
      decision: "explicitly-accepted-external-ledger",
      deletedApiQueried: false,
      historicalAbsenceProven: false,
    },
    previousEntry: {
      ledgerEntrySha256: `sha256:${"d".repeat(64)}`,
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
    sourceSha: SOURCE_SHA,
    callerRepository: "modvolt/site-logbook-registry",
    callerWorkflowRef: CALLER_REF,
    initialPackageState: "10000",
    registryAction: "published",
    publisherRun: { id: "123456", attempt: "1" },
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

function encodedManifest(manifest = manifestFixture()) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, checksum: `${sha256}  staging-images.json\n` };
}

function provisioningFixture() {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const project = "site-logbook-staging";
  const volumes = [
    [
      "staging_pgdata",
      [
        {
          service: "postgres",
          target: "/var/lib/postgresql/data",
          readOnly: false,
        },
      ],
    ],
    [
      "staging_mailtls",
      [{ service: "mailpit", target: "/certs/private", readOnly: false }],
    ],
    [
      "staging_mailca",
      [
        { service: "mailpit", target: "/certs/trust", readOnly: false },
        { service: "api", target: "/run/staging-mail-ca", readOnly: true },
      ],
    ],
    [
      "staging_alert_receipts",
      [
        {
          service: "alert-receiver",
          target: "/var/lib/operational-alert-receiver",
          readOnly: false,
        },
      ],
    ],
  ].map(([name, mounts]) => ({
    name,
    platformName: `${project}-r1-${name}`,
    fingerprint,
    reused: false,
    mounts,
  }));
  return {
    schemaVersion: 1,
    kind: "site-logbook-coolify-staging",
    validationMode: "observed",
    productionTargetsTouched: false,
    coolify: {
      serverId: "staging-server",
      projectId: "staging-project",
      environmentId: "staging-environment",
      resourceId: "staging-resource",
      environmentName: "staging",
      resourceName: "Modvolt staging",
      composeProjectName: project,
      source: {
        repository: "modvolt/Site-Logbook",
        exactCommitSha: SOURCE_SHA,
        composeFile: "/docker-compose.staging.yml",
      },
      settings: {
        createdFromProductionClone: false,
        autoDeploy: false,
        previewDeployments: false,
        rawComposeDeployment: false,
        connectToPredefinedNetwork: false,
        forceHttps: true,
      },
    },
    forbiddenProductionTargets: {
      resourceIds: ["production-resource"],
      environmentIds: ["production-environment"],
      networkIds: ["production-network"],
      volumeNames: ["production-postgres-data"],
      s3Buckets: ["site-logbook-production"],
      names: ["Modvolt", "production"],
      hosts: ["modvoltapp.cz", "www.modvoltapp.cz"],
    },
    publicRoutes: [
      {
        service: "web",
        containerPort: 80,
        origin: "https://stage-site-logbook.cz",
      },
      {
        service: "alert-receiver",
        containerPort: 8080,
        origin: "https://stage-alert-site-logbook.cz",
        webhookPath: "/v1/operational-alerts",
      },
    ],
    privateServices: [
      "api",
      "external-schema-gate",
      "mailpit",
      "postgres",
      "staging-preflight",
    ],
    hostPortBindings: [],
    network: {
      mode: "coolify-per-resource",
      observedNetworkId: "staging-network",
      connectToPredefinedNetwork: false,
      sharedResourceIds: ["staging-resource"],
    },
    volumes,
    s3: {
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      bucket: "site-logbook-staging-r1",
      targetFingerprint: fingerprint,
      accessBoundary: "staging-bucket-only",
      productionBucketAccess: false,
      prefixes: ["private", "public"],
      forcePathStyle: false,
    },
    mail: {
      service: "mailpit",
      publicRoute: false,
      relayConfigured: false,
      forwardingConfigured: false,
      externalSmtpConfigured: false,
      deliveryBoundary: "mailpit-only",
    },
    limits: {
      services: {
        "staging-preflight": { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
        postgres: { cpus: 0.5, memoryMiB: 768, reservationMiB: 512 },
        "external-schema-gate": {
          cpus: 0.25,
          memoryMiB: 384,
          reservationMiB: 192,
        },
        mailpit: { cpus: 0.25, memoryMiB: 256, reservationMiB: 128 },
        api: { cpus: 1, memoryMiB: 1024, reservationMiB: 768 },
        "alert-receiver": { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
        web: { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
      },
      totalCpu: 2.75,
      totalMemoryMiB: 2816,
      totalReservationMiB: 1792,
    },
  };
}

function validBinding() {
  const fixture = encodedManifest();
  return createStagingDeploymentBinding({
    manifestBytes: fixture.bytes,
    checksumText: fixture.checksum,
    provisioningManifest: provisioningFixture(),
    expectedManifestSha256: fixture.sha256,
    expectedSourceSha: SOURCE_SHA,
    expectedCallerWorkflowRef: CALLER_REF,
    expectedCallerWorkflowSha: CALLER_WORKFLOW_SHA,
    expectedRunId: "123456",
    expectedRunAttempt: "1",
    backupEvidenceId: 77,
    backupRestoreMaxAgeHours: 24,
  });
}

test("validates raw image bytes and only authorizes a separately approved checksum", () => {
  const fixture = encodedManifest();
  const untrusted = validateStagingImageManifest(
    fixture.bytes,
    fixture.checksum,
    {
      expectedSourceSha: SOURCE_SHA,
      expectedCallerWorkflowRef: CALLER_REF,
      expectedCallerWorkflowSha: CALLER_WORKFLOW_SHA,
    },
  );
  assert.equal(untrusted.decision, "INTERNALLY_CONSISTENT_UNTRUSTED");
  assert.equal(untrusted.manifestBase64, undefined);

  const trusted = validateStagingImageManifest(
    fixture.bytes,
    fixture.checksum,
    {
      expectedManifestSha256: fixture.sha256,
      expectedSourceSha: SOURCE_SHA,
      expectedCallerWorkflowRef: CALLER_REF,
      expectedCallerWorkflowSha: CALLER_WORKFLOW_SHA,
      expectedRunId: "123456",
      expectedRunAttempt: "1",
    },
  );
  assert.equal(trusted.decision, "PASS");
  assert.equal(trusted.images.api, manifestFixture().images.api);
  assert.throws(
    () =>
      validateStagingImageManifest(fixture.bytes, fixture.checksum, {
        expectedCallerWorkflowSha: "a".repeat(40),
      }),
    /IMAGE_MANIFEST_CALLER_MISMATCH/,
  );
});

test("rejects image checksum, schema, package, and publication-state drift", () => {
  const fixture = encodedManifest();
  assert.throws(
    () =>
      validateStagingImageManifest(
        Buffer.concat([fixture.bytes, Buffer.from(" ")]),
        fixture.checksum,
      ),
    (error) =>
      error instanceof StagingImageManifestError &&
      error.code === "IMAGE_MANIFEST_CHECKSUM_MISMATCH",
  );
  const unknown = manifestFixture();
  unknown.extra = true;
  const unknownEncoded = encodedManifest(unknown);
  assert.throws(
    () =>
      validateStagingImageManifest(
        unknownEncoded.bytes,
        unknownEncoded.checksum,
      ),
    /IMAGE_MANIFEST_SCHEMA_INVALID/,
  );
  const packageDrift = manifestFixture();
  packageDrift.packages.api.provenance.buildSha = "0".repeat(40);
  const packageEncoded = encodedManifest(packageDrift);
  assert.throws(
    () =>
      validateStagingImageManifest(
        packageEncoded.bytes,
        packageEncoded.checksum,
      ),
    /IMAGE_MANIFEST_PROVENANCE_INVALID/,
  );
  const stateDrift = manifestFixture();
  stateDrift.initialPackageState = "00000";
  const stateEncoded = encodedManifest(stateDrift);
  assert.throws(
    () =>
      validateStagingImageManifest(stateEncoded.bytes, stateEncoded.checksum),
    /IMAGE_MANIFEST_PUBLICATION_STATE_INVALID/,
  );

  const duplicateBytes = Buffer.from(
    fixture.bytes
      .toString("utf8")
      .replace(
        '"schemaVersion": 3,',
        '"schemaVersion": 3, "schemaVersion": 3,',
      ),
  );
  const duplicateSha = crypto
    .createHash("sha256")
    .update(duplicateBytes)
    .digest("hex");
  assert.throws(
    () =>
      validateStagingImageManifest(
        duplicateBytes,
        `${duplicateSha}  staging-images.json\n`,
      ),
    /IMAGE_MANIFEST_DUPLICATE_KEY/,
  );
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.bytes]);
  const bomSha = crypto.createHash("sha256").update(bom).digest("hex");
  assert.throws(
    () => validateStagingImageManifest(bom, `${bomSha}  staging-images.json\n`),
    /IMAGE_MANIFEST_ENCODING_INVALID/,
  );
});

test("rejects candidate ledger, inventory, runtime, toolchain, provenance, and SBOM evidence drift", () => {
  for (const [mutate, code] of [
    [
      (value) => {
        value.kind = "unknown";
      },
      "IMAGE_MANIFEST_SCHEMA_INVALID",
    ],
    [
      (value) => {
        value.toolchain.buildx = "latest";
      },
      "IMAGE_MANIFEST_TOOLCHAIN_INVALID",
    ],
    [
      (value) => {
        value.deletedHistoryControl.decision = "historical-absence-proven";
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.deletedHistoryControl.ledgerEntrySha256 = "sha256:bad";
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.deletedHistoryControl.callerWorkflowSha = "0".repeat(40);
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.deletedHistoryControl.visibleRunUniquenessVerified = false;
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.registryLedger.sourceSha = "0".repeat(40);
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.registryLedger.previousEntry.preflightDigest = `sha256:${"0".repeat(64)}`;
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.registryLedger.packageNames.pop();
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.deletedHistoryControl.deletedApiQueried = true;
      },
      "IMAGE_MANIFEST_DELETED_HISTORY_CONTROL_INVALID",
    ],
    [
      (value) => {
        value.publisherRun.attempt = "2";
      },
      "IMAGE_MANIFEST_RUN_MISMATCH",
    ],
    [
      (value) => {
        value.packages.preflight.activeVersionCount = 0;
      },
      "IMAGE_MANIFEST_PACKAGE_INVALID",
    ],
    [
      (value) => {
        value.packages.preflight.packageId = 10;
      },
      "IMAGE_MANIFEST_PACKAGE_INVALID",
    ],
    [
      (value) => {
        value.packages.preflight.versionId = 11;
      },
      "IMAGE_MANIFEST_PACKAGE_INVALID",
    ],
    [
      (value) => {
        value.packages.preflight.deletedInventoryMode = "queried";
      },
      "IMAGE_MANIFEST_PACKAGE_INVALID",
    ],
    [
      (value) => {
        value.packages.web.runtimeMetadata.buildShaEnv = "BUILD_SHA";
      },
      "IMAGE_MANIFEST_RUNTIME_METADATA_INVALID",
    ],
    [
      (value) => {
        value.packages.api.provenance.vcsSource =
          "https://example.invalid/repo";
      },
      "IMAGE_MANIFEST_PROVENANCE_INVALID",
    ],
    [
      (value) => {
        value.packages.mailpit.provenance.verifiedBaseImageDigests = [];
      },
      "IMAGE_MANIFEST_PROVENANCE_INVALID",
    ],
    [
      (value) => {
        value.packages.alertReceiver.sbom.packageCount = 0;
      },
      "IMAGE_MANIFEST_SBOM_INVALID",
    ],
  ]) {
    const manifest = manifestFixture();
    mutate(manifest);
    const encoded = encodedManifest(manifest);
    assert.throws(
      () => validateStagingImageManifest(encoded.bytes, encoded.checksum),
      (error) =>
        error instanceof StagingImageManifestError && error.code === code,
      code,
    );
  }
});

test("accepts only observed isolated Coolify provisioning", () => {
  const summary = validateStagingProvisioning(provisioningFixture(), {
    expectedSourceSha: SOURCE_SHA,
  });
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.authorizesDeployment, true);
  assert.match(summary.manifestSha256, /^[0-9a-f]{64}$/);

  const productionReuse = provisioningFixture();
  productionReuse.coolify.resourceId = "production-resource";
  assert.throws(
    () => validateStagingProvisioning(productionReuse),
    (error) =>
      error instanceof StagingProvisioningError &&
      error.code === "PRODUCTION_TARGET_REUSE",
  );
  const publicDatabase = provisioningFixture();
  publicDatabase.publicRoutes.push({
    service: "postgres",
    containerPort: 5432,
    origin: "https://db.example.test",
  });
  assert.throws(
    () => validateStagingProvisioning(publicDatabase),
    /PUBLIC_ROUTE_SET_DRIFT/,
  );
  const volumeReuse = provisioningFixture();
  volumeReuse.volumes[0].reused = true;
  assert.throws(() => validateStagingProvisioning(volumeReuse), /VOLUME_REUSE/);
  const secret = provisioningFixture();
  secret.s3.secret = "forbidden";
  assert.throws(
    () => validateStagingProvisioning(secret),
    /PROVISIONING_SECRET_MATERIAL/,
  );
  const hiddenToken = provisioningFixture();
  hiddenToken.observations = { note: `ghp_${"A".repeat(32)}` };
  assert.throws(
    () => validateStagingProvisioning(hiddenToken),
    /PROVISIONING_SECRET_MATERIAL|PROVISIONING_SCHEMA_INVALID/,
  );
  const harmlessUnknown = provisioningFixture();
  harmlessUnknown.observations = { note: "unexpected metadata" };
  assert.throws(
    () => validateStagingProvisioning(harmlessUnknown),
    /PROVISIONING_SCHEMA_INVALID/,
  );
  const placeholder = provisioningFixture();
  placeholder.coolify.resourceId = "PENDING";
  assert.throws(
    () => validateStagingProvisioning(placeholder),
    /COOLIFY_TARGET_ID_MISSING/,
  );
  const zeroSha = provisioningFixture();
  zeroSha.coolify.source.exactCommitSha = "0".repeat(40);
  assert.throws(
    () => validateStagingProvisioning(zeroSha),
    /COOLIFY_TARGET_ID_MISSING/,
  );
});

test("creates different inspect, transition and steady deployment bindings", () => {
  const result = validBinding();
  assert.equal(result.decision, "PASS");
  assert.notEqual(result.inspect.sha256, result.transition.sha256);
  assert.notEqual(result.transition.sha256, result.steady.sha256);
  assert.equal(result.steady.inputs.backupEvidenceId, undefined);
  assert.equal(result.transition.inputs.backupEvidenceId, 77);
  assert.equal(result.transition.inputs.environmentId, "site-logbook-staging");
  assert.equal(
    result.transition.inputs.coolifyEnvironmentId,
    "staging-environment",
  );
  assert.equal(
    result.steady.environment.STAGING_DEPLOYMENT_INPUTS_SHA256,
    deploymentInputsSha256(result.steady.inputs),
  );
});

test("strict deployment inputs separate logical and Coolify identities", () => {
  const binding = validBinding();
  assert.doesNotThrow(() =>
    validateStagingDeploymentInputs(binding.inspect.inputs, {
      expectedSchemaAction: "inspect",
      expectedSourceSha: SOURCE_SHA,
      expectedImageManifestSha256: binding.imageManifestSha256,
      expectedProvisioningManifestSha256: binding.provisioningManifestSha256,
      expectedProvisioning: validateStagingProvisioning(provisioningFixture()),
    }),
  );
  for (const mutate of [
    (value) => {
      value.environmentId = value.coolifyEnvironmentId;
    },
    (value) => {
      value.coolifyEnvironmentId = value.environmentId;
    },
    (value) => {
      value.s3Bucket = `${value.s3Bucket}-pending`;
    },
    (value) => {
      value.s3Endpoint = "https://storage.staging.internal";
    },
    (value) => {
      value.publicAppUrl = "https://staging.modvoltapp.cz";
      value.nginxServerName = "staging.modvoltapp.cz";
    },
    (value) => {
      value.operationalAlertReceiverUrl =
        "https://alerts.staging.internal/v1/operational-alerts";
      value.operationalAlertReceiverHost = "alerts.staging.internal";
    },
    (value) => {
      value.operationalAlertReceiverUrl = `${value.publicAppUrl}v1/operational-alerts`;
      value.operationalAlertReceiverHost = value.nginxServerName;
    },
    (value) => {
      value.extra = true;
    },
  ]) {
    const value = structuredClone(binding.inspect.inputs);
    mutate(value);
    assert.throws(() =>
      validateStagingDeploymentInputs(value, {
        expectedSchemaAction: "inspect",
        expectedSourceSha: SOURCE_SHA,
      }),
    );
  }
});

test("writes deployment evidence atomically and never overwrites it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "staging-binding-"));
  try {
    const files = writeBindingArtifacts(directory, validBinding());
    assert.deepEqual(Object.keys(files).sort(), [
      "environment",
      "inspectInputs",
      "inspectInputsChecksum",
      "provisioning",
      "steadyInputs",
      "steadyInputsChecksum",
      "transitionInputs",
      "transitionInputsChecksum",
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(files.steadyInputs, "utf8")).schemaAction,
      "steady-0105",
    );
    assert.equal(
      fs.readFileSync(files.transitionInputsChecksum, "utf8"),
      `${validBinding().transition.sha256}  staging-deployment-transition.json\n`,
    );
    assert.throws(
      () => writeBindingArtifacts(directory, validBinding()),
      /DEPLOYMENT_BINDING_OUTPUT_EXISTS/,
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical deployment hashes change on any bound runtime field", () => {
  const provisioning = validateStagingProvisioning(provisioningFixture());
  const images = manifestFixture().images;
  const base = buildStagingDeploymentInputs({
    images,
    imageManifestSha256: "a".repeat(64),
    provisioning,
    schemaAction: "steady-0105",
  });
  const changed = { ...base, publicAppUrl: "https://other-site-logbook.cz" };
  assert.notEqual(
    deploymentInputsSha256(base),
    deploymentInputsSha256(changed),
  );
});
