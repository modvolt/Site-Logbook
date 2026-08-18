import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import {
  PRODUCTION_TARGET,
  canonicalJson,
} from "../host-attestation-contract.mjs";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const BRIDGE_SCHEMA = "site-logbook.coolify-host-bridge-attestation/v1";

export const PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING = Object.freeze({
  version: "4.1.1",
  sourceCommitSha: "5a27427cad54e98c21a691a08077c20f94f84f73",
  containerId:
    "6d67a437666b353feaeb549c70f7c032e92269fc04170c87265919fe7c69e97c",
  containerImage: "ghcr.io/coollabsio/coolify:4.1.1",
  imageId:
    "sha256:4471528f3428c8cc78867bd809d545563d60c5d32483f7b6d958c624b29c5a0a",
  imageRef:
    "ghcr.io/coollabsio/coolify@sha256:4471528f3428c8cc78867bd809d545563d60c5d32483f7b6d958c624b29c5a0a",
  startedAt: "2026-06-27T00:16:08.215284422Z",
});

const CONTAINER_INSPECT_TEMPLATE = [
  "{",
  '"Id":{{json .Id}},',
  '"ConfigImage":{{json .Config.Image}},',
  '"Image":{{json .Image}},',
  '"State":{',
  '"Status":{{json .State.Status}},',
  '"Running":{{json .State.Running}},',
  '"Health":{{json .State.Health.Status}},',
  '"StartedAt":{{json .State.StartedAt}}',
  "}}",
].join("");

const IMAGE_INSPECT_TEMPLATE =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}}}';

function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

