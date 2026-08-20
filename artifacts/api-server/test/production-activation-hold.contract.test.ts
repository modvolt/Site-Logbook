import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalProductionActivationJson,
  PRODUCTION_ACTIVATION_HEALTH_PATH,
  productionHoldResponse,
  readStableRegularFile,
  startProductionActivationHold,
  validateProductionActivationBundleTransport,
  type JsonValue,
  type ProductionActivationBundleV2,
  type ProductionActivationExpectedBinding,
  type ProductionActivationHoldController,
} from "../src/lib/production-activation-hold";
import {
  createProductionActivationContractTestVerifier,
  PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION,
  PRODUCTION_ACTIVATION_APPROVAL_SCHEMA,
  PRODUCTION_ACTIVATION_CONTRACT_TEST_CONFIRMATION,
  productionActivationContainerIdMatches,
  verifyProductionActivationContractV2,
  type ProductionActivationContractAdapters,
} from "../src/lib/production-activation-contract";
import {
  canonicalProductionRuntimeDbCredentialJson,
  productionRuntimeDbCredentialSha256,
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA,
} from "../src/lib/production-runtime-db-credential-cutover";
import { productionRuntimeBindingMatches } from "../src/lib/migration-health";
import { createProductionRuntimeBinding } from "../src/lib/production-startup-evidence";
import { verifyProductionApiImageProvenanceArtifactWithTestAuthority } from "../../../scripts/production-evidence/host-attestation-contract.mjs";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const SOURCE_SHA = "1".repeat(40);
const IMAGE = `ghcr.io/modvolt/site-logbook-api@sha256:${"2".repeat(64)}`;
const DESIRED = "3".repeat(64);
const DEPLOYED = DESIRED;
const RESOLVED = "5".repeat(64);
const CONTAINER = "a".repeat(64);
const NONCE = "b".repeat(64);
const EXECUTOR_SHA = "6".repeat(40);
const LIVE_SOURCE_IMAGE = `ghcr.io/modvolt/site-logbook-api@sha256:${"7".repeat(64)}`;
const EXECUTOR_IMAGE = `ghcr.io/modvolt/site-logbook-control-plane@sha256:${"8".repeat(64)}`;
const MIGRATION_PLAN_SHA256 = `sha256:${"9".repeat(64)}`;
const ROLE_PRECONDITION_SHA256 = `sha256:${"c".repeat(64)}`;
const ROLE_RECEIPT_SHA256 = `sha256:${"d".repeat(64)}`;
const ROLE_POSTCOMMIT_SHA256 = `sha256:${"e".repeat(64)}`;
const MIGRATION_TRANSITION_SHA256 = `sha256:${"f".repeat(64)}`;
const FINAL_LIVE_SHA256 = `sha256:${"0".repeat(64)}`;
const SCHEMA_FINGERPRINT_SHA256 = `sha256:${"a".repeat(64)}`;
const PUBLICATION_RECEIPT_SHA256 = `sha256:${"3".repeat(64)}`;
const REVIEWED_IMAGE_SET_SHA256 = `sha256:${"4".repeat(64)}`;
const API_RUNNABLE_MANIFEST_DIGEST = `sha256:${"5".repeat(64)}`;
const API_OCI_PROVENANCE_SHA256 = `sha256:${"6".repeat(64)}`;

const temporaryDirectories: string[] = [];
const controllers: ProductionActivationHoldController[] = [];

