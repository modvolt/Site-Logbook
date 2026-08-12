import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  StagingRuntimeContractError,
  classifyStagingPublicationState,
  validateStagingRuntimeContract,
} from "../check-staging-runtime-contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function source(relativePath) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
    .replaceAll("\r\n", "\n");
}

function assertWorkflowContractError(workflow, expectedCode) {
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".github/workflows/staging-images.yml": workflow,
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === expectedCode,
  );
}

test("accepts the immutable pull-only staging runtime", () => {
  const summary = validateStagingRuntimeContract();
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.runtimeBuildDefinitions, 0);
  assert.equal(summary.totalCpuLimit, 3);
  assert.equal(summary.totalMemoryLimitMiB, 3200);
  assert.equal(summary.immutableCustomImages, 5);
  assert.equal(summary.publicationMode, "private-caller-ghcr-no-deploy");
  assert.equal(
    summary.predecessorPublicationMode,
    "fixed-exact-0104-api-private-caller-no-deploy",
  );
  assert.equal(
    summary.predecessorBaselineMode,
    "candidate-precheck-fixed-migrator-candidate-postcheck-no-0105",
  );
  assert.equal(
    summary.exact0104RecoveryMode,
    "new-encrypted-backup-restore-evidence-read-only-no-0105",
  );
  assert.equal(
    summary.exact0104BackupMode,
    "one-shot-create-restore-test-no-prune-no-api-no-0105",
  );
  assert.equal(
    summary.exact0105BackupMode,
    "one-shot-create-restore-test-no-prune-no-api-no-0106",
  );
  assert.equal(
    summary.accounting0106TransitionMode,
    "ready-0105-intent-live-postgres-bound-apply-or-reviewed-noop-no-app-start",
  );
  assert.equal(
    summary.schemaTransitionEvidenceMode,
    "ready-0104-intent-single-snapshot-atomic-finalization",
  );
});

test("normalizes Windows line endings before exact contract checks", () => {
  const workflow = source(".github/workflows/staging-images.yml").replaceAll(
    "\n",
    "\r\n",
  );
  assert.equal(
    validateStagingRuntimeContract({
      ".github/workflows/staging-images.yml": workflow,
    }).decision,
    "PASS",
  );
});