const PHP_SOURCE = `<?php
declare(strict_types=1);

use App\\Enums\\ApplicationDeploymentStatus;
use App\\Models\\Application;
use App\\Services\\DeploymentConfiguration\\ApplicationConfigurationSnapshot;
use Illuminate\\Contracts\\Console\\Kernel;
use Illuminate\\Support\\Facades\\DB;
use Symfony\\Component\\Yaml\\Yaml;

const BRIDGE_SCHEMA = ${phpString(BRIDGE_SCHEMA)};
const EXPECTED_COOLIFY_VERSION = ${phpString(PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.version)};
const EXPECTED_COOLIFY_SOURCE_COMMIT = ${phpString(PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.sourceCommitSha)};
const EXPECTED_PROJECT_UUID = ${phpString(PRODUCTION_TARGET.projectId)};
const EXPECTED_ENVIRONMENT_UUID = ${phpString(PRODUCTION_TARGET.environmentId)};
const EXPECTED_ENVIRONMENT_LABEL = ${phpString(PRODUCTION_TARGET.environmentLabel)};
const EXPECTED_APPLICATION_UUID = ${phpString(PRODUCTION_TARGET.applicationId)};
const MAX_COMPOSE_BYTES = 524288;

function stop_bridge(): never
{
    exit(70);
}

function exact_digest(mixed $value): string
{
    if (!is_string($value) || trim($value) !== $value) {
        stop_bridge();
    }
    $value = strtolower($value);
    if (!preg_match('/\\A(?:sha256:)?([0-9a-f]{64})\\z/D', $value, $matches)) {
        stop_bridge();
    }
    return 'sha256:'.$matches[1];
}

function exact_utc(string $value): DateTimeImmutable
{
    if (!str_ends_with($value, 'Z')) {
        stop_bridge();
    }
    try {
        return new DateTimeImmutable($value);
    } catch (Throwable) {
        stop_bridge();
    }
}

function immutable_image(mixed $value): string
{
    if (!is_string($value) || trim($value) !== $value) {
        stop_bridge();
    }
    if (!preg_match('/\\A[a-z0-9.-]+(?::[0-9]+)?\\/[a-z0-9._\\/-]+@sha256:[0-9a-f]{64}\\z/D', $value)) {
        stop_bridge();
    }
    return $value;
}

try {
    if (PHP_SAPI !== 'cli') {
        stop_bridge();
    }
    $arguments = $argv;
    array_shift($arguments);
    if (count($arguments) !== 6) {
        stop_bridge();
    }
    [$schema, $applicationUuid, $nonce, $ordinal, $issuedAtText, $expiresAtText] = $arguments;
    if (
        $schema !== BRIDGE_SCHEMA ||
        $applicationUuid !== EXPECTED_APPLICATION_UUID ||
        !preg_match('/\\A[0-9a-f]{64}\\z/D', $nonce) ||
        !in_array($ordinal, ['1', '2'], true)
    ) {
        stop_bridge();
    }
    $issuedAt = exact_utc($issuedAtText);
    $expiresAt = exact_utc($expiresAtText);
    $serverTime = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    if (
        $expiresAt <= $issuedAt ||
        $expiresAt->getTimestamp() - $issuedAt->getTimestamp() > 90 ||
        $serverTime < $issuedAt->modify('-30 seconds') ||
        $serverTime > $expiresAt
    ) {
        stop_bridge();
    }

    require '/var/www/html/vendor/autoload.php';
    $laravel = require '/var/www/html/bootstrap/app.php';
    $laravel->make(Kernel::class)->bootstrap();

    $connection = DB::connection();
    $connection->beginTransaction();
    try {
        $connection->statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        $application = Application::query()
            ->where('uuid', EXPECTED_APPLICATION_UUID)
            ->first();
        if (!$application) {
            stop_bridge();
        }
        $environment = $application->environment;
        $project = $environment?->project;
        if (
            $application->uuid !== EXPECTED_APPLICATION_UUID ||
            $environment?->uuid !== EXPECTED_ENVIRONMENT_UUID ||
            $environment?->name !== EXPECTED_ENVIRONMENT_LABEL ||
            $project?->uuid !== EXPECTED_PROJECT_UUID
        ) {
            stop_bridge();
        }

        $deployment = $application->get_last_successful_deployment();
        if (
            !$deployment ||
            $deployment->status !== ApplicationDeploymentStatus::FINISHED->value ||
            (int) $deployment->pull_request_id !== 0 ||
            !is_string($deployment->deployment_uuid) ||
            !preg_match('/\\A[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\\z/D', $deployment->deployment_uuid) ||
            !is_string($deployment->commit) ||
            !preg_match('/\\A[0-9a-f]{40}\\z/D', $deployment->commit) ||
            !$deployment->finished_at ||
            !is_array($deployment->configuration_snapshot) ||
            count($deployment->configuration_snapshot) === 0
        ) {
            stop_bridge();
        }

        $desiredConfigurationSha256 = exact_digest($application->deploymentConfigurationHash());
        $deployedConfigurationSha256 = exact_digest($deployment->configuration_hash);
        $storedSnapshotSha256 = exact_digest(
            ApplicationConfigurationSnapshot::hashSnapshot($deployment->configuration_snapshot)
        );
        if (
            !hash_equals($desiredConfigurationSha256, $deployedConfigurationSha256) ||
            !hash_equals($deployedConfigurationSha256, $storedSnapshotSha256) ||
            $application->pendingDeploymentConfigurationDiff()->isChanged()
        ) {
            stop_bridge();
        }

        $composePath = '/var/www/html/storage/app/applications/'.EXPECTED_APPLICATION_UUID.'/docker-compose.yaml';
        if (!is_file($composePath) || !is_readable($composePath)) {
            stop_bridge();
        }
        $composeBytes = file_get_contents($composePath);
        if (
            !is_string($composeBytes) ||
            strlen($composeBytes) === 0 ||
            strlen($composeBytes) > MAX_COMPOSE_BYTES
        ) {
            stop_bridge();
        }
        $compose = Yaml::parse($composeBytes);
        $services = is_array($compose) ? ($compose['services'] ?? null) : null;
        if (!is_array($services)) {
            stop_bridge();
        }
        $serviceNames = array_keys($services);
        sort($serviceNames, SORT_STRING);
        if ($serviceNames !== ['api', 'postgres', 'web']) {
            stop_bridge();
        }
        $images = [];
        foreach (['api', 'postgres', 'web'] as $service) {
            $serviceConfig = $services[$service] ?? null;
            if (!is_array($serviceConfig)) {
                stop_bridge();
            }
            $images[$service] = immutable_image($serviceConfig['image'] ?? null);
        }
        $resolvedComposeSha256 = 'sha256:'.hash('sha256', $composeBytes);
        $finishedAt = DateTimeImmutable::createFromInterface($deployment->finished_at)
            ->setTimezone(new DateTimeZone('UTC'))
            ->format('Y-m-d\\TH:i:s.v\\Z');

        $attestation = [
            'schemaVersion' => BRIDGE_SCHEMA,
            'challenge' => [
                'nonce' => $nonce,
                'ordinal' => (int) $ordinal,
                'issuedAt' => $issuedAtText,
                'expiresAt' => $expiresAtText,
                'serverTime' => $serverTime->format('Y-m-d\\TH:i:s.v\\Z'),
            ],
            'controlPlane' => [
                'version' => EXPECTED_COOLIFY_VERSION,
                'sourceCommitSha' => EXPECTED_COOLIFY_SOURCE_COMMIT,
            ],
            'target' => [
                'projectId' => EXPECTED_PROJECT_UUID,
                'environmentId' => EXPECTED_ENVIRONMENT_UUID,
                'environmentLabel' => EXPECTED_ENVIRONMENT_LABEL,
                'applicationId' => EXPECTED_APPLICATION_UUID,
            ],
            'pendingChanges' => false,
            'deployment' => [
                'deploymentId' => $deployment->deployment_uuid,
                'revision' => $deployment->commit,
                'deployedAt' => $finishedAt,
                'status' => $deployment->status,
                'pullRequestId' => (int) $deployment->pull_request_id,
            ],
            'configuration' => [
                'desiredSha256' => $desiredConfigurationSha256,
                'deployedSha256' => $deployedConfigurationSha256,
                'storedSnapshotSha256' => $storedSnapshotSha256,
            ],
            'resolvedCompose' => [
                'desiredSha256' => $resolvedComposeSha256,
                'deployedSha256' => $resolvedComposeSha256,
                'images' => $images,
            ],
        ];
    } finally {
        if ($connection->transactionLevel() > 0) {
            $connection->rollBack();
        }
    }

    echo json_encode($attestation, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), PHP_EOL;
    exit(0);
} catch (Throwable) {
    exit(70);
}
`;