afterEach(async () => {
  await Promise.all(
    controllers
      .splice(0)
      .map((controller) => controller.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function spkiFingerprint(key: KeyObject): string {
  return `sha256:${digest(
    key.export({ format: "der", type: "spki" }) as Buffer,
  )}`;
}

function artifact(kind: string, payload: JsonValue) {
  return {
    kind,
    payload,
    sha256: digest(canonicalProductionActivationJson(payload)),
  };
}

function imageProvenance(
  privateKey: KeyObject,
  keyId: string,
  sourceSha: string,
  overrides: Readonly<Record<string, JsonValue>> = {},
) {
  const value = {
    schemaVersion: "site-logbook.production-api-image-provenance/v2",
    keyId,
    subjectImage: IMAGE,
    subjectDigest: `sha256:${"2".repeat(64)}`,
    sourceSha,
    publicationReceiptSha256: PUBLICATION_RECEIPT_SHA256,
    reviewedImageSetSha256: REVIEWED_IMAGE_SET_SHA256,
    subjectRunnableManifestDigest: API_RUNNABLE_MANIFEST_DIGEST,
    ociProvenanceSha256: API_OCI_PROVENANCE_SHA256,
    buildProfile: "production",
    mutatingEntrypointsPresent: false,
    ...overrides,
  };
  const canonical = canonicalProductionActivationJson(value);
  return {
    canonical,
    signatureB64: sign(null, Buffer.from(canonical), privateKey).toString(
      "base64",
    ),
  };
}

function credentialEvidence() {
  const request = {
    schemaVersion: PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA,
    kind: "site-logbook-production-runtime-db-credential-cutover-request",
    liveSourceSha: SOURCE_SHA,
    executorSourceSha: EXECUTOR_SHA,
    executorImage: EXECUTOR_IMAGE,
    databaseName: "site_logbook",
    runtimeRole: "site_logbook_runtime",
    migratorRole: "site_logbook_migrator",
    expectedMigrationPlanSha256: MIGRATION_PLAN_SHA256,
    expectedRoleTransactionReceiptSha256: ROLE_RECEIPT_SHA256,
    expectedRolePostCommitArtifactSha256: ROLE_POSTCOMMIT_SHA256,
    approvalId: "runtime-credential-cutover-20260818",
    advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    confirmation: PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
    authorizesDeployment: false,
  } as const;
  const requestCanonical = canonicalProductionRuntimeDbCredentialJson(request);
  const receipt = {
    schemaVersion: PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA,
    kind: "site-logbook-production-runtime-db-credential-cutover-receipt",
    decision: "PASS",
    sourceBinding: {
      liveSourceSha: SOURCE_SHA,
      executorSourceSha: EXECUTOR_SHA,
      executorImage: EXECUTOR_IMAGE,
    },
    requestSha256: productionRuntimeDbCredentialSha256(requestCanonical),
    database: {
      name: "site_logbook",
      adminSessionUser: "stavba",
      runtimeUser: "site_logbook_runtime",
      migratorUser: "site_logbook_migrator",
    },
    roleEvidence: {
      migrationPlanSha256: MIGRATION_PLAN_SHA256,
      transactionReceiptSha256: ROLE_RECEIPT_SHA256,
      postCommitArtifactSha256: ROLE_POSTCOMMIT_SHA256,
    },
    transaction: {
      isolationLevel: "serializable",
      advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
      credentialMutationMechanism:
        "postgresql-16-client-side-scram-sha-256-verifier",
      cleartextCredentialSentInSql: false,
      cleartextCredentialSentAsQueryParameter: false,
      committed: true,
    },
    verification: {
      credentialWasAbsentBefore: true,
      credentialPresentInTransaction: true,
      exactScramVerifierStoredInTransaction: true,
      freshRuntimeLoginVerified: true,
      exactRuntimeIdentityVerified: true,
    },
    approvalId: request.approvalId,
    startedAt: "2026-08-18T11:58:00.000Z",
    completedAt: "2026-08-18T11:58:30.000Z",
    requiresExplicitCoolifySecretTransfer: true,
    authorizesApplicationStart: false,
    authorizesDeployment: false,
  } as const;
  return { request, receipt };
}

function evidence(
  containerId: string,
  apiImageProvenance: ReturnType<typeof imageProvenance>,
) {
  const receipts = Array.from({ length: 10 }, (_, index) =>
    artifact(`migration-receipt-${index + 1}`, {
      ordinal: index + 1,
      result: "PASS",
    }),
  );
  const credentials = credentialEvidence();
  const finalObservations = {
    coolify: artifact("final-coolify-observation", { result: "PASS" }),
    docker: artifact("final-docker-observation", { result: "PASS" }),
    postgres: artifact("final-postgres-observation", { result: "PASS" }),
  };
  const activationApproval = artifact("activation-approval", {
    schemaVersion: PRODUCTION_ACTIVATION_APPROVAL_SCHEMA,
    kind: "site-logbook-production-activation-approval-v2",
    decision: "APPROVE",
    confirmation: PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION,
    sourceSha: EXECUTOR_SHA,
    apiImage: IMAGE,
    nonce: NONCE,
    containerId,
    desiredConfigSha256: DESIRED,
    deployedConfigSha256: DEPLOYED,
    resolvedComposeSha256: RESOLVED,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: SCHEMA_FINGERPRINT_SHA256,
    composeProject: "site_logbook",
    postgresService: "postgres",
    postgresVolumeDestination: "/var/lib/postgresql/data",
    expectedNetworkServices: ["api", "postgres", "web"],
    migrationTransitionSha256: MIGRATION_TRANSITION_SHA256,
    finalLiveIdentitySha256: FINAL_LIVE_SHA256,
    credentialRequestSha256: productionRuntimeDbCredentialSha256(
      canonicalProductionRuntimeDbCredentialJson(credentials.request),
    ),
    credentialReceiptSha256: productionRuntimeDbCredentialSha256(
      canonicalProductionRuntimeDbCredentialJson(credentials.receipt),
    ),
    coolifyObservationSha256: `sha256:${finalObservations.coolify.sha256}`,
    dockerObservationSha256: `sha256:${finalObservations.docker.sha256}`,
    postgresObservationSha256: `sha256:${finalObservations.postgres.sha256}`,
    approvedAt: "2026-08-18T11:59:30.000Z",
    operator: "release-reviewer",
    authorizesApplicationStart: true,
    authorizesDeployment: false,
  });
  return {
    activationApproval,
    apiImageProvenance,
    exact0096Backup: {
      detachedSignature: artifact("exact-0096-backup-detached-signature", {
        signatureBase64: "public-fixture",
      }),
      passReceipt: artifact("exact-0096-backup-pass-receipt", {
        result: "PASS",
      }),
      plan: artifact("exact-0096-backup-plan", { revision: 2 }),
      signature: artifact("exact-0096-backup-signature", {
        algorithm: "Ed25519",
        signature: "public-fixture",
      }),
      trace: artifact("exact-0096-backup-trace", { result: "PASS" }),
    },
    finalObservations,
    migration0096To0107: {
      finalLive: artifact("migration-final-live", { result: "PASS" }),
      intent: artifact("migration-intent", { revision: 2 }),
      persistence: artifact("migration-persistence", { result: "PASS" }),
      plan: artifact("migration-plan", { revision: 2 }),
      postcommit: artifact("migration-postcommit", { result: "PASS" }),
      receipts,
      role: artifact("migration-role", { result: "PASS" }),
      transitionPass: artifact("migration-transition-pass", { result: "PASS" }),
    },
    runtimeDatabaseCredentialCutover: {
      passReceipt: artifact(
        "runtime-database-credential-cutover-pass-receipt",
        credentials.receipt,
      ),
      request: artifact(
        "runtime-database-credential-cutover-request",
        credentials.request,
      ),
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "activation-hold-"));
  temporaryDirectories.push(directory);
  const publisher = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  const publisherPublicKeyPem = publisher.publicKey.export({
    format: "pem",
    type: "spki",
  }) as string;
  const hostPublicKeyPem = host.publicKey.export({
    format: "pem",
    type: "spki",
  }) as string;
  const publisherPublicKeyFile = path.join(
    directory,
    "activation-publisher-ed25519-public.pem",
  );
  const hostPublicKeyFile = path.join(
    directory,
    "activation-host-ed25519-public.pem",
  );
  await writeFile(publisherPublicKeyFile, publisherPublicKeyPem, {
    encoding: "utf8",
    mode: 0o444,
  });
  await writeFile(hostPublicKeyFile, hostPublicKeyPem, {
    encoding: "utf8",
    mode: 0o444,
  });
  return {
    directory,
    publisherPrivateKey: publisher.privateKey,
    publisherPublicKeyPem,
    publisherPublicKeyFile,
    publisherPublicKeySha256: spkiFingerprint(publisher.publicKey),
    hostPrivateKey: host.privateKey,
    hostPublicKeyFile,
    hostPublicKeySha256: spkiFingerprint(host.publicKey),
    bundleFile: path.join(directory, "activation-bundle-v2.json"),
  };
}

function expected(
  overrides: Partial<ProductionActivationExpectedBinding> = {},
): ProductionActivationExpectedBinding {
  return {
    sourceSha: EXECUTOR_SHA,
    apiImage: IMAGE,
    containerId: CONTAINER,
    nonce: NONCE,
    ...overrides,
  };
}

function signedBundle(
  publisherPrivateKey: KeyObject,
  publisherPublicKeySha256: string,
  hostPrivateKey: KeyObject,
  hostPublicKeySha256: string,
  binding: ProductionActivationExpectedBinding = expected(),
  overrides: Readonly<Record<string, JsonValue>> = {},
) {
  const activationEvidence = evidence(
    binding.containerId,
    imageProvenance(
      publisherPrivateKey,
      publisherPublicKeySha256,
      binding.sourceSha,
    ),
  );
  const hostAttestation = {
    activationEvidenceSha256: digest(
      canonicalProductionActivationJson(activationEvidence),
    ),
    apiImage: binding.apiImage,
    containerId: binding.containerId,
    deployedConfigSha256: DEPLOYED,
    desiredConfigSha256: DESIRED,
    kind: "site-logbook-production-host-attestation-v2",
    nonce: binding.nonce,
    observedAt: "2026-08-18T11:59:00.000Z",
    resolvedComposeSha256: RESOLVED,
    schemaVersion: 2,
    sourceSha: binding.sourceSha,
  };
  const activation = {
    apiImage: binding.apiImage,
    containerId: binding.containerId,
    deployedConfigSha256: DEPLOYED,
    desiredConfigSha256: DESIRED,
    evidence: activationEvidence,
    expiresAt: "2026-08-18T12:05:00.000Z",
    hostAttestationSha256: digest(
      canonicalProductionActivationJson(hostAttestation),
    ),
    issuedAt: "2026-08-18T12:00:00.000Z",
    kind: "site-logbook-production-activation-bundle-v2",
    nonce: binding.nonce,
    resolvedComposeSha256: RESOLVED,
    schemaVersion: 2,
    sourceSha: binding.sourceSha,
    ...overrides,
  };
  const signature = (
    value: unknown,
    privateKey: KeyObject,
    publicKeySha256: string,
  ) => ({
    algorithm: "Ed25519",
    keyId: publicKeySha256,
    signatureBase64: sign(
      null,
      Buffer.from(canonicalProductionActivationJson(value)),
      privateKey,
    ).toString("base64"),
  });
  return {
    activation,
    activationSignature: signature(
      activation,
      publisherPrivateKey,
      publisherPublicKeySha256,
    ),
    hostAttestation,
    hostAttestationSignature: signature(
      hostAttestation,
      hostPrivateKey,
      hostPublicKeySha256,
    ),
  };
}

function signedFixtureBundle(
  files: Awaited<ReturnType<typeof fixture>>,
  binding: ProductionActivationExpectedBinding = expected(),
  overrides: Readonly<Record<string, JsonValue>> = {},
) {
  return signedBundle(
    files.publisherPrivateKey,
    files.publisherPublicKeySha256,
    files.hostPrivateKey,
    files.hostPublicKeySha256,
    binding,
    overrides,
  );
}

describe("production activation HOLD transport", () => {
  it("binds a Docker short hostname only to its exact full daemon ID", () => {
    const short = CONTAINER.slice(0, 12);
    const samePrefixAlias = `${short}${"c".repeat(52)}`;

    expect(productionActivationContainerIdMatches(short, CONTAINER)).toBe(true);
    expect(
      productionActivationContainerIdMatches(
        `${short.slice(0, 11)}b`,
        CONTAINER,
      ),
    ).toBe(false);
    expect(productionActivationContainerIdMatches(CONTAINER, CONTAINER)).toBe(
      true,
    );
    expect(
      productionActivationContainerIdMatches(CONTAINER, samePrefixAlias),
    ).toBe(false);
    expect(productionActivationContainerIdMatches(short, short)).toBe(false);
  });

  it("accepts only canonical signed bytes bound to this immutable container", async () => {
    const files = await fixture();
    const bundle = signedFixtureBundle(files);
    const bytes = Buffer.from(canonicalProductionActivationJson(bundle));

    await expect(
      validateProductionActivationBundleTransport(
        bytes,
        expected(),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        files.hostPublicKeyFile,
        files.hostPublicKeySha256,
        NOW,
      ),
    ).resolves.toMatchObject({
      activation: {
        kind: "site-logbook-production-activation-bundle-v2",
        containerId: CONTAINER,
        nonce: NONCE,
      },
    });

    const noncanonical = Buffer.from(
      JSON.stringify(bundle, null, 2).replaceAll("\n", "\r\n"),
    );
    await expect(
      validateProductionActivationBundleTransport(
        noncanonical,
        expected(),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        files.hostPublicKeyFile,
        files.hostPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/CANONICAL_INVALID/);
  });

  it.each([
    "Bearer neutral-field-credential",
    "SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
    `ghp_${"A".repeat(36)}`,
    `github_pat_${"A".repeat(22)}_${"B".repeat(59)}`,
  ])(
    "rejects private credential material under a neutral key",
    async (secret) => {
      const files = await fixture();
      const bundle = signedFixtureBundle(files);
      const activation = bundle.activation as unknown as Record<
        string,
        unknown
      >;
      const evidence = activation.evidence as Record<string, unknown>;
      const approvalArtifact = evidence.activationApproval as Record<
        string,
        unknown
      >;
      const approvalPayload = approvalArtifact.payload as Record<
        string,
        unknown
      >;
      approvalPayload.operator = secret;

      await expect(
        validateProductionActivationBundleTransport(
          Buffer.from(canonicalProductionActivationJson(bundle)),
          expected(),
          files.publisherPublicKeyFile,
          files.publisherPublicKeySha256,
          files.hostPublicKeyFile,
          files.hostPublicKeySha256,
          NOW,
        ),
      ).rejects.toThrow(/PRODUCTION_ACTIVATION_PRIVATE_MATERIAL/);
    },
  );

  it("rejects one Ed25519 key aliased through different PEM formatting", async () => {
    const files = await fixture();
    const publisherPem = await readFile(files.publisherPublicKeyFile, "utf8");
    const aliasedHostPublicKeyFile = path.join(
      files.directory,
      "aliased-host-ed25519-public.pem",
    );
    await writeFile(aliasedHostPublicKeyFile, `${publisherPem}\n`, "utf8");
    const bundle = signedBundle(
      files.publisherPrivateKey,
      files.publisherPublicKeySha256,
      files.publisherPrivateKey,
      files.publisherPublicKeySha256,
    );

    await expect(
      validateProductionActivationBundleTransport(
        Buffer.from(canonicalProductionActivationJson(bundle)),
        expected(),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        aliasedHostPublicKeyFile,
        files.publisherPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_TRUST_KEY_INVALID/);
  });

  it("rejects identical canonical DER SPKI material for both signer roles", async () => {
    const files = await fixture();
    const publisherPem = await readFile(files.publisherPublicKeyFile);
    const duplicateHostPublicKeyFile = path.join(
      files.directory,
      "duplicate-host-ed25519-public.pem",
    );
    await writeFile(duplicateHostPublicKeyFile, publisherPem);
    const bundle = signedBundle(
      files.publisherPrivateKey,
      files.publisherPublicKeySha256,
      files.publisherPrivateKey,
      files.publisherPublicKeySha256,
    );

    await expect(
      validateProductionActivationBundleTransport(
        Buffer.from(canonicalProductionActivationJson(bundle)),
        expected(),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        duplicateHostPublicKeyFile,
        files.publisherPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/distinct pinned Ed25519 SPKI keys/);
  });

  it("rejects expired, container-mismatched, and restart-replay evidence", async () => {
    const files = await fixture();
    const expired = signedFixtureBundle(files, expected(), {
      expiresAt: "2026-08-18T11:59:59.000Z",
    });
    await expect(
      validateProductionActivationBundleTransport(
        Buffer.from(canonicalProductionActivationJson(expired)),
        expected(),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        files.hostPublicKeyFile,
        files.hostPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/TIME_INVALID/);

    const valid = Buffer.from(
      canonicalProductionActivationJson(signedFixtureBundle(files)),
    );
    await expect(
      validateProductionActivationBundleTransport(
        valid,
        expected({ containerId: "c".repeat(64) }),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        files.hostPublicKeyFile,
        files.hostPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/BINDING_MISMATCH/);
    await expect(
      validateProductionActivationBundleTransport(
        valid,
        expected({ nonce: "d".repeat(64) }),
        files.publisherPublicKeyFile,
        files.publisherPublicKeySha256,
        files.hostPublicKeyFile,
        files.hostPublicKeySha256,
        NOW,
      ),
    ).rejects.toThrow(/BINDING_MISMATCH/);
  });

  it("rejects multiple hard links before parsing", async () => {
    const files = await fixture();
    const target = path.join(files.directory, "target.json");
    await writeFile(target, "{}\n");
    const hardlink = path.join(files.directory, "hardlink.json");
    await link(target, hardlink);
    await expect(readStableRegularFile(target, 1024)).rejects.toThrow(
      /FILE_UNSAFE/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinks before parsing",
    async () => {
      const files = await fixture();
      const target = path.join(files.directory, "target.json");
      await writeFile(target, "{}\n");
      const symbolic = path.join(files.directory, "symbolic.json");
      await symlink(target, symbolic);
      await expect(readStableRegularFile(symbolic, 1024)).rejects.toThrow(
        /FILE_UNSAFE/,
      );
    },
  );
});

describe("production activation HOLD lifecycle", () => {
  it("keeps external requests at 503 while loopback Docker health is 200", () => {
    const challenge = {
      kind: "site-logbook-production-activation-challenge-v2" as const,
      ...expected(),
    };
    expect(
      productionHoldResponse(
        "/api/healthz",
        "GET",
        "127.0.0.1",
        challenge,
        null,
      ).status,
    ).toBe(503);
    expect(
      productionHoldResponse(
        PRODUCTION_ACTIVATION_HEALTH_PATH,
        "GET",
        "203.0.113.7",
        challenge,
        null,
      ).status,
    ).toBe(503);
    expect(
      productionHoldResponse(
        PRODUCTION_ACTIVATION_HEALTH_PATH,
        "GET",
        "::ffff:127.0.0.1",
        challenge,
        null,
      ).status,
    ).toBe(200);
  });

  it("does not start application work for absent or invalid evidence", async () => {
    const files = await fixture();
    const startRuntime = vi.fn(async () => undefined);
    const loadSemanticVerifier = vi.fn(async () => async () => undefined);
    const controller = await startProductionActivationHold({
      port: 0,
      host: "127.0.0.1",
      evidenceFile: files.bundleFile,
      publisherPublicKeyFile: files.publisherPublicKeyFile,
      publisherPublicKeySha256: files.publisherPublicKeySha256,
      hostPublicKeyFile: files.hostPublicKeyFile,
      hostPublicKeySha256: files.hostPublicKeySha256,
      expected: expected(),
      nonce: NONCE,
      pollIntervalMs: 60_000,
      now: () => NOW,
      loadSemanticVerifier,
      startRuntime,
    });
    controllers.push(controller);
    expect(controller.challenge).toEqual({
      kind: "site-logbook-production-activation-challenge-v2",
      sourceSha: EXECUTOR_SHA,
      apiImage: IMAGE,
      containerId: CONTAINER,
      nonce: NONCE,
    });
    expect(controller.challenge).not.toHaveProperty("desiredConfigSha256");
    expect(controller.challenge).not.toHaveProperty("deployedConfigSha256");
    expect(controller.challenge).not.toHaveProperty("resolvedComposeSha256");
    await controller.checkNow();
    expect(controller.state).toBe("HOLD");
    expect(startRuntime).not.toHaveBeenCalled();
    expect(loadSemanticVerifier).not.toHaveBeenCalled();

    await writeFile(files.bundleFile, "{}\n");
    await controller.checkNow();
    expect(controller.state).toBe("HOLD");
    expect(startRuntime).not.toHaveBeenCalled();
    expect(loadSemanticVerifier).not.toHaveBeenCalled();

    const response = await fetch(
      `http://127.0.0.1:${controller.port}/api/healthz`,
    );
    expect(response.status).toBe(503);
  });

  it("closes HOLD and starts the runtime exactly once after valid semantic proof", async () => {
    const files = await fixture();
    const configFile = path.join(files.directory, "deployed-compose.txt");
    await writeFile(configFile, "immutable-config-bytes\n");
    const configBefore = digest(await readFile(configFile));
    const bundle = signedFixtureBundle(files);
    await writeFile(
      files.bundleFile,
      canonicalProductionActivationJson(bundle),
      "utf8",
    );
    const runtimeAuthority = Object.freeze({ sourceSha: SOURCE_SHA });
    const semanticVerifier = vi.fn(
      async (_value: ProductionActivationBundleV2) => runtimeAuthority,
    );
    const startRuntime = vi.fn(
      async (_authority: typeof runtimeAuthority) => undefined,
    );
    const controller = await startProductionActivationHold({
      port: 0,
      host: "127.0.0.1",
      evidenceFile: files.bundleFile,
      publisherPublicKeyFile: files.publisherPublicKeyFile,
      publisherPublicKeySha256: files.publisherPublicKeySha256,
      hostPublicKeyFile: files.hostPublicKeyFile,
      hostPublicKeySha256: files.hostPublicKeySha256,
      expected: expected(),
      nonce: NONCE,
      pollIntervalMs: 60_000,
      now: () => NOW,
      loadSemanticVerifier: async () => semanticVerifier,
      startRuntime,
    });
    controllers.push(controller);
    await Promise.all([controller.checkNow(), controller.checkNow()]);

    expect(controller.state).toBe("ACTIVE");
    expect(semanticVerifier).toHaveBeenCalledTimes(1);
    expect(startRuntime).toHaveBeenCalledTimes(1);
    expect(startRuntime).toHaveBeenCalledWith(runtimeAuthority);
    expect(digest(await readFile(configFile))).toBe(configBefore);
  });

  it("fails stopped exactly once when runtime startup fails after HOLD closes", async () => {
    const files = await fixture();
    await writeFile(
      files.bundleFile,
      canonicalProductionActivationJson(signedFixtureBundle(files)),
      "utf8",
    );
    const runtimeAuthority = Object.freeze({ sourceSha: SOURCE_SHA });
    const events: Readonly<Record<string, JsonValue>>[] = [];
    const onFatal = vi.fn();
    const startRuntime = vi.fn(async () => {
      throw new Error("runtime-start-failed");
    });
    const controller = await startProductionActivationHold({
      port: 0,
      host: "127.0.0.1",
      evidenceFile: files.bundleFile,
      publisherPublicKeyFile: files.publisherPublicKeyFile,
      publisherPublicKeySha256: files.publisherPublicKeySha256,
      hostPublicKeyFile: files.hostPublicKeyFile,
      hostPublicKeySha256: files.hostPublicKeySha256,
      expected: expected(),
      nonce: NONCE,
      pollIntervalMs: 60_000,
      now: () => NOW,
      loadSemanticVerifier: async () => async () => runtimeAuthority,
      startRuntime,
      onFatal,
      onEvent: (event) => {
        events.push(event);
        if (event.event === "production-activation-fatal") {
          throw new Error("telemetry-failed");
        }
      },
    });
    controllers.push(controller);

    await expect(controller.checkNow()).rejects.toThrow("runtime-start-failed");
    expect(controller.state).toBe("STOPPED");
    expect(controller.lastRejectionCode).toBe("PRODUCTION_ACTIVATION_REJECTED");
    expect(startRuntime).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledWith(runtimeAuthority);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.event === "production-activation-fatal"),
    ).toHaveLength(1);
    await expect(controller.checkNow()).rejects.toThrow("runtime-start-failed");
    expect(onFatal).toHaveBeenCalledOnce();
    await expect(
      fetch(`http://127.0.0.1:${controller.port}/api/healthz`),
    ).rejects.toThrow();
  });

  it("never changes STOPPED back to ACTIVE when stop races runtime startup", async () => {
    const files = await fixture();
    await writeFile(
      files.bundleFile,
      canonicalProductionActivationJson(signedFixtureBundle(files)),
      "utf8",
    );
    const runtimeAuthority = Object.freeze({ sourceSha: SOURCE_SHA });
    let resolveRuntime!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      resolveRuntime = resolve;
    });
    const startRuntime = vi.fn(async () => runtimeStarted);
    const onFatal = vi.fn();
    const controller = await startProductionActivationHold({
      port: 0,
      host: "127.0.0.1",
      evidenceFile: files.bundleFile,
      publisherPublicKeyFile: files.publisherPublicKeyFile,
      publisherPublicKeySha256: files.publisherPublicKeySha256,
      hostPublicKeyFile: files.hostPublicKeyFile,
      hostPublicKeySha256: files.hostPublicKeySha256,
      expected: expected(),
      nonce: NONCE,
      pollIntervalMs: 60_000,
      now: () => NOW,
      loadSemanticVerifier: async () => async () => runtimeAuthority,
      startRuntime,
      onFatal,
    });
    controllers.push(controller);
    const activation = controller.checkNow();
    await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledOnce());
    await controller.stop();
    resolveRuntime();
    await activation;

    expect(controller.state).toBe("STOPPED");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("keeps transport-valid but untrusted domain evidence in HOLD", async () => {
    const files = await fixture();
    await writeFile(
      files.bundleFile,
      canonicalProductionActivationJson(signedFixtureBundle(files)),
    );
    const startRuntime = vi.fn(async () => undefined);
    const controller = await startProductionActivationHold({
      port: 0,
      host: "127.0.0.1",
      evidenceFile: files.bundleFile,
      publisherPublicKeyFile: files.publisherPublicKeyFile,
      publisherPublicKeySha256: files.publisherPublicKeySha256,
      hostPublicKeyFile: files.hostPublicKeyFile,
      hostPublicKeySha256: files.hostPublicKeySha256,
      expected: expected(),
      nonce: NONCE,
      pollIntervalMs: 60_000,
      now: () => NOW,
      loadSemanticVerifier: async () => verifyProductionActivationContractV2,
      startRuntime,
    });
    controllers.push(controller);
    await controller.checkNow();
    expect(controller.state).toBe("HOLD");
    expect(controller.lastRejectionCode).toBe(
      "PRODUCTION_ACTIVATION_PROVENANCE_INVALID",
    );
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("runs backup, migration and the authoritative credential parser over one exact chain", async () => {
    const files = await fixture();
    const bundle = signedFixtureBundle(files);
    const backup = bundle.activation.evidence.exact0096Backup;
    const migration = bundle.activation.evidence.migration0096To0107;
    const backupPlanCanonical = canonicalProductionActivationJson(
      backup.plan.payload,
    );
    const backupTraceCanonical = canonicalProductionActivationJson(
      backup.trace.payload,
    );
    const backupReceiptCanonical = canonicalProductionActivationJson(
      backup.passReceipt.payload,
    );
    const backupSignatureCanonical = canonicalProductionActivationJson(
      backup.signature.payload,
    );
    const calls: string[] = [];
    const adapters: ProductionActivationContractAdapters = {
      verifyApiImageProvenance: (input) => {
        calls.push("api-image-provenance");
        return verifyProductionApiImageProvenanceArtifactWithTestAuthority(
          input,
          {
            trustedImageProvenanceKeys: {
              [files.publisherPublicKeySha256]: files.publisherPublicKeyPem,
            },
          },
        );
      },
      parseBackupPlan: (canonical) => {
        calls.push("backup-plan");
        return {
          canonical,
          sha256: `sha256:${"1".repeat(64)}`,
          value: {
            liveSource: {
              sha: SOURCE_SHA,
              imageRef: LIVE_SOURCE_IMAGE,
            },
          },
        };
      },
      parseBackupTrace: (canonical) => {
        calls.push("backup-trace");
        return {
          canonical,
          sha256: `sha256:${"2".repeat(64)}`,
          value: {},
        };
      },
      parseBackupReceipt: (canonical) => {
        calls.push("backup-receipt");
        return {
          canonical,
          sha256: `sha256:${"3".repeat(64)}`,
          value: {},
        };
      },
      verifyBackupSignature: () => {
        calls.push("backup-signature");
        return {
          canonical: backupSignatureCanonical,
          sha256: `sha256:${"4".repeat(64)}`,
          value: {},
          publicKeySha256: `sha256:${"5".repeat(64)}`,
        };
      },
      parseMigrationArtifact: (canonical, field) => ({
        canonical,
        sha256: field.endsWith(".plan")
          ? MIGRATION_PLAN_SHA256
          : field.endsWith(".role")
            ? ROLE_RECEIPT_SHA256
            : ROLE_POSTCOMMIT_SHA256,
        value: {},
      }),
      validateMigrationPlan: () => ({
        backupPlanCanonical,
        backupExecutorTraceCanonical: backupTraceCanonical,
        backupReceiptCanonical,
        backupSignatureEnvelopeCanonical: backupSignatureCanonical,
        backupDetachedSignatureB64:
          backup.detachedSignature.payload.signatureBase64,
        database: { name: "site_logbook" },
      }),
      verifyMigrationTransition: (input) => {
        calls.push(`migration-${input.receiptCanonicals.length}`);
        return {
          canonical: canonicalProductionActivationJson(
            migration.transitionPass.payload,
          ),
          sha256: MIGRATION_TRANSITION_SHA256,
          value: {
            decision: "PASS",
            sourceSha: SOURCE_SHA,
            planSha256: MIGRATION_PLAN_SHA256,
            rolePreconditionSha256: ROLE_PRECONDITION_SHA256,
            roleTransactionReceiptSha256: ROLE_RECEIPT_SHA256,
            postCommitRoleArtifactSha256: ROLE_POSTCOMMIT_SHA256,
            finalLiveIdentitySha256: FINAL_LIVE_SHA256,
            backupIntegritySha256: `sha256:${"b".repeat(64)}`,
            completedAt: "2026-08-18T11:57:00.000Z",
            authorizesApplicationStart: false,
            final: {
              knownAppliedMigrations: 107,
              knownAppliedRowsSha256: `sha256:${"1".repeat(64)}`,
              latestKnownAppliedTag: "0107_canonical_audit_evidence",
              opaqueLegacyRowCount: 2,
              opaqueLegacyRowsSha256: `sha256:${"2".repeat(64)}`,
              excludedMigration0100Present: false,
            },
          },
        };
      },
      credentialReceiptParser: {
        parseAndVerify(input) {
          calls.push("credential-receipt");
          return PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER.parseAndVerify(
            input,
          );
        },
      },
      verifyFinalObservations(input) {
        calls.push("final-observations");
        return {
          sourceSha: String(input.request.sourceSha),
          apiImage: String(input.request.expectedApiImage),
          databaseName: String(input.request.databaseName),
          databaseUser: String(input.request.databaseUser),
          schemaFingerprintSha256: String(
            input.request.schemaFingerprintSha256,
          ),
          capturedAt: "2026-08-18T11:59:00.000Z",
          coolifyObservedAt: "2026-08-18T11:58:40.000Z",
          dockerObservedAt: "2026-08-18T11:58:50.000Z",
          postgresObservedAt: "2026-08-18T11:59:00.000Z",
          desiredConfigSha256: `sha256:${DESIRED}`,
          deployedConfigSha256: `sha256:${DEPLOYED}`,
          resolvedComposeSha256: `sha256:${RESOLVED}`,
          apiContainerId: CONTAINER,
          apiContainerImage: IMAGE,
          apiContainerImageId: `sha256:${"1".repeat(64)}`,
          postgresContainerId: "c".repeat(64),
          postgresImage: `postgres@sha256:${"2".repeat(64)}`,
          dockerExportSha256: `sha256:${"3".repeat(64)}`,
          backendProofSha256: `sha256:${"4".repeat(64)}`,
          coolifySha256: `sha256:${digest(input.coolifyCanonical)}`,
          dockerSha256: `sha256:${digest(input.dockerCanonical)}`,
          postgresSha256: `sha256:${digest(input.postgresCanonical)}`,
        };
      },
    };
    const verifyWithAdapters = createProductionActivationContractTestVerifier(
      PRODUCTION_ACTIVATION_CONTRACT_TEST_CONFIRMATION,
    );

    const release = await verifyWithAdapters(
      bundle as unknown as ProductionActivationBundleV2,
      adapters,
    );
    expect(release).toMatchObject({
      sourceSha: EXECUTOR_SHA,
      publicationReceiptSha256: PUBLICATION_RECEIPT_SHA256,
      reviewedImageSetSha256: REVIEWED_IMAGE_SET_SHA256,
      apiRunnableManifestDigest: API_RUNNABLE_MANIFEST_DIGEST,
      apiOciProvenanceSha256: API_OCI_PROVENANCE_SHA256,
      databaseName: "site_logbook",
      databaseUser: "site_logbook_runtime",
      transitionChainSha256: MIGRATION_TRANSITION_SHA256,
      lineage: {
        knownAppliedMigrations: 107,
        opaqueLegacyRowCount: 2,
        excludedMigration0100Present: false,
      },
    });
    expect(
      productionRuntimeBindingMatches(
        createProductionRuntimeBinding(release),
        EXECUTOR_SHA,
        "0107_canonical_audit_evidence",
        {
          knownExpectedMigrations: 107,
          knownAppliedMigrations: 107,
          knownAppliedRowsSha256: `sha256:${"1".repeat(64)}`,
          opaqueAppliedMigrations: 2,
          opaqueLegacyRowsSha256: `sha256:${"2".repeat(64)}`,
          missingKnownMigrationTags: [],
        },
      ),
    ).toBe(true);
    expect(calls).toEqual([
      "api-image-provenance",
      "backup-plan",
      "backup-trace",
      "backup-receipt",
      "backup-signature",
      "migration-10",
      "credential-receipt",
      "final-observations",
    ]);

    const shortContainerBundle = signedFixtureBundle(
      files,
      expected({ containerId: CONTAINER.slice(0, 12) }),
    );
    await expect(
      verifyWithAdapters(
        shortContainerBundle as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).resolves.toMatchObject({ sourceSha: EXECUTOR_SHA });

    await expect(
      verifyWithAdapters(bundle as unknown as ProductionActivationBundleV2, {
        ...adapters,
        verifyApiImageProvenance: undefined,
      }),
    ).rejects.toThrow(/PROVENANCE_PARSER_MISSING/);

    const provenanceOf = (candidate: typeof bundle) =>
      (candidate.activation.evidence as unknown as Record<string, unknown>)
        .apiImageProvenance as Record<string, unknown>;
    const provenanceMutations: Array<(candidate: typeof bundle) => void> = [
      (candidate) => {
        delete (
          candidate.activation.evidence as unknown as Record<string, unknown>
        ).apiImageProvenance;
      },
      (candidate) => {
        const provenance = provenanceOf(candidate);
        const value = JSON.parse(String(provenance.canonical)) as Record<
          string,
          unknown
        >;
        value.reviewedImageSetSha256 = `sha256:${"e".repeat(64)}`;
        provenance.canonical = canonicalProductionActivationJson(value);
      },
      (candidate) => {
        provenanceOf(candidate).signatureB64 = Buffer.alloc(64, 13).toString(
          "base64",
        );
      },
      (candidate) => {
        (
          candidate.activation.evidence as unknown as Record<string, unknown>
        ).apiImageProvenance = imageProvenance(
          files.publisherPrivateKey,
          files.publisherPublicKeySha256,
          "f".repeat(40),
        );
      },
    ];
    for (const mutate of provenanceMutations) {
      const candidate = structuredClone(bundle);
      mutate(candidate);
      await expect(
        verifyWithAdapters(
          candidate as unknown as ProductionActivationBundleV2,
          adapters,
        ),
      ).rejects.toThrow(/PROVENANCE|SEMANTIC_INVALID/);
    }

    await expect(
      verifyWithAdapters(bundle as unknown as ProductionActivationBundleV2, {
        ...adapters,
        credentialReceiptParser: undefined,
      }),
    ).rejects.toThrow(/CREDENTIAL_RECEIPT_PARSER_MISSING/);
    await expect(
      verifyWithAdapters(bundle as unknown as ProductionActivationBundleV2, {
        ...adapters,
        verifyFinalObservations: undefined,
      }),
    ).rejects.toThrow(/OBSERVATION_PARSER_MISSING/);

    const payloadOf = (
      candidate: typeof bundle,
      key: "activationApproval" | "finalObservations",
    ): Record<string, unknown> => {
      const candidateEvidence = candidate.activation.evidence as Record<
        string,
        unknown
      >;
      return candidateEvidence[key] as Record<string, unknown>;
    };
    const denied = structuredClone(bundle);
    (
      payloadOf(denied, "activationApproval").payload as Record<string, unknown>
    ).decision = "DENY";
    await expect(
      verifyWithAdapters(
        denied as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_APPROVAL_DENIED/);

    const missingApprovalField = structuredClone(bundle);
    delete (
      payloadOf(missingApprovalField, "activationApproval").payload as Record<
        string,
        unknown
      >
    ).operator;
    await expect(
      verifyWithAdapters(
        missingApprovalField as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_SEMANTIC_INVALID/);

    const swappedApproval = structuredClone(bundle);
    (
      payloadOf(swappedApproval, "activationApproval").payload as Record<
        string,
        unknown
      >
    ).nonce = "c".repeat(64);
    await expect(
      verifyWithAdapters(
        swappedApproval as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_CROSS_BINDING_INVALID/);

    const staleApproval = structuredClone(bundle);
    (
      payloadOf(staleApproval, "activationApproval").payload as Record<
        string,
        unknown
      >
    ).approvedAt = "2026-08-18T11:58:45.000Z";
    await expect(
      verifyWithAdapters(
        staleApproval as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_CHRONOLOGY_INVALID/);

    for (const observationKey of ["coolify", "docker", "postgres"] as const) {
      const swappedObservation = structuredClone(bundle);
      const swappedFinalObservations = payloadOf(
        swappedObservation,
        "finalObservations",
      );
      const swappedArtifact = swappedFinalObservations[
        observationKey
      ] as Record<string, unknown>;
      (swappedArtifact.payload as Record<string, unknown>).result = "SWAPPED";
      await expect(
        verifyWithAdapters(
          swappedObservation as unknown as ProductionActivationBundleV2,
          adapters,
        ),
      ).rejects.toThrow(/PRODUCTION_ACTIVATION_CROSS_BINDING_INVALID/);
    }

    const productionVerifierWithAdapter =
      verifyProductionActivationContractV2 as unknown as (
        candidate: ProductionActivationBundleV2,
        injected: ProductionActivationContractAdapters,
      ) => Promise<void>;
    await expect(
      productionVerifierWithAdapter(
        bundle as unknown as ProductionActivationBundleV2,
        adapters,
      ),
    ).rejects.toThrow(/PRODUCTION_ACTIVATION_VERIFIER_INPUT_INVALID/);
  });
});

describe("production activation deployment contract", () => {
  it("keeps application and DB modules outside the eager HOLD module graph", async () => {
    const apiRoot = process.cwd();
    const entrypoint = await readFile(
      path.join(apiRoot, "src/production-api-entrypoint.ts"),
      "utf8",
    );
    const hold = await readFile(
      path.join(apiRoot, "src/lib/production-activation-hold.ts"),
      "utf8",
    );
    const contract = await readFile(
      path.join(apiRoot, "src/lib/production-activation-contract.ts"),
      "utf8",
    );
    expect(entrypoint).not.toMatch(/from ["']\.\/app["']/);
    expect(entrypoint).not.toMatch(/from ["']\.\/index["']/);
    expect(entrypoint).toContain('new URL("./index.mjs", import.meta.url)');
    expect(entrypoint).toContain("startProductionApplicationRuntime(release)");
    expect(entrypoint).not.toContain("installProductionRuntimeBinding");
    expect(entrypoint).toContain("process.exit(1)");
    expect(entrypoint).toContain(
      "PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256",
    );
    expect(entrypoint).toContain("PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256");
    expect(entrypoint).toContain("requiredExactSourceTrustPin");
    expect(hold).not.toContain("@workspace/db");
    expect(hold).not.toContain("S3Client");
    expect(hold).not.toContain("production-startup-evidence");
    for (const directVerifier of [
      "parseProductionExact0096BackupPlan",
      "parseProductionExact0096BackupExecutorTrace",
      "parseProductionExact0096BackupReceipt",
      "verifyDetachedProductionExact0096BackupSignature",
      "verifyProductionMigrationTransitionChain",
    ]) {
      expect(contract).toContain(directVerifier);
    }
    expect(contract).toContain(
      "PRODUCTION_ACTIVATION_CREDENTIAL_RECEIPT_PARSER_MISSING",
    );
    expect(contract).toContain(
      "credentialReceiptParser: PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER",
    );
    expect(contract).toContain(
      "verifyFinalObservations: verifyProductionObservationExports",
    );
    expect(contract).toContain(
      "return verifyProductionActivationContractV2Core(bundle, DIRECT_ADAPTERS)",
    );
    expect(contract).toContain("if (arguments.length !== 1)");
    expect(contract).not.toMatch(
      /verifyProductionActivationContractV2\([\s\S]{0,160}adapters:/,
    );
    expect(contract).not.toContain("credentialReceiptParser: undefined");
    expect(contract).not.toContain("@workspace/db");
  });

  it("uses a fixed read-only host directory and removes evidence B64 env transport", async () => {
    const repositoryRoot = path.resolve(process.cwd(), "../..");
    const compose = await readFile(
      path.join(repositoryRoot, "docker-compose.yml"),
      "utf8",
    );
    const dockerfile = await readFile(
      path.join(process.cwd(), "Dockerfile"),
      "utf8",
    );
    expect(compose).not.toMatch(/PRODUCTION_[A-Z0-9_]*EVIDENCE_B64/);
    expect(compose).not.toContain("PRODUCTION_HOST_ATTESTATION_B64");
    expect(compose).not.toContain("PRODUCTION_HOST_EVIDENCE_DIR");
    expect(compose).toContain(
      "source: /var/lib/modvolt/site-logbook-production-evidence",
    );
    expect(compose).toContain("/run/site-logbook-production-evidence");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("create_host_path: false");
    expect(dockerfile).toContain("/app/dist/production-api-entrypoint.mjs");
    expect(dockerfile).toContain(PRODUCTION_ACTIVATION_HEALTH_PATH);
  });
});
