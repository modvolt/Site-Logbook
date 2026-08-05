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
  writeBindingArtifacts,
} from "../check-staging-deployment-binding.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CALLER_REF =
  "modvolt/site-logbook-registry/.github/workflows/publish.yml@refs/heads/main";
const SPECS = {
  preflight: ["site-logbook-staging-preflight", "1"],
  mailpit: ["site-logbook-staging-mailpit", "2"],
  api: ["site-logbook-staging-api", "3"],
  web: ["site-logbook-staging-web", "4"],
  alertReceiver: ["site-logbook-staging-alert-receiver", "5"],
};

function manifestFixture() {
  const images = {};
  const packages = {};
  let index = 10;
  for (const [key, [packageName, seed]] of Object.entries(SPECS)) {
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
      remoteManifestVerified: true,
      provenanceVerified: true,
      sbomVerified: true,
    };
  }
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    callerRepository: "modvolt/site-logbook-registry",
    callerWorkflowRef: CALLER_REF,
    initialPackageState: "10000",
    registryAction: "published",
    publisherRun: { id: "123456", attempt: "1" },
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
      expectedRunId: "123456",
      expectedRunAttempt: "1",
    },
  );
  assert.equal(trusted.decision, "PASS");
  assert.equal(trusted.images.api, manifestFixture().images.api);
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
  packageDrift.packages.api.provenanceVerified = "true";
  const packageEncoded = encodedManifest(packageDrift);
  assert.throws(
    () =>
      validateStagingImageManifest(
        packageEncoded.bytes,
        packageEncoded.checksum,
      ),
    /IMAGE_MANIFEST_PACKAGE_INVALID/,
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
        '"schemaVersion": 1,',
        '"schemaVersion": 1, "schemaVersion": 1,',
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
  assert.equal(
    result.steady.environment.STAGING_DEPLOYMENT_INPUTS_SHA256,
    deploymentInputsSha256(result.steady.inputs),
  );
});

test("writes deployment evidence atomically and never overwrites it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "staging-binding-"));
  try {
    const files = writeBindingArtifacts(directory, validBinding());
    assert.deepEqual(Object.keys(files).sort(), [
      "environment",
      "inspectInputs",
      "provisioning",
      "steadyInputs",
      "transitionInputs",
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(files.steadyInputs, "utf8")).schemaAction,
      "steady-0105",
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