const computedBridgeSourceSha256 = `sha256:${createHash("sha256").update(PHP_SOURCE).digest("hex")}`;

export const PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256 =
  "sha256:3bdfcf56842ee67b98975bf6b03931c8b9dd4b518b2b4650a424919f55abd2d7";

if (
  computedBridgeSourceSha256 !== PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256
) {
  throw new Error(
    "PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_PIN_INVALID: The reviewed bridge source changed.",
  );
}

function bridgeError() {
  return new Error(
    "PRODUCTION_COOLIFY_HOST_BRIDGE_FAILURE: The pinned read-only Coolify host authority failed closed.",
  );
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw bridgeError();
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw bridgeError();
  }
  return value;
}

function parseSingleJson(stdout) {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout) > MAX_STDOUT_BYTES
  ) {
    throw bridgeError();
  }
  const text = stdout.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) throw bridgeError();
  try {
    return JSON.parse(text);
  } catch {
    throw bridgeError();
  }
}

function abortError() {
  const error = new Error("The pinned Coolify host observation was aborted.");
  error.name = "AbortError";
  return error;
}

function runDockerProcess(args, { input = "", signal }) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const child = spawn("docker", args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = () => {
      child.kill();
      finish(reject, bridgeError());
    };
    const onAbort = () => {
      child.kill();
      finish(reject, abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", fail);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return fail();
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail();
    });
    child.on("close", (code, closeSignal) => {
      if (settled || code !== 0 || closeSignal !== null || stderrBytes !== 0) {
        if (!settled) finish(reject, bridgeError());
        return;
      }
      finish(resolve, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: "",
        exitCode: code,
      });
    });
    child.stdin.on("error", fail);
    child.stdin.end(input);
  });
}