test("requires the isolated exact-0104 backup and durable transition evidence planes", () => {
  const compose = source("docker-compose.staging.yml");
  for (const mutated of [
    compose.replace(
      '    profiles: ["exact-0104-backup"]',
      '    profiles: ["default"]',
    ),
    compose.replace(
      "      - /tmp:size=536870912,mode=1777",
      "      - /tmp:size=1048576,mode=1777",
    ),
    compose.replace(
      '      BACKUP_ENABLED: "true"',
      '      BACKUP_ENABLED: "false"',
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "docker-compose.staging.yml": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const objectStorage = source("artifacts/api-server/src/lib/objectStorage.ts");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/src/lib/objectStorage.ts": objectStorage.replace(
          "totalBytes > options.maxBytes",
          "totalBytes < options.maxBytes",
        ),
      }),
    StagingRuntimeContractError,
  );

  const backupEntrypoint = source(
    "artifacts/api-server/src/external-schema-exact-0104-backup.ts",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/src/external-schema-exact-0104-backup.ts":
          backupEntrypoint.replace(
            "skipRetentionPrune: true",
            "skipRetentionPrune: false",
          ),
      }),
    StagingRuntimeContractError,
  );

  for (const mutated of [
    backupEntrypoint.replace(
      "STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
      "STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024",
    ),
    backupEntrypoint.replace(
      "maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES",
      "maxPayloadBytes: undefined",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/src/external-schema-exact-0104-backup.ts":
            mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const evidenceValidator = source(
    "scripts/check-staging-release-evidence.mjs",
  );
  for (const mutated of [
    evidenceValidator.replaceAll(
      "productionCopyPresentInsideApprovedBoundary",
      "rawProductionDataExposed",
    ),
    evidenceValidator.replaceAll(
      "rawProductionDataOutsideApprovedBoundary",
      "rawProductionDataExposed",
    ),
    evidenceValidator.replaceAll(
      "canonicalJsonArtifact",
      "permissiveJsonArtifact",
    ),
    evidenceValidator.replaceAll(
      "releaseEvidenceFileSha256",
      "unboundReleaseEvidenceFileDigest",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/check-staging-release-evidence.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const gateEntrypoint = source(
    "artifacts/api-server/src/external-schema-gate.ts",
  );
  for (const mutated of [
    gateEntrypoint.replace(
      'migration.newlyApplied === 1 ? "APPLIED" : "NOOP"',
      'migration.newlyApplied >= 0 ? "APPLIED" : "NOOP"',
    ),
    gateEntrypoint.replace(
      "MIGRATION_APPLY_COUNT_INVALID",
      "MIGRATION_APPLY_COUNT_IGNORED",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/src/external-schema-gate.ts": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const deploymentBinding = source(
    "scripts/check-staging-deployment-binding.mjs",
  );
  for (const mutated of [
    deploymentBinding.replace(
      'value.environmentId !== "site-logbook-staging"',
      'value.environmentId !== "staging-environment"',
    ),
    deploymentBinding.replaceAll(
      "validateResolvedStagingComposeTarget",
      "trustUnresolvedComposeTarget",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/check-staging-deployment-binding.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const backupRunner = source("scripts/run-staging-exact-0104-backup.mjs");
  for (const mutated of [
    backupRunner.replace(
      'targetService: "exact-0104-backup"',
      'targetService: "external-schema-gate"',
    ),
    backupRunner.replace(
      '"config", "--format", "json"',
      '"config", "--format", "yaml"',
    ),
    backupRunner.replace(
      "value.maxPayloadBytes !== MAX_PAYLOAD_BYTES",
      "value.maxPayloadBytes > MAX_PAYLOAD_BYTES",
    ),
    backupRunner.replace('"final quiescence check"', '"unverified completion"'),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/run-staging-exact-0104-backup.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const exact0105Backup = source(
    "artifacts/api-server/src/accounting-schema-exact-0105-backup.ts",
  );
  for (const mutated of [
    exact0105Backup.replace(
      "skipRetentionPrune: true",
      "skipRetentionPrune: false",
    ),
    exact0105Backup.replace(
      "STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
      "STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024",
    ),
    exact0105Backup.replace(
      'inventory.decision !== "READY_0105"',
      'inventory.decision !== "ALREADY_0106"',
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/src/accounting-schema-exact-0105-backup.ts":
            mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const exact0105Runner = source("scripts/run-staging-exact-0105-backup.mjs");
  for (const mutated of [
    exact0105Runner.replace(
      'targetService: "exact-0105-accounting-backup"',
      'targetService: "external-schema-gate"',
    ),
    exact0105Runner.replace(
      '"config", "--format", "json"',
      '"config", "--format", "yaml"',
    ),
    exact0105Runner.replace(
      '"final quiescence check"',
      '"unverified completion"',
    ),
    exact0105Runner.replace(
      "accountingSchema0106GateStarted: false",
      "accountingSchema0106GateStarted: true",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/run-staging-exact-0105-backup.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const transitionRunner = source("scripts/run-staging-schema-transition.mjs");
  for (const mutated of [
    transitionRunner.replace(
      'value.decision !== "READY_0104"',
      'value.decision !== "ALREADY_0105"',
    ),
    transitionRunner.replace(
      "SCHEMA_TRANSITION_UNEXPECTED_NOOP",
      "SCHEMA_TRANSITION_ACCEPT_ANY_NOOP",
    ),
    transitionRunner.replaceAll("writeFinalBundle", "writeFilesSeparately"),
    transitionRunner.replace(
      '"post-inventory quiescence check"',
      '"unchecked inventory completion"',
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/run-staging-schema-transition.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }

  const accountingTransitionRunner = source(
    "scripts/run-staging-accounting-0106-transition.mjs",
  );
  for (const mutated of [
    accountingTransitionRunner.replace(
      'targetService: "accounting-schema-gate"',
      'targetService: "external-schema-gate"',
    ),
    accountingTransitionRunner.replace(
      "ACCOUNTING_0106_UNEXPECTED_NOOP",
      "ACCOUNTING_0106_ACCEPT_ANY_NOOP",
    ),
    accountingTransitionRunner.replace(
      '"post-inventory quiescence check"',
      '"unchecked inventory completion"',
    ),
    accountingTransitionRunner.replace(
      "authorizesApplicationStart: false",
      "authorizesApplicationStart: true",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/run-staging-accounting-0106-transition.mjs": mutated,
        }),
      StagingRuntimeContractError,
    );
  }
});

test("requires the manual exact-0104 baseline control plane", () => {
  const compose = source("docker-compose.staging.yml");
  for (const [needle, replacement, expectedCode] of [
    [
      '    profiles: ["baseline-0104"]',
      '    profiles: ["default"]',
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      '        [ "$$BUILD_SHA" = "$$STAGING_PREDECESSOR_0104_SOURCE_SHA" ]',
      "        true",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "      - dist/external-schema-baseline-0104.mjs",
      "      - dist/migrate.mjs",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      '  baseline-0104-preflight:\n    profiles: ["baseline-0104"]',
      '  baseline-0104-preflight:\n    ports:\n      - "5000:5000"\n    profiles: ["baseline-0104"]',
      "STAGING_NETWORK_BOUNDARY_DRIFT",
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "docker-compose.staging.yml": compose.replace(needle, replacement),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }

  const apiBuild = source("artifacts/api-server/build.mjs");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/build.mjs": apiBuild.replace(
          '      path.resolve(artifactDir, "src/external-schema-baseline-0104.ts"),\n',
          "",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  const gate = source(
    "artifacts/api-server/src/external-schema-baseline-0104.ts",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/src/external-schema-baseline-0104.ts":
          gate.replace("authorizes0105: false", "authorizes0105: true"),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  const binding = source("scripts/check-staging-baseline-0104-binding.mjs");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "scripts/check-staging-baseline-0104-binding.mjs": binding.replace(
          'nextGate: "fresh-exact-0104-backup-and-restore-required"',
          'nextGate: "apply-0105"',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  const runner = source("scripts/run-staging-baseline-0104.mjs");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "scripts/run-staging-baseline-0104.mjs": runner.replace(
          'services.length !== 1 || services[0] !== "postgres"',
          "services.length < 10",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("requires the read-only exact-0104 recovery evidence plane", () => {
  const compose = source("docker-compose.staging.yml");
  for (const [needle, replacement, expectedCode] of [
    [
      '    profiles: ["exact-0104-recovery"]',
      '    profiles: ["default"]',
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "      - dist/external-schema-exact-0104-recovery.mjs",
      "      - dist/index.mjs",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      '  exact-0104-recovery-gate:\n    profiles: ["exact-0104-recovery"]',
      '  exact-0104-recovery-gate:\n    ports:\n      - "5000:5000"\n    profiles: ["exact-0104-recovery"]',
      "STAGING_NETWORK_BOUNDARY_DRIFT",
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "docker-compose.staging.yml": compose.replace(needle, replacement),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }

  const binding = source(
    "scripts/check-staging-exact-0104-recovery-binding.mjs",
  );
  for (const mutated of [
    binding.replace(
      'nextGate: "separate-0105-transition-binding-required"',
      'nextGate: "apply-0105"',
    ),
    binding.replaceAll(
      "RECOVERY_BINDING_SECRET_MATERIAL",
      "RECOVERY_BINDING_ACCEPT_SECRET_MATERIAL",
    ),
    binding.replace('"--backup-execution"', '"--backup-id"'),
    binding.replace(
      "maxPayloadBytes: exactBackup.maxPayloadBytes",
      "maxPayloadBytes: Number.MAX_SAFE_INTEGER",
    ),
    binding.replace(
      "backupEvidenceId: exactBackup.backupId",
      "backupEvidenceId: baseline.oldBackupId",
    ),
    binding.replace(
      "STAGING_DEPLOYMENT_INPUTS_SHA256: recoveryInspectSha256",
      "STAGING_DEPLOYMENT_INPUTS_SHA256: baseline.candidate.inspectInputsSha256",
    ),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/check-staging-exact-0104-recovery-binding.mjs": mutated,
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }

  const runner = source("scripts/run-staging-exact-0104-recovery.mjs");
  for (const mutated of [
    runner.replace(
      'services.length !== 1 || services[0] !== "postgres"',
      "services.length < 10",
    ),
    runner.replace(
      "RECOVERY_EVIDENCE_SCHEMA_INVALID",
      "RECOVERY_EVIDENCE_SCHEMA_PERMISSIVE",
    ),
    runner.replace(
      "backup.sizeBytes > backup.maxPayloadBytes",
      "backup.sizeBytes < 0",
    ),
    runner.replace(
      'targetService: "exact-0104-recovery-gate"',
      'targetService: "external-schema-gate"',
    ),
    runner.replace(
      '"config", "--format", "json"',
      '"config", "--format", "yaml"',
    ),
    runner.replace(
      "staging-exact-0104-recovery-inspect.json",
      "staging-deployment-inspect.json",
    ),
    runner.replaceAll(
      "validateRunningStagingPostgresContainer",
      "trustRunningPostgresContainer",
    ),
    runner.replace(
      '"dist/external-schema-exact-0104-recovery.mjs"',
      '"dist/index.mjs"',
    ),
    runner.replace(
      "value.buildSha !== expectedSourceSha",
      "!SHA40.test(value.buildSha)",
    ),
    runner.replace('"final quiescence check"', '"unchecked completion"'),
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "scripts/run-staging-exact-0104-recovery.mjs": mutated,
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }

  const environmentContract = source(
    "lib/db/src/staging-exact-0104-recovery.ts",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "lib/db/src/staging-exact-0104-recovery.ts":
          environmentContract.replaceAll(
            "RECOVERY_SECRET_MATERIAL",
            "RECOVERY_ACCEPT_SECRET_MATERIAL",
          ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("rejects a Coolify host build or resource-limit drift", () => {
  const compose = source("docker-compose.staging.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          / {2}staging-preflight:\r?\n/,
          "  staging-preflight:\n    build: .\n",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_HOST_BUILD_FORBIDDEN",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          '    cpus: "1.00"',
          '    cpus: "1.50"',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RESOURCE_LIMIT_DRIFT",
  );
});

test("requires external accounts to stay explicitly disabled before staging starts", () => {
  const compose = source("docker-compose.staging.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          "      STAGING_EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
          "",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  const exampleEnv = source(".env.staging.example");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".env.staging.example": exampleEnv.replace(
          "STAGING_EXTERNAL_ACCOUNTS_ENABLED=false",
          "STAGING_EXTERNAL_ACCOUNTS_ENABLED=true",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_EXTERNAL_ACCOUNTS_DARK_ROLLOUT_BROKEN",
  );

  const preflight = source("deploy/staging/preflight/preflight.sh");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "deploy/staging/preflight/preflight.sh": preflight.replace(
          '[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "false" ]',
          '[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "true" ]',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "deploy/staging/preflight/preflight.sh": preflight.replace(
          "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING",
          "ALLOW_ANY_SCHEMA_CHANGE",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("separates inventory, transition and steady-state restart gates", () => {
  const compose = source("docker-compose.staging.yml");
  for (const [needle, replacement, expectedCode] of [
    [
      "      - dist/external-schema-gate.mjs",
      "      - dist/migrate.mjs",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "        node dist/external-schema-steady-state.mjs &&",
      "        true &&",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?set inspect, apply-0105 or steady-0105}",
      "",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      '      PORT: "5000"',
      '      PORT: "5000"\n      BUILD_SHA: ${STAGING_BUILD_SHA}',
      "STAGING_API_BUILD_SHA_OVERRIDE_FORBIDDEN",
    ],
    [
      '      PORT: "5000"',
      '      PORT: "5000"\n      STAGING_BACKUP_EVIDENCE_ID: stale-transition-id',
      "STAGING_API_TRANSITION_EVIDENCE_COUPLED",
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "docker-compose.staging.yml": compose.replace(needle, replacement),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }

  const apiBuild = source("artifacts/api-server/build.mjs");
  for (const entrypoint of [
    "external-schema-preflight.ts",
    "external-schema-inventory.ts",
    "external-schema-steady-state.ts",
    "external-schema-gate.ts",
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/build.mjs": apiBuild.replace(
            `      path.resolve(artifactDir, "src/${entrypoint}"),\n`,
            "",
          ),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }

  const gateRunner = source("artifacts/api-server/src/external-schema-gate.ts");
  for (const mutated of [
    gateRunner.replace(
      'if (action === "steady-0105")',
      'if (action === "apply-0105")',
    ),
    gateRunner.replace(
      "dependencies.migrate ?? runMigrations",
      "dependencies.migrate ?? runLegacyMigrator",
    ),
    gateRunner.replace(
      'migration.newlyApplied === 1 ? "APPLIED" : "NOOP"',
      'migration.newlyApplied === 1 ? "APPLIED" : "APPLIED"',
    ),
    gateRunner.replace(
      "[external-schema-gate] ${result.mode} ${JSON.stringify(result.evidence)}",
      "[external-schema-gate] APPLIED ${JSON.stringify(result.evidence)}",
    ),
    `${gateRunner}\nimport { spawn } from "node:child_process";\n`,
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/src/external-schema-gate.ts": mutated,
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }
});

test("keeps the external schema preflight in the exact-SHA Quality gate", () => {
  const workflow = source(".github/workflows/quality-gate.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".github/workflows/quality-gate.yml": workflow.replace(
          "pnpm --filter @workspace/db test:external-schema-preflight",
          "true",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("requires exact reviewed Action SHAs in Quality gate and staging smoke", () => {
  const qualityWorkflow = source(".github/workflows/quality-gate.yml");
  const smokeWorkflow = source(".github/workflows/staging-smoke.yml");
  for (const [relativePath, workflow, mutated] of [
    [
      ".github/workflows/quality-gate.yml",
      qualityWorkflow,
      qualityWorkflow.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
    ],
    [
      ".github/workflows/quality-gate.yml",
      qualityWorkflow,
      qualityWorkflow.replace(
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "actions/setup-node@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ],
    [
      ".github/workflows/staging-smoke.yml",
      smokeWorkflow,
      smokeWorkflow.replace(
        "      - run: pnpm install --frozen-lockfile",
        "      - uses: example/unknown-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: pnpm install --frozen-lockfile",
      ),
    ],
    [
      ".github/workflows/staging-smoke.yml",
      smokeWorkflow,
      smokeWorkflow.replace(
        /\n {6}- name: Upload secret-free operational alert drill evidence[\s\S]*? {10}retention-days: 14\n/,
        "\n",
      ),
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          [relativePath]: mutated,
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_WORKFLOW_ACTION_DRIFT",
    );
  }
});

test("keeps predecessor publication fixed to one exact-0104 API image", () => {
  const relativePath = ".github/workflows/staging-predecessor-image.yml";
  const workflow = source(relativePath);
  for (const [mutated, expectedCode] of [
    [
      workflow.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
      "STAGING_WORKFLOW_ACTION_DRIFT",
    ],
    [
      workflow.replaceAll(
        "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(
        "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(
        "site-logbook-staging-api",
        "site-logbook-staging-predecessor-api",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll("/user/packages", "/users/modvolt/packages"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("/user/packages", "/users/attacker/packages"),
      "STAGING_PREDECESSOR_PACKAGE_API_NAMESPACE_DRIFT",
    ],
    [
      workflow.replace(
        "packages_metadata_token:",
        "packages_metadata_write_token:",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "      verify_existing_only:",
        "      verify_existing_mode:",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "if: inputs.verify_existing_only == false && steps.package-state.outputs.publish == 'true'",
        "if: steps.package-state.outputs.publish == 'true'",
      ),
      "STAGING_PREDECESSOR_VERIFY_ONLY_DRIFT",
    ],
    [
      workflow.replace(
        'VERIFICATION_ATTEMPTS: "36"',
        'VERIFICATION_ATTEMPTS: "12"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        'VERIFICATION_POLL_SECONDS: "5"',
        'VERIFICATION_POLL_SECONDS: "0"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("PROVENANCE_NOT_READY", "REMOTE_EVIDENCE_NOT_READY"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "verify-existing-only requires an already-present exact predecessor tag and forbids publication.",
        "verification requested",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: true",
        "packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: false",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "GH_TOKEN: ${{ secrets.packages_metadata_token }}",
        "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      ),
      "STAGING_PREDECESSOR_METADATA_CREDENTIAL_DRIFT",
    ],
    [
      workflow.replace(
        '[[ "$GH_TOKEN" != "$REGISTRY_GITHUB_TOKEN" ]]',
        '[[ -n "$GH_TOKEN" ]]',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '[[ "$normalized_scopes" == "read:packages" ]]',
        '[[ "$normalized_scopes" == "read:packages,repo" ]]',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(".id == 289280891", ".id > 0"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace('GH_TOKEN="$CALLER_GITHUB_TOKEN" gh api', "gh api"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "  workflow_call:",
        "  workflow_dispatch:\n  workflow_call:",
      ),
      "STAGING_PREDECESSOR_SCOPE_WIDENED",
    ],
    [
      workflow.replace("          push: false", "          push: true"),
      "STAGING_PREDECESSOR_PUBLICATION_DRIFT",
    ],
    [
      workflow.replace(
        "          provenance: mode=max,version=v0.2",
        "          provenance: false",
      ),
      "STAGING_PREDECESSOR_PUBLICATION_DRIFT",
    ],
    [
      workflow.replace(
        "          platforms: linux/amd64",
        "          platforms: linux/arm64",
      ),
      "STAGING_PREDECESSOR_PLATFORM_DRIFT",
    ],
    [
      workflow.replace("version: v0.34.1", "version: latest"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
        "moby/buildkit:buildx-stable-1",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '[[ "${#sql_files[@]}" == "104" ]]',
        '[[ "${#sql_files[@]}" == "105" ]]',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("length == 0", "length >= 0"),
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
    ],
    [
      workflow.replaceAll("versions?state=deleted", "versions?state=active"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        `if [[ "$VERIFY_EXISTING_ONLY" == "false" ]]; then
              deleted_versions_json="$(`,
        `deleted_versions_json="$(`,
      ),
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
    ],
    [
      workflow.replace("schemaVersion: 3", "schemaVersion: 2"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "execution_mode=verify-existing-only",
        "execution_mode=publication-capable",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        'deleted_inventory_mode="not-applicable-verify-existing-only"',
        'deleted_inventory_mode="queried-visible-package-versions"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(".version_count >= 0", ".version_count >= -1"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("length == $expected", "length >= 0"),
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
    ],
    [
      workflow.replace(
        "versions/${selected_version_id}",
        "versions/${EXPECTED_SOURCE_SHA}",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.args["build-arg:BUILD_SHA"] == $sha',
        "([.SLSA.invocation.parameters | .. | strings | select(. == $sha)] | length) > 0",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.configSource.entryPoint == "Dockerfile"',
        '.SLSA.invocation.configSource.entryPoint == "Containerfile"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.configSource.path == "Dockerfile"',
        '.SLSA.invocation.parameters.root.configSource.path == "Containerfile"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.request.args["vcs:localdir:context"] == "."',
        '.SLSA.invocation.parameters.root.request.args["vcs:localdir:context"] == "artifacts"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.request.args["vcs:localdir:dockerfile"] == "artifacts/api-server"',
        '.SLSA.invocation.parameters.root.request.args["vcs:localdir:dockerfile"] == "artifacts/stavba"',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.request.args["vcs:revision"] == $sha',
        '.SLSA.invocation.parameters.root.request.args["vcs:revision"] != $sha',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.request.args["vcs:source"]',
        '.SLSA.invocation.parameters.root.request.args["source"]',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.root.request.args["vcs:localdir:dockerfile"] + "/" + .SLSA.invocation.configSource.entryPoint',
        ".SLSA.invocation.configSource.entryPoint",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("($packages | length) > 0", "($packages | length) >= 0"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '$relationship.relationshipType == "CONTAINS"',
        '$relationship.relationshipType != ""',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "([ $packages[].SPDXID ]) as $packageIds",
        "($packages) as $packageIds",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("any($relationships[];", "any($relationships[]?;"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        ". as $relationship |",
        ".relationshipType as $relationship |",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }
});

test("keeps the private predecessor wrapper manual, main-only and commit-pinned", () => {
  const relativePath =
    "docs/audit/16-c3-private-predecessor-wrapper.template.yml";
  const workflow = source(relativePath);
  for (const mutated of [
    workflow.replace(
      "group: site-logbook-registry-publication",
      "group: site-logbook-images-publication",
    ),
    workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"),
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_PREDECESSOR_WRAPPER_CONCURRENCY_COLLISION",
    );
  }
  for (const mutated of [
    workflow.replace("refs/heads/main", "refs/heads/feature"),
    workflow.replace(
      "@ec1c13c11e9e42dbfc258dc353adb3db3bcc67d8",
      "@agent/phase16c3-staging-preflight",
    ),
    workflow.replace(
      "verify_existing_only: true",
      "verify_existing_only: false",
    ),
    workflow.replace(
      "VERIFY_EXISTING_FIXED_SITE_LOGBOOK_STAGING_PREDECESSOR_0104_NO_DEPLOY_NO_PUSH",
      "PUBLISH_FIXED_SITE_LOGBOOK_STAGING_PREDECESSOR_0104_NO_DEPLOY",
    ),
    workflow.replace("packages: write", "packages: read"),
    workflow.replace(
      "    secrets:\n      packages_metadata_token: ${{ secrets.SITE_LOGBOOK_GHCR_METADATA_READ_TOKEN }}\n",
      "",
    ),
    workflow.replace(
      "SITE_LOGBOOK_GHCR_METADATA_READ_TOKEN",
      "BROAD_GITHUB_CLI_TOKEN",
    ),
    workflow.replace(
      "    with:\n      confirm_predecessor_registry_publication: true",
      "    secrets: inherit\n    with:\n      confirm_predecessor_registry_publication: true",
    ),
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) => error instanceof StagingRuntimeContractError,
    );
  }
});

test("rejects mutable base images and incomplete publication", () => {
  const apiDockerfile = source("artifacts/api-server/Dockerfile");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/Dockerfile": apiDockerfile.replace(
          /node:24-slim@sha256:[0-9a-f]{64}/,
          "node:24-slim",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_BASE_IMAGE_MUTABLE",
  );

  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace("          push: true", "          push: false"),
    "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
  );
});

test("allows only prior digest-rooted local Docker stage ancestry", () => {
  const relativePath = "artifacts/api-server/Dockerfile";
  const dockerfile = source(relativePath);
  assert.doesNotThrow(() =>
    validateStagingRuntimeContract({ [relativePath]: dockerfile }),
  );
  for (const mutated of [
    dockerfile.replace(
      "FROM runtime AS production",
      "FROM unknown-runtime AS production",
    ),
    dockerfile.replace(
      "FROM runtime AS production",
      "FROM node:24-slim AS production",
    ),
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_BASE_IMAGE_MUTABLE",
    );
  }
});

test("keeps the exact-0096 producer out of production and proves it in the marked control plane", () => {
  const relativePath = "artifacts/api-server/Dockerfile";
  const dockerfile = source(relativePath);
  for (const mutated of [
    dockerfile.replace(
      "COPY --from=builder /repo/artifacts/api-server/dist/index.mjs ./dist/index.mjs",
      "COPY --from=builder /repo/artifacts/api-server/dist/scripts/production-exact-0096-backup-producer.mjs ./dist/production-exact-0096-backup-producer.mjs",
    ),
    dockerfile.replace(
      "&& test -f /app/dist/production-exact-0096-backup-producer.mjs",
      "&& test -f /app/dist/production-exact-0096-backup-producer.omitted.mjs",
    ),
    dockerfile.replace(
      "FROM runtime AS production",
      "FROM control-plane AS production",
    ),
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }
});

test("keeps the production adapter contracts in the default hermetic release gate", () => {
  const packagePath = "package.json";
  const gatePath = "scripts/run-hermetic-gate.mjs";
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        [packagePath]: source(packagePath).replace(
          '"test:production-migration-control-plane":',
          '"production-migration-control-plane-omitted":',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        [gatePath]: source(gatePath).replace(
          "production-exact-0096-backup-signature.test.mjs",
          "production-exact-0096-backup-signature.omitted.mjs",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("forbids a direct publisher in the public repository", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace("  workflow_call:", "  workflow_dispatch:"),
    "STAGING_IMAGE_PUBLIC_DIRECT_DISPATCH",
  );
});

test("isolates public validation from the package write token", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "validate-public-source:\n    permissions: {}",
      "validate-public-source:\n    permissions:\n      contents: read",
    ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace(
      "publish-staging-images:\n    needs: validate-public-source",
      "publish-staging-images:",
    ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow
      .replace(
        "      contents: read\n      packages: write",
        "      contents: read\n      packages: write\n      actions: write",
      )
      .replace(
        "permissions: {}\n\nconcurrency:",
        "permissions:\n  packages: write\n\nconcurrency:",
      ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
});

test("keeps the public source helper credential-free", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const forbidden of [
    "Authorization",
    "GH_TOKEN",
    "github.token",
    "secrets.GITHUB_TOKEN",
    "gh api",
  ]) {
    assertWorkflowContractError(
      workflow.replace(
        '            local url="$1"',
        `            local url="$1"\n            # ${forbidden}`,
      ),
      "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
    );
  }
  assertWorkflowContractError(
    workflow.replace("            curl --disable \\", "            curl \\"),
    "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
  );
});

test("requires exact source branch, PR head, and checkout coupling", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "APPROVED_SOURCE_REF: agent/phase16c3-staging-preflight",
      "APPROVED_SOURCE_REF: arbitrary-ref",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(".head.sha == $sha", ".head.sha != $sha"),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "repository: modvolt/Site-Logbook",
      "repository: untrusted/fork",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("public_source_api()", "public_repository_api()"),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "            public_source_api \\",
      "            gh api \\",
    ),
    "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
  );
});

test("requires a successful exact-SHA pull-request Quality gate", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      '.status == "completed" and .conclusion == "success"',
      '.conclusion != "failure"',
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "actions/workflows/quality-gate.yml/runs?head_sha=${SOURCE_SHA}&event=pull_request&per_page=100",
      "actions/workflows/quality-gate.yml/runs?per_page=100",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "sort_by([.run_number, .run_attempt]) |\n             last |",
      "first |",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "any(.pull_requests[]?; .number == $pr)",
      "(.pull_requests | length) >= 0",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace('            --argjson pr "$SOURCE_PR_NUMBER" \\\n', ""),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
});

test("requires a private caller and private package verification", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "          APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry\n          CALLER_GITHUB_TOKEN:",
      "          APPROVED_CALLER_REPOSITORY: modvolt/untrusted-private-repo\n          CALLER_GITHUB_TOKEN:",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(".private == true", ".private != false"),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Verify first published package is private before continuing",
      "Continue after first package without checking privacy",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Verify all published packages remain private",
      "Inspect published package metadata",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "org.opencontainers.image.source=https://github.com/modvolt/Site-Logbook",
      "org.opencontainers.image.source=https://github.com/modvolt/untrusted-source",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "org.opencontainers.image.url=https://github.com/modvolt/Site-Logbook/commit/${{ inputs.source_sha }}",
      "org.opencontainers.image.url=https://github.com/modvolt/Site-Logbook",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(
      "(.repository.full_name | ascii_downcase) == $caller",
      "(.repository.full_name | ascii_downcase) != $caller",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
});

test("binds candidate publication to the exact private manual caller workflow", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const [needle, replacement] of [
    [
      "          APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry\n          APPROVED_CALLER_WORKFLOW_REF:",
      "          APPROVED_CALLER_REPOSITORY: modvolt/untrusted-private-repo\n          APPROVED_CALLER_WORKFLOW_REF:",
    ],
    [
      "APPROVED_CALLER_WORKFLOW_REF: modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      "APPROVED_CALLER_WORKFLOW_REF: modvolt/site-logbook-registry/.github/workflows/another.yml@refs/heads/main",
    ],
    [
      '[[ "$CALLER_EVENT_NAME" == "workflow_dispatch" ]]',
      '[[ -n "$CALLER_EVENT_NAME" ]]',
    ],
    [
      '[[ "$CALLER_REF" == "refs/heads/main" ]]',
      '[[ "$CALLER_REF" == refs/heads/* ]]',
    ],
    ['[[ "${CALLER_ACTOR,,}" == "modvolt" ]]', '[[ -n "$CALLER_ACTOR" ]]'],
    [
      '[[ "${CALLER_TRIGGERING_ACTOR,,}" == "modvolt" ]]',
      '[[ -n "$CALLER_TRIGGERING_ACTOR" ]]',
    ],
    [
      '[[ "${CALLER_WORKFLOW_REF,,}" == "$APPROVED_CALLER_WORKFLOW_REF" ]]',
      '[[ "$CALLER_WORKFLOW_REF" == *publish-staging-images.yml* ]]',
    ],
  ]) {
    assertWorkflowContractError(
      workflow.replace(needle, replacement),
      "STAGING_IMAGE_CALLER_IDENTITY_GUARD_MISSING",
    );
  }
  for (const [needle, replacement] of [
    [
      "CALLER_WORKFLOW_SHA: ${{ github.workflow_sha }}",
      "CALLER_WORKFLOW_SHA: ${{ github.sha }}",
    ],
    [".object.sha == $workflowSha", ".object.sha != $workflowSha"],
  ]) {
    assertWorkflowContractError(
      workflow.replace(needle, replacement),
      "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
    );
  }
});

test("requires a canonical reviewed visible-history registry ledger before candidate publication", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const [needle, replacement] of [
    [
      "ACCEPT_EXTERNAL_LEDGER_RESIDUAL_WITHOUT_DELETED_HISTORY_PROOF_NO_DEPLOY",
      "ACCEPT_UNREVIEWED_REGISTRY_HISTORY",
    ],
    [
      '[[ "$canonical_ledger" == "$REGISTRY_LEDGER_JSON" ]]',
      '[[ -n "$canonical_ledger" ]]',
    ],
    ["historicalAbsenceProven: false", "historicalAbsenceProven: true"],
    [
      '[[ "$GITHUB_RUN_ATTEMPT_VALUE" == "1" ]]',
      '[[ "$GITHUB_RUN_ATTEMPT_VALUE" =~ ^[1-9][0-9]*$ ]]',
    ],
    ["actions/runs/${GITHUB_RUN_ID_VALUE}", "actions/runs?per_page=100"],
    [
      "actions/workflows/publish-staging-images.yml/runs?event=workflow_dispatch&per_page=100",
      "actions/workflows/publish-staging-images.yml/runs?per_page=100",
    ],
    [".[0] < 1000", ".[0] <= 1000"],
    ["registryLedger: $registryLedger[0]", "registryLedger: {}"],
    [
      'sha256sum "${RUNNER_TEMP}/staging-registry-ledger-entry.json"',
      'sha256sum "staging-images.json"',
    ],
    [
      '[[ "$state" == "$expected_initial_state" ]]',
      '[[ -n "$expected_initial_state" ]]',
    ],
    ["ledger_preflight_digest", "unbound_preflight_digest"],
  ]) {
    assertWorkflowContractError(
      workflow.replaceAll(needle, replacement),
      "STAGING_IMAGE_REGISTRY_LEDGER_GUARD_MISSING",
    );
  }

  assertWorkflowContractError(
    workflow.replace(
      "registry_history_acceptance:\n        description: Exact reviewed acceptance of the external-ledger residual limitation\n        required: true",
      "registry_history_acceptance:\n        description: Exact reviewed acceptance of the external-ledger residual limitation\n        required: false",
    ),
    "STAGING_IMAGE_REGISTRY_LEDGER_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("      actions: read\n", ""),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace(
      "            staging-images.sha256\n            staging-registry-ledger-entry.json",
      "            staging-images.sha256\n            ${{ runner.temp }}/staging-registry-ledger-entry.json",
    ),
    "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("enforces a fixed two-stage append-only package state gate", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "group: site-logbook-images-publication",
      "group: staging-images-${{ inputs.source_sha }}",
    ),
    "STAGING_IMAGE_CONCURRENCY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(
      "if: inputs.publication_stage == 'preflight-only'",
      "if: always()",
    ),
    "STAGING_IMAGE_STAGE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll("preflight-only:00000", "preflight-only:11111"),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(
      "'/user/packages?package_type=container&visibility=private&per_page=100'",
      "'/user/packages?package_type=container&per_page=100'",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("/user/packages", "/users/modvolt/packages"),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "GH_TOKEN: ${{ secrets.packages_metadata_token }}",
      "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    ),
    "STAGING_IMAGE_METADATA_CREDENTIAL_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace(
      "packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: true",
      "packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: false",
    ),
    "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '[[ "$GH_TOKEN" != "$REGISTRY_GITHUB_TOKEN" ]]',
      '[[ -n "$GH_TOKEN" ]]',
    ),
    "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '[[ "$normalized_scopes" == "read:packages" ]]',
      '[[ "$normalized_scopes" == "read:packages,repo" ]]',
    ),
    "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(".id == 289280891", ".id > 0"),
    "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace('GH_TOKEN="$CALLER_GITHUB_TOKEN" gh api', "gh api"),
    "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll("length == 1 and .[0].name == $digest", "length > 0"),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Recheck API tag absence immediately before publication",
      "Skip API tag recheck",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '"${RUNNER_TEMP}/assert-exact-tag-absent.sh" site-logbook-staging-api',
      "true # removed API tag absence check",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
});

test("classifies exact-SHA publication states fail-closed", () => {
  const allowed = new Map([
    ["preflight-only:00000", "PUBLISH_PREFLIGHT"],
    ["preflight-only:10000", "VERIFIED_PREFLIGHT_NOOP"],
    ["complete:10000", "PUBLISH_REMAINING"],
    ["complete:11111", "VERIFIED_COMPLETE_NOOP"],
  ]);
  for (const stage of ["preflight-only", "complete"]) {
    for (let value = 0; value < 32; value += 1) {
      const state = value.toString(2).padStart(5, "0");
      const key = `${stage}:${state}`;
      const result = classifyStagingPublicationState(stage, state);
      assert.equal(result.decision, allowed.get(key) ?? "STOP", key);
    }
  }
  assert.equal(
    classifyStagingPublicationState("unexpected", "00000").decision,
    "STOP",
  );
  assert.equal(
    classifyStagingPublicationState("complete", "partial").decision,
    "STOP",
  );
});

test("verifies each remote package before the next publication", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const step of [
    "Verify Mailpit package is private and digest-bound",
    "Verify API package is private and digest-bound",
    "Verify web package is private and digest-bound",
    "Verify alert receiver package is private and digest-bound",
  ]) {
    assertWorkflowContractError(
      workflow.replace(step, "Omit remote package gate"),
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    );
  }
  assertWorkflowContractError(
    workflow.replaceAll("preflight-publication.sha256", "preflight.txt"),
    "STAGING_RUNTIME_CONTRACT_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Upload API partial-publication recovery evidence",
      "Omit API recovery artifact",
    ),
    "STAGING_IMAGE_RECOVERY_EVIDENCE_ORDER_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace("          push: false", "          push: true"),
    "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
  );
});

test("requires strict digest namespace and provenance guards", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replaceAll(
      '[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
      '[[ -n "$digest" ]]',
    ),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "^ghcr\\\\.io/modvolt/site-logbook-staging-api@sha256:[0-9a-f]{64}$",
      "^ghcr\\\\.io/[^/]+/site-logbook-staging-api@sha256:.*$",
    ),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "          provenance: mode=max",
      "          provenance: false",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("          sbom: true", "          sbom: false"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("($runnable | length) == 1", "($runnable | length) >= 1"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(".schemaVersion == 2", ".schemaVersion >= 1"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "($attestations | length) == 1",
      "($attestations | length) >= 1",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.annotations["vnd.docker.reference.digest"] == $runnable[0].digest',
      "true",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.SLSA.invocation.environment.platform == "linux/amd64"',
      ".SLSA.invocation.environment.platform != null",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.SPDX.SPDXID == "SPDXRef-DOCUMENT"',
      ".SPDX.SPDXID != null",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.SPDX.dataLicense == "CC0-1.0"',
      ".SPDX.dataLicense != null",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  for (const [from, to, code] of [
    [
      "versions?state=active&per_page=100",
      "versions?per_page=100",
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    ],
    [
      "length == $expected",
      "length >= 0",
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    ],
    [
      "versions/${version_id}",
      "versions/latest",
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    ],
    [
      "--format '{{json .Image}}'",
      "--format '{{json .Manifest}}'",
      "STAGING_IMAGE_ATTESTATION_MISSING",
    ],
    [
      '.SLSA.invocation.parameters.args["build-arg:" + $argName] == $sha',
      ".SLSA.invocation.parameters.args != null",
      "STAGING_IMAGE_ATTESTATION_MISSING",
    ],
    [
      '$relationship.relationshipType == "CONTAINS"',
      "$relationship.relationshipType != null",
      "STAGING_IMAGE_ATTESTATION_MISSING",
    ],
    [
      "driver-opts: image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
      "driver-opts: image=moby/buildkit:buildx-stable-1",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
  ]) {
    assertWorkflowContractError(workflow.replace(from, to), code);
  }
});

test("binds candidate build identity into every final runtime image", () => {
  for (const [file, marker] of [
    ["deploy/staging/preflight/Dockerfile", "ENV BUILD_SHA=$BUILD_SHA"],
    ["deploy/staging/mailpit/Dockerfile", "ENV BUILD_SHA=$BUILD_SHA"],
    ["artifacts/stavba/Dockerfile", "ENV VITE_BUILD_SHA=$VITE_BUILD_SHA"],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          [file]: source(file).replace(marker, ""),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }
});

test("keeps the active staging runbook aligned with the one-shot schema-v4 gate", () => {
  const relativePath = "docs/audit/13-staging-activation-runbook.md";
  const runbook = source(relativePath);
  for (const [from, to, expectedCode] of [
    [
      "API image při běžném startu žádnou migraci automaticky nespouští.",
      "API image při startu automaticky aplikuje existující migrace.",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "--image-manifest staging-images.json",
      "--image-manifest-omitted staging-images.json",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "Schéma evidence verze 4",
      "Schéma evidence verze 3",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "recovery point není evidovaný jako `production-copy-restricted`",
      "není doložena anonymizace recovery pointu",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
      "STAGING_EXTERNAL_ACCOUNTS_UNDOCUMENTED",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "`diagnostics.view` i `users.manage`",
      "`diagnostics.view`",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "staging:create-exact-0104-backup",
      "staging:manual-backup-outside-contract",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "--expected-inputs-sha256 <64-hex> --inspect-inputs <recovery-binding-dir>\\staging-exact-0104-recovery-inspect.json",
      "--untrusted-inspect-inputs",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "gate:staging-exact-0104-recovery-binding",
      "manual-recovery-binding",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "staging:verify-exact-0104-recovery",
      "docker compose run exact-0104-recovery-gate",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    ["newlyApplied=0", "newlyApplied-any", "STAGING_RUNTIME_CONTRACT_MISSING"],
    [
      "staging:apply-0105-transition",
      "docker compose run external-schema-gate",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          [relativePath]: runbook.replace(from, to),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }
  assert.doesNotThrow(() =>
    validateStagingRuntimeContract({
      [relativePath]: runbook.replace(/\r?\n/g, "\r\n"),
    }),
  );
});

test("requires all validation and publication builds to remain linux/amd64", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "          platforms: linux/amd64",
      "          platforms: linux/arm64",
    ),
    "STAGING_IMAGE_PLATFORM_DRIFT",
  );
});

test("locks the audit host runners to private frozen Compose and observed Docker boundaries", () => {
  for (const [file, marker] of [
    ["scripts/staging-frozen-compose-runtime.mjs", "sameIds(peerIds, allowed"],
    [
      "scripts/staging-frozen-compose-runtime.mjs",
      '["start", "--attach", containerId]',
    ],
    [
      "scripts/run-staging-exact-0106-audit-backup.mjs",
      "continuousIsolationInferred: false",
    ],
    [
      "scripts/run-staging-audit-0107-transition.mjs",
      'commandOverride: ["node", "dist/audit-schema-inventory.mjs"]',
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          [file]: source(file).replace(marker, ""),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }
});
