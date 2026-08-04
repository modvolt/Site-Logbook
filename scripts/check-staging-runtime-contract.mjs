import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";

const EXPECTED_BASE_IMAGES = Object.freeze({
  "artifacts/api-server/Dockerfile": [
    "node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
  ],
  "artifacts/stavba/Dockerfile": [
    "node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
    "nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10",
  ],
  "deploy/staging/mailpit/Dockerfile": [
    "axllent/mailpit:v1.30.0@sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d",
    "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
  ],
  "deploy/staging/preflight/Dockerfile": [
    "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
  ],
});

const EXPECTED_RESOURCES = Object.freeze({
  "staging-preflight": {
    cpus: "0.25",
    memLimit: "128m",
    memReservation: "64m",
  },
  postgres: {
    cpus: "0.50",
    memLimit: "768m",
    memReservation: "512m",
  },
  mailpit: {
    cpus: "0.25",
    memLimit: "256m",
    memReservation: "128m",
  },
  api: { cpus: "1.00", memLimit: "1g", memReservation: "768m" },
  web: { cpus: "0.25", memLimit: "128m", memReservation: "64m" },
});

const REQUIRED_IMAGE_VARIABLES = Object.freeze([
  "STAGING_PREFLIGHT_IMAGE",
  "STAGING_MAILPIT_IMAGE",
  "STAGING_API_IMAGE",
  "STAGING_WEB_IMAGE",
]);