async function runStrict(runDocker, args, { input = "", signal }) {
  let result;
  try {
    result = await runDocker(args, { input, signal });
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") throw abortError();
    throw bridgeError();
  }
  const value = exactObject(result, ["exitCode", "stderr", "stdout"]);
  if (value.exitCode !== 0 || value.stderr !== "") throw bridgeError();
  return value.stdout;
}

async function inspectControlPlane(runDocker, signal) {
  const container = exactObject(
    parseSingleJson(
      await runStrict(
        runDocker,
        [
          "container",
          "inspect",
          "--format",
          CONTAINER_INSPECT_TEMPLATE,
          PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.containerId,
        ],
        { signal },
      ),
    ),
    ["ConfigImage", "Id", "Image", "State"],
  );
  const state = exactObject(container.State, [
    "Health",
    "Running",
    "StartedAt",
    "Status",
  ]);
  const image = exactObject(
    parseSingleJson(
      await runStrict(
        runDocker,
        [
          "image",
          "inspect",
          "--format",
          IMAGE_INSPECT_TEMPLATE,
          PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.imageRef,
        ],
        { signal },
      ),
    ),
    ["Id", "RepoDigests"],
  );
  if (
    container.Id !== PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.containerId ||
    container.ConfigImage !==
      PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.containerImage ||
    container.Image !== PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.imageId ||
    state.Status !== "running" ||
    state.Running !== true ||
    state.Health !== "healthy" ||
    state.StartedAt !== PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.startedAt ||
    image.Id !== PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.imageId ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(
      PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.imageRef,
    )
  ) {
    throw bridgeError();
  }
  return Object.freeze({
    bridgeSourceSha256: PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256,
    containerId: container.Id,
    containerImage: container.ConfigImage,
    imageId: image.Id,
    imageRef: PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.imageRef,
    startedAt: state.StartedAt,
    status: state.Status,
    health: state.Health,
    version: PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.version,
    sourceCommitSha: PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.sourceCommitSha,
  });
}

function exactChallenge(value) {
  const challenge = exactObject(value, [
    "expiresAt",
    "issuedAt",
    "nonce",
    "ordinal",
  ]);
  if (
    typeof challenge.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(challenge.nonce) ||
    ![1, 2].includes(challenge.ordinal) ||
    typeof challenge.issuedAt !== "string" ||
    typeof challenge.expiresAt !== "string"
  ) {
    throw bridgeError();
  }
  return challenge;
}

function createAuthority(runDocker) {
  return async function readCoolifyHostBridgeAttestation(rawCall) {
    const call = exactObject(rawCall, ["challenge", "signal"]);
    if (!(call.signal instanceof AbortSignal) || call.signal.aborted) {
      throw abortError();
    }
    const challenge = exactChallenge(call.challenge);
    const before = await inspectControlPlane(runDocker, call.signal);
    const stdout = await runStrict(
      runDocker,
      [
        "exec",
        "-i",
        PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.containerId,
        "php",
        "-d",
        "display_errors=0",
        "-d",
        "log_errors=0",
        "-f",
        "/dev/stdin",
        "--",
        BRIDGE_SCHEMA,
        PRODUCTION_TARGET.applicationId,
        challenge.nonce,
        String(challenge.ordinal),
        challenge.issuedAt,
        challenge.expiresAt,
      ],
      { input: PHP_SOURCE, signal: call.signal },
    );
    const bridge = parseSingleJson(stdout);
    const after = await inspectControlPlane(runDocker, call.signal);
    if (canonicalJson(before) !== canonicalJson(after)) throw bridgeError();
    return Object.freeze({
      bridge,
      controlPlane: after,
    });
  };
}

export const readProductionCoolifyHostBridgeAttestation =
  createAuthority(runDockerProcess);

export function createProductionCoolifyHostBridgeAuthorityForTest(runDocker) {
  if (typeof runDocker !== "function") throw bridgeError();
  return createAuthority(runDocker);
}

export const productionCoolifyHostBridgeTestContract = Object.freeze({
  bridgeSchema: BRIDGE_SCHEMA,
  phpSource: PHP_SOURCE,
});