const PINNED_ACTIONS = Object.freeze([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
  "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
  "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

export class StagingRuntimeContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingRuntimeContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingRuntimeContractError(code, message);
}

export function classifyStagingPublicationState(stage, state) {
  if (!/^[01]{4}$/.test(state)) {
    return Object.freeze({ decision: "STOP", reason: "invalid-state" });
  }
  if (stage === "preflight-only" && state === "0000") {
    return Object.freeze({ decision: "PUBLISH_PREFLIGHT" });
  }
  if (stage === "preflight-only" && state === "1000") {
    return Object.freeze({ decision: "VERIFIED_PREFLIGHT_NOOP" });
  }
  if (stage === "complete" && state === "1000") {
    return Object.freeze({ decision: "PUBLISH_REMAINING" });
  }
  if (stage === "complete" && state === "1111") {
    return Object.freeze({ decision: "VERIFIED_COMPLETE_NOOP" });
  }
  return Object.freeze({ decision: "STOP", reason: "partial-or-wrong-stage" });
}

function readSource(relativePath, overrides) {
  if (Object.hasOwn(overrides, relativePath)) {
    return overrides[relativePath];
  }
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function requireText(source, expected, field) {
  if (!source.includes(expected)) {
    fail("STAGING_RUNTIME_CONTRACT_MISSING", `${field} is missing.`);
  }
}

function requirePublicationText(source, expected, code, field) {
  if (!source.includes(expected)) {
    fail(code, `${field} is missing from the staging image publisher.`);
  }
}

function serviceBlock(compose, service) {
  const marker = `  ${service}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) {
    fail("STAGING_SERVICE_MISSING", `${service} is missing from Compose.`);
  }
  const remainder = compose.slice(start + marker.length);
  const nextService = remainder.search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
  return nextService < 0 ? remainder : remainder.slice(0, nextService);
}

function requireServiceValue(block, key, value, service) {
  const expected = `    ${key}: ${value}`;
  if (!block.split(/\r?\n/).includes(expected)) {
    fail(
      "STAGING_RESOURCE_LIMIT_DRIFT",
      `${service}.${key} must equal ${value}.`,
    );
  }
}

function validateDockerfile(relativePath, source) {
  requireText(
    source,
    "# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89",
    `${relativePath} pinned Dockerfile frontend`,
  );
  const fromLines = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FROM "));
  if (
    fromLines.length === 0 ||
    fromLines.some(
      (line) => !/@sha256:[0-9a-f]{64}(?:\s+AS\s+[a-zA-Z0-9_-]+)?$/.test(line),
    )
  ) {
    fail(
      "STAGING_BASE_IMAGE_MUTABLE",
      `${relativePath} contains an unpinned FROM image.`,
    );
  }
  for (const expected of EXPECTED_BASE_IMAGES[relativePath]) {
    requireText(source, expected, `${relativePath} expected base image`);
  }
  requireText(
    source,
    "org.opencontainers.image.revision=",
    `${relativePath} revision label`,
  );
  if (relativePath.startsWith("artifacts/")) {
    requireText(
      source,
      "pnpm@11.9.0",
      `${relativePath} repository-aligned pnpm version`,
    );
  }
}

export function validateStagingRuntimeContract(overrides = {}) {
  const compose = readSource("docker-compose.staging.yml", overrides);
  if (/^\s+build\s*:/m.test(compose)) {
    fail(
      "STAGING_HOST_BUILD_FORBIDDEN",
      "docker-compose.staging.yml must not contain build definitions.",
    );
  }
  if (/^\s+(?:ports|networks):\s*$/m.test(compose)) {
    fail(
      "STAGING_NETWORK_BOUNDARY_DRIFT",
      "staging Compose must not publish ports or define networks.",
    );
  }

  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    requireText(
      compose,
      `image: \${${variable}:?set immutable`,
      `${variable} immutable image input`,
    );
    requireText(
      serviceBlock(compose, "staging-preflight"),
      `${variable}: \${${variable}:?set immutable`,
      `preflight ${variable} validation input`,
    );
  }
  requireText(compose, `image: ${POSTGRES_IMAGE}`, "PostgreSQL image digest");

  for (const [service, resources] of Object.entries(EXPECTED_RESOURCES)) {
    const block = serviceBlock(compose, service);
    requireServiceValue(block, "pull_policy", "always", service);
    requireServiceValue(block, "cpus", `"${resources.cpus}"`, service);
    requireServiceValue(block, "mem_limit", resources.memLimit, service);
    requireServiceValue(
      block,
      "mem_reservation",
      resources.memReservation,
      service,
    );
  }

  for (const relativePath of Object.keys(EXPECTED_BASE_IMAGES)) {
    validateDockerfile(relativePath, readSource(relativePath, overrides));
  }

  const exampleEnv = readSource(".env.staging.example", overrides);
  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    if (!new RegExp(`^${variable}=$`, "m").test(exampleEnv)) {
      fail(
        "STAGING_IMAGE_INPUT_MISSING",
        `${variable} must be an empty input in .env.staging.example.`,
      );
    }
  }

  const preflight = readSource(
    "deploy/staging/preflight/preflight.sh",
    overrides,
  );
  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    requireText(
      preflight,
      `validate_immutable_image "$${variable}" ${variable}`,
      `runtime validation for ${variable}`,
    );
  }

  const publishWorkflow = readSource(
    ".github/workflows/staging-images.yml",
    overrides,
  );
  if (/\bworkflow_dispatch\s*:/.test(publishWorkflow)) {
    fail(
      "STAGING_IMAGE_PUBLIC_DIRECT_DISPATCH",
      "the public source repository must not expose a direct image publisher.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "workflow_call:",
    "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
    "private-caller reusable workflow trigger",
  );
  for (const input of [
    "source_sha:",
    "source_ref:",
    "source_pr_number:",
    "publication_stage:",
    "expected_preflight_digest:",
    "confirm_registry_publication:",
  ]) {
    requirePublicationText(
      publishWorkflow,
      input,
      "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
      `required workflow_call input ${input}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "permissions: {}\n\nconcurrency:",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "deny-by-default workflow permissions",
  );
  requirePublicationText(
    publishWorkflow,
    "group: site-logbook-images-publication",
    "STAGING_IMAGE_CONCURRENCY_GUARD_MISSING",
    "fixed package-namespace concurrency group",
  );
  requirePublicationText(
    publishWorkflow,
    "validate-public-source:\n    permissions: {}",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "token-free public source validation job",
  );
  requirePublicationText(
    publishWorkflow,
    "publish-staging-images:\n    needs: validate-public-source\n    permissions:\n      contents: read\n      packages: write",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "isolated package publication permission",
  );
  if ((publishWorkflow.match(/packages: write/g) ?? []).length !== 1) {
    fail(
      "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
      "only the package publication job may receive packages: write.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "SOURCE_REPOSITORY: modvolt/Site-Logbook",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "fixed public source repository",
  );
  requirePublicationText(
    publishWorkflow,
    "APPROVED_SOURCE_REF: agent/phase13-staging-gate",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "approved candidate ref",
  );
  requirePublicationText(
    publishWorkflow,
    "public_source_api()",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "unauthenticated public source API helper",
  );
  const publicHelper = publishWorkflow.match(
    /^ {10}public_source_api\(\) \{\r?\n([\s\S]*?)^ {10}\}/m,
  )?.[1];
  if (!publicHelper) {
    fail(
      "STAGING_IMAGE_SOURCE_GUARD_MISSING",
      "the public source API helper could not be isolated for validation.",
    );
  }
  for (const forbidden of [
    "Authorization",
    "GH_TOKEN",
    "github.token",
    "secrets.GITHUB_TOKEN",
    "gh api",
  ]) {
    if (publicHelper.includes(forbidden)) {
      fail(
        "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
        `the public source API helper must not contain ${forbidden}.`,
      );
    }
  }
  for (const transportGuard of [
    "curl --disable",
    "--proto '=https'",
    "--connect-timeout 10 --max-time 30",
  ]) {
    if (!publicHelper.includes(transportGuard)) {
      fail(
        "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
        `the public source API helper is missing ${transportGuard}.`,
      );
    }
  }
  requirePublicationText(
    publishWorkflow,
    "https://api.github.com/repos/${SOURCE_REPOSITORY}/git/ref/heads/${SOURCE_REF}",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "candidate branch head lookup",
  );
  requirePublicationText(
    publishWorkflow,
    ".head.sha == $sha",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact PR head SHA check",
  );
  requirePublicationText(
    publishWorkflow,
    "repository: modvolt/Site-Logbook",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact public source checkout repository",
  );
  requirePublicationText(
    publishWorkflow,
    "ref: ${{ inputs.source_sha }}",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact public source checkout SHA",
  );
  requirePublicationText(
    publishWorkflow,
    "actions/workflows/quality-gate.yml/runs?head_sha=${SOURCE_SHA}&event=pull_request&per_page=100",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "exact-SHA pull-request Quality gate lookup",
  );
  if (
    /gh api\s+[\s\S]{0,120}repos\/\$\{SOURCE_REPOSITORY\}\//.test(
      publishWorkflow,
    )
  ) {
    fail(
      "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
      "public source metadata must not use the caller-scoped GitHub token.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '.status == "completed" and .conclusion == "success"',
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "successful Quality gate conclusion",
  );
  requirePublicationText(
    publishWorkflow,
    "sort_by([.run_number, .run_attempt]) |\n             last |",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "latest exact-SHA Quality gate selection",
  );
  requirePublicationText(
    publishWorkflow,
    ".head_sha == $sha",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate head SHA coupling",
  );
  requirePublicationText(
    publishWorkflow,
    "any(.pull_requests[]?; .number == $pr)",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate source PR coupling",
  );
  requirePublicationText(
    publishWorkflow,
    '--argjson pr "$SOURCE_PR_NUMBER"',
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate source PR argument binding",
  );
  requirePublicationText(
    publishWorkflow,
    "APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "exact private caller repository",
  );
  requirePublicationText(
    publishWorkflow,
    '[[ "${CALLER_REPOSITORY,,}" == "$APPROVED_CALLER_REPOSITORY" ]]',
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "exact private caller identity check",
  );
  requirePublicationText(
    publishWorkflow,
    ".private == true",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "private caller repository check",
  );
  requirePublicationText(
    publishWorkflow,
    '.visibility == "private"',
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "GHCR package visibility check",
  );
  requirePublicationText(
    publishWorkflow,
    "'/user/packages?package_type=container&per_page=100'",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "authenticated private package inventory",
  );
  requirePublicationText(
    publishWorkflow,
    "user/packages/container/${package_name}/versions?per_page=100",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "authenticated private package version lookup",
  );
  if (
    /users\/\$?\{?(?:PRIVATE_REGISTRY_OWNER|[Mm]odvolt)/.test(publishWorkflow)
  ) {
    fail(
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "private package metadata must not use the public-user package endpoint.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "(.repository.full_name | ascii_downcase) == $caller",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "private caller package linkage check",
  );
  requirePublicationText(
    publishWorkflow,
    ".repository.private == true",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "linked repository privacy check",
  );
  for (const stageGuard of [
    '"$PUBLICATION_STAGE" == "preflight-only"',
    '"$PUBLICATION_STAGE" == "complete"',
    "if: inputs.publication_stage == 'preflight-only'",
    "if: inputs.publication_stage == 'complete'",
    "PREFLIGHT_DIGEST: ${{ inputs.expected_preflight_digest }}",
  ]) {
    requirePublicationText(
      publishWorkflow,
      stageGuard,
      "STAGING_IMAGE_STAGE_GUARD_MISSING",
      `two-stage publication guard ${stageGuard}`,
    );
  }
  for (const stateTransition of [
    "preflight-only:0000",
    "preflight-only:1000",
    "complete:1000",
    "complete:1111",
  ]) {
    requirePublicationText(
      publishWorkflow,
      stateTransition,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `exact-SHA state transition ${stateTransition}`,
    );
  }
  for (const stateOutput of [
    'echo "publish_preflight=${publish_preflight}"',
    'echo "publish_remaining=${publish_remaining}"',
    'echo "${package_key}_digest=${exact_digests[$package_key]}"',
  ]) {
    requirePublicationText(
      publishWorkflow,
      stateOutput,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "idempotent exact-SHA package-state output",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '} >> "$GITHUB_OUTPUT"',
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "grouped package-state output",
  );
  requirePublicationText(
    publishWorkflow,
    "length == 1 and .[0].name == $digest",
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
    "unique exact-SHA remote digest binding",
  );
  for (const remoteAttestation of [
    "docker buildx imagetools inspect",
    "--format '{{json .Provenance}}'",
    "--format '{{json .SBOM}}'",
    ".schemaVersion == 2 and",
    '.mediaType == "application/vnd.oci.image.index.v1+json" and',
    "($runnable | length) == 1",
    '$runnable[0].mediaType == "application/vnd.oci.image.manifest.v1+json"',
    "($attestations | length) == 1",
    "all($attestations[];",
    "vnd.docker.reference.digest",
    '.SLSA.buildType == "https://mobyproject.org/buildkit@v1"',
    '.SLSA.invocation.environment.platform == "linux/amd64"',
    '.SPDX.SPDXID == "SPDXRef-DOCUMENT"',
    '(.SPDX.spdxVersion | test("^SPDX-[0-9]+\\\\.[0-9]+$"))',
    "remoteManifestVerified: true",
    "runnableManifestDigest",
    "provenanceVerified: true",
    "sbomVerified: true",
  ]) {
    requirePublicationText(
      publishWorkflow,
      remoteAttestation,
      "STAGING_IMAGE_ATTESTATION_MISSING",
      `remote attestation proof ${remoteAttestation}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "assert-exact-tag-absent.sh",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "immediate exact-tag absence helper",
  );
  for (const immediateGuard of [
    "Recheck preflight tag absence immediately before publication",
    "Recheck Mailpit tag absence immediately before publication",
    "Recheck API tag absence immediately before publication",
    "Recheck web tag absence immediately before publication",
  ]) {
    requirePublicationText(
      publishWorkflow,
      immediateGuard,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `pre-push TOCTOU guard ${immediateGuard}`,
    );
  }
  for (const packageName of [
    "site-logbook-staging-preflight",
    "site-logbook-staging-mailpit",
    "site-logbook-staging-api",
    "site-logbook-staging-web",
  ]) {
    requirePublicationText(
      publishWorkflow,
      `"\${RUNNER_TEMP}/assert-exact-tag-absent.sh" ${packageName}`,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `immediate exact-tag absence invocation for ${packageName}`,
    );
  }
  for (const verificationStep of [
    "Verify first published package is private before continuing",
    "Verify Mailpit package is private and digest-bound",
    "Verify API package is private and digest-bound",
    "Verify web package is private and digest-bound",
  ]) {
    requirePublicationText(
      publishWorkflow,
      verificationStep,
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
      `sequential package verification ${verificationStep}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "Verify first published package is private before continuing",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "fail-fast first package privacy verification",
  );
  requirePublicationText(
    publishWorkflow,
    "Verify all published packages remain private",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "post-publication privacy verification",
  );
  if (
    (
      publishWorkflow.match(
        /org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}/g,
      ) ?? []
    ).length !== 4
  ) {
    fail(
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
      "all four images must link to the private caller repository.",
    );
  }
  if (
    (
      publishWorkflow.match(
        /org\.opencontainers\.image\.url=https:\/\/github\.com\/modvolt\/Site-Logbook\/commit\/\$\{\{ inputs\.source_sha \}\}/g,
      ) ?? []
    ).length !== 4
  ) {
    fail(
      "STAGING_IMAGE_SOURCE_GUARD_MISSING",
      "all four images must preserve the exact public source commit URL.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
    "nonempty sha256 digest validation",
  );
  for (const imageName of [
    "site-logbook-staging-preflight",
    "site-logbook-staging-mailpit",
    "site-logbook-staging-api",
    "site-logbook-staging-web",
  ]) {
    requirePublicationText(
      publishWorkflow,
      `^ghcr\\\\.io/modvolt/${imageName}@sha256:[0-9a-f]{64}$`,
      "STAGING_IMAGE_DIGEST_GUARD_MISSING",
      `immutable manifest namespace for ${imageName}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "confirm_registry_publication:",
    "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
    "explicit publication confirmation",
  );
  requireText(publishWorkflow, "packages: write", "GHCR write permission");
  for (const action of PINNED_ACTIONS) {
    requireText(publishWorkflow, action, `pinned action ${action}`);
  }
  if ((publishWorkflow.match(/\bpush: true\b/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
      "the manual workflow must publish exactly four custom images.",
    );
  }
  if ((publishWorkflow.match(/\bpush: false\b/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_PREBUILD_GUARD_MISSING",
      "each image publication stage must validate builds without a registry write first.",
    );
  }
  for (const buildValidation of [
    "Validate preflight image build without registry write",
    "Validate Mailpit image build without registry write",
    "Validate API image build without registry write",
    "Validate web image build without registry write",
  ]) {
    requireText(
      publishWorkflow,
      buildValidation,
      `complete-stage no-write prebuild ${buildValidation}`,
    );
  }
  if ((publishWorkflow.match(/platforms: linux\/amd64/g) ?? []).length !== 8) {
    fail(
      "STAGING_IMAGE_PLATFORM_DRIFT",
      "all eight validation and publication builds must target the approved linux/amd64 host.",
    );
  }
  if ((publishWorkflow.match(/provenance: mode=max/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_ATTESTATION_MISSING",
      "all four custom images must publish maximum BuildKit provenance.",
    );
  }
  if ((publishWorkflow.match(/\bsbom: true\b/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_ATTESTATION_MISSING",
      "all four custom images must publish an SBOM attestation.",
    );
  }
  requireText(
    publishWorkflow,
    "staging-images.json",
    "secret-free immutable image manifest",
  );
  requireText(
    publishWorkflow,
    "preflight-publication.json",
    "secret-free preflight publication evidence",
  );
  for (const checksum of [
    "preflight-publication.sha256",
    "staging-images.sha256",
    "remaining-mailpit-package.sha256",
    "remaining-api-package.sha256",
    "remaining-web-package.sha256",
  ]) {
    requireText(publishWorkflow, checksum, `${checksum} evidence checksum`);
  }
  const orderedRecoverySteps = [
    "Verify Mailpit package is private and digest-bound",
    "Upload Mailpit partial-publication recovery evidence",
    "Recheck API tag absence immediately before publication",
    "Build and publish API image",
    "Verify API package is private and digest-bound",
    "Upload API partial-publication recovery evidence",
    "Recheck web tag absence immediately before publication",
    "Build and publish web image",
    "Verify web package is private and digest-bound",
    "Upload web partial-publication recovery evidence",
    "Verify all published packages remain private",
    "Create and validate secret-free immutable image manifest",
  ];
  let previousRecoveryStep = -1;
  for (const recoveryStep of orderedRecoverySteps) {
    const recoveryStepIndex = publishWorkflow.indexOf(recoveryStep);
    if (recoveryStepIndex <= previousRecoveryStep) {
      fail(
        "STAGING_IMAGE_RECOVERY_EVIDENCE_ORDER_BROKEN",
        `${recoveryStep} is missing or out of fail-closed order.`,
      );
    }
    previousRecoveryStep = recoveryStepIndex;
  }
  for (const evidenceField of [
    "initialPackageState",
    "registryAction",
    "callerWorkflowRef",
  ]) {
    requireText(
      publishWorkflow,
      evidenceField,
      `publication evidence field ${evidenceField}`,
    );
  }
  if (/\b(?:coolify|kubectl|ssh)\b/i.test(publishWorkflow)) {
    fail(
      "STAGING_IMAGE_WORKFLOW_DEPLOYS",
      "the publication workflow must not contact a deployment plane.",
    );
  }

  const qualityWorkflow = readSource(
    ".github/workflows/quality-gate.yml",
    overrides,
  );
  requireText(
    qualityWorkflow,
    "pnpm gate:staging-runtime",
    "Quality gate staging runtime validation",
  );
  requireText(
    qualityWorkflow,
    "pnpm test:staging-contract",
    "Quality gate staging contract tests",
  );

  return Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    runtimeBuildDefinitions: 0,
    services: Object.keys(EXPECTED_RESOURCES),
    totalCpuLimit: 2.25,
    totalMemoryLimitMiB: 2304,
    immutableCustomImages: REQUIRED_IMAGE_VARIABLES.length,
    pinnedBaseImageFamilies: 5,
    publicationMode: "private-caller-ghcr-no-deploy",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      `${JSON.stringify(validateStagingRuntimeContract(), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
