import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "./check-staging-provisioning.mjs";

export const STAGING_VOLUME_INSPECT_FORMAT =
  '{"name":{{json .Name}},"driver":{{json .Driver}},"projectLabel":{{json (index .Labels "com.docker.compose.project")}},"volumeLabel":{{json (index .Labels "com.docker.compose.volume")}}}';

export const STAGING_NETWORK_INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"attachable":{{json .Attachable}},"projectLabel":{{json (index .Labels "com.docker.compose.project")}},"networkLabel":{{json (index .Labels "com.docker.compose.network")}},"containers":{{json .Containers}}}';

export class StagingFrozenComposeRuntimeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingFrozenComposeRuntimeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingFrozenComposeRuntimeError(code, message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function escapeComposeInterpolation(value) {
  if (Array.isArray(value)) return value.map(escapeComposeInterpolation);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        escapeComposeInterpolation(entry),
      ]),
    );
  }
  return typeof value === "string" ? value.replaceAll("$", "$$") : value;
}

function exactContainerIds(stdout, label) {
  const ids = String(stdout ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    ids.some((id) => !/^[0-9a-f]{64}$/.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    fail(
      "STAGING_DOCKER_BOUNDARY_INVALID",
      `${label} returned a non-exact container ID.`,
    );
  }
  return [...new Set(ids)].sort();
}

function sameIds(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail(
      "STAGING_DOCKER_BOUNDARY_FOREIGN_CONTAINER",
      `${label} includes a container outside the exact observed-boundary allowlist.`,
    );
  }
}

function strictJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    fail("STAGING_DOCKER_BOUNDARY_INVALID", `${label} must be strict JSON.`);
  }
}

function assertFrozenFile(frozen, phase) {
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(frozen.filePath);
    bytes = fs.readFileSync(frozen.filePath);
  } catch {
    fail(
      "STAGING_FROZEN_COMPOSE_MISSING",
      `The private rendered Compose input is unavailable during ${phase}.`,
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    bytes.length !== frozen.fileBytes.length ||
    !bytes.equals(frozen.fileBytes) ||
    sha256(bytes) !== frozen.fileSha256 ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  ) {
    fail(
      "STAGING_FROZEN_COMPOSE_CHANGED",
      `The exact private rendered Compose bytes changed during ${phase}.`,
    );
  }
}

function validateFrozenResolution(runDocker, frozen, phase) {
  assertFrozenFile(frozen, phase);
  const stdout = runDocker(
    [...frozen.composeArgs, "config", "--format", "json"],
    `${phase} frozen Compose resolution`,
  );
  const value = strictJson(stdout, `${phase} frozen Compose resolution`);
  if (canonicalJson(value) !== frozen.resolvedBytes) {
    fail(
      "STAGING_FROZEN_COMPOSE_RESOLUTION_CHANGED",
      `The frozen Compose input no longer resolves to its exact reviewed bytes during ${phase}.`,
    );
  }
}

/**
 * Materialize one fully rendered Compose model into a private, exclusive file.
 * `resolvedValue` may contain secrets. Neither its bytes nor its path are
 * returned in evidence or emitted to logs by this module.
 */
export function freezeRenderedCompose({
  resolvedValue,
  projectName,
  profile,
  targetService,
  environmentOverrides = {},
  commandOverride,
  label,
}) {
  if (
    !resolvedValue ||
    typeof resolvedValue !== "object" ||
    Array.isArray(resolvedValue) ||
    resolvedValue.name !== projectName
  ) {
    fail(
      "STAGING_FROZEN_COMPOSE_INVALID",
      "A resolved exact Compose project is required.",
    );
  }
  const executionValue = structuredClone(resolvedValue);
  const service = executionValue.services?.[targetService];
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    fail(
      "STAGING_FROZEN_COMPOSE_INVALID",
      "The exact one-shot service is missing.",
    );
  }
  const environment = service.environment;
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    fail(
      "STAGING_FROZEN_COMPOSE_INVALID",
      "The one-shot environment is not resolved.",
    );
  }
  for (const [key, value] of Object.entries(environmentOverrides)) {
    if (!Object.hasOwn(environment, key) || typeof value !== "string") {
      fail(
        "STAGING_FROZEN_COMPOSE_OVERRIDE_INVALID",
        `The ${key} override is not an exact resolved environment field.`,
      );
    }
    environment[key] = value;
  }
  if (commandOverride !== undefined) {
    if (
      !Array.isArray(commandOverride) ||
      commandOverride.length === 0 ||
      commandOverride.some((value) => typeof value !== "string" || !value)
    ) {
      fail(
        "STAGING_FROZEN_COMPOSE_OVERRIDE_INVALID",
        "The one-shot command override must be an exact nonempty argv array.",
      );
    }
    service.command = [...commandOverride];
  }
  const nonce = sha256(
    Buffer.from(canonicalJson(executionValue), "utf8"),
  ).slice(0, 20);
  const containerName = `${projectName}-${targetService}-${nonce}`;
  service.container_name = containerName;
  const resolvedBytes = canonicalJson(executionValue);
  const fileBytes = Buffer.from(
    canonicalJson(escapeComposeInterpolation(executionValue)),
    "utf8",
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "site-logbook-compose-"),
  );
  let descriptor;
  const filePath = path.join(directory, "rendered-compose.json");
  try {
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(descriptor, fileBytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const frozen = {
      directory,
      filePath,
      fileBytes,
      fileSha256: sha256(fileBytes),
      resolvedBytes,
      resolvedSha256: sha256(Buffer.from(resolvedBytes, "utf8")),
      containerName,
      targetService,
      label,
      composeArgs: [
        "compose",
        "--project-name",
        projectName,
        "-f",
        filePath,
        "--profile",
        profile,
      ],
    };
    assertFrozenFile(frozen, "creation");
    return frozen;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
    throw error;
  }
}

export function cleanupFrozenCompose(frozen) {
  // Integrity is checked at every pre/post execution boundary. Cleanup remains
  // unconditional even when that earlier check detected tampering.
  try {
    assertFrozenFile(frozen, "cleanup");
  } catch {}
  let cleanupError;
  try {
    if (fs.existsSync(frozen.filePath)) fs.unlinkSync(frozen.filePath);
    if (fs.existsSync(frozen.directory)) fs.rmdirSync(frozen.directory);
  } catch (error) {
    cleanupError ??= error;
  } finally {
    frozen.fileBytes.fill(0);
  }
  if (cleanupError) {
    fail(
      "STAGING_FROZEN_COMPOSE_CLEANUP_FAILED",
      `The private rendered Compose input failed integrity or cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}

export function assertApprovedDockerBoundary({
  runDocker,
  postgres,
  projectName,
  oneShotContainerId,
  phase,
}) {
  const allowed = [
    postgres.containerId,
    ...(oneShotContainerId ? [oneShotContainerId] : []),
  ].sort();
  const volumeIds = exactContainerIds(
    runDocker(
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `volume=${postgres.volumeName}`,
      ],
      `${phase} approved postgres volume peers`,
    ),
    `${phase} approved postgres volume peers`,
  );
  const networkIds = exactContainerIds(
    runDocker(
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `network=${postgres.networkName}`,
      ],
      `${phase} approved default network peers`,
    ),
    `${phase} approved default network peers`,
  );
  sameIds(volumeIds, [postgres.containerId], `${phase} postgres volume`);
  sameIds(networkIds, allowed, `${phase} default network`);

  const volume = strictJson(
    runDocker(
      [
        "volume",
        "inspect",
        "--format",
        STAGING_VOLUME_INSPECT_FORMAT,
        postgres.volumeName,
      ],
      `${phase} approved postgres volume inspection`,
    ),
    `${phase} approved postgres volume inspection`,
  );
  if (
    volume?.name !== postgres.volumeName ||
    volume.driver !== "local" ||
    volume.projectLabel !== projectName ||
    volume.volumeLabel !== "staging_pgdata"
  ) {
    fail(
      "STAGING_DOCKER_VOLUME_MISMATCH",
      `${phase} postgres volume identity is not the exact approved Compose volume.`,
    );
  }

  const network = strictJson(
    runDocker(
      [
        "network",
        "inspect",
        "--format",
        STAGING_NETWORK_INSPECT_FORMAT,
        postgres.networkName,
      ],
      `${phase} approved default network inspection`,
    ),
    `${phase} approved default network inspection`,
  );
  const peerIds = Object.keys(network?.containers ?? {}).sort();
  if (
    network?.id !== postgres.networkId ||
    network.name !== postgres.networkName ||
    network.driver !== "bridge" ||
    network.scope !== "local" ||
    network.internal !== false ||
    network.attachable !== false ||
    network.projectLabel !== projectName ||
    network.networkLabel !== "default"
  ) {
    fail(
      "STAGING_DOCKER_NETWORK_MISMATCH",
      `${phase} default network identity is not the exact approved Compose network.`,
    );
  }
  sameIds(peerIds, allowed, `${phase} network inspection peers`);
}

export function runFrozenComposeOneShot({ runDocker, frozen, assertBoundary }) {
  let creationAttempted = false;
  let containerId;
  let primaryError;
  let cleanupError;
  let oneShotStdout;
  try {
    validateFrozenResolution(runDocker, frozen, `${frozen.label} pre-create`);
    assertBoundary(undefined, `${frozen.label} pre-create boundary`);
    creationAttempted = true;
    runDocker(
      [
        ...frozen.composeArgs,
        "create",
        "--no-build",
        "--pull",
        "never",
        "--no-recreate",
        frozen.targetService,
      ],
      `${frozen.label} exact container creation`,
    );
    const ids = exactContainerIds(
      runDocker(
        [
          ...frozen.composeArgs,
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          frozen.targetService,
        ],
        `${frozen.label} exact container lookup`,
      ),
      `${frozen.label} exact container lookup`,
    );
    if (ids.length !== 1) {
      fail(
        "STAGING_ONE_SHOT_CONTAINER_INVALID",
        `${frozen.label} must create exactly one pre-known container.`,
      );
    }
    [containerId] = ids;
    validateFrozenResolution(
      runDocker,
      frozen,
      `${frozen.label} immediately pre-start`,
    );
    assertBoundary(
      containerId,
      `${frozen.label} immediately pre-start boundary`,
    );
    oneShotStdout = runDocker(
      ["start", "--attach", containerId],
      `${frozen.label} exact one-shot start`,
    );
    const state = strictJson(
      runDocker(
        ["inspect", "--format", "{{json .State}}", containerId],
        `${frozen.label} exit-state inspection`,
      ),
      `${frozen.label} exit-state inspection`,
    );
    if (
      state?.Status !== "exited" ||
      state.Running !== false ||
      state.ExitCode !== 0
    ) {
      fail(
        "STAGING_ONE_SHOT_EXIT_INVALID",
        `${frozen.label} did not exit successfully.`,
      );
    }
    validateFrozenResolution(
      runDocker,
      frozen,
      `${frozen.label} immediately post-exit`,
    );
    assertBoundary(
      containerId,
      `${frozen.label} immediately post-exit boundary`,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (creationAttempted) {
      const target = containerId ?? frozen.containerName;
      const removed = runDocker(
        ["rm", "--force", target],
        `${frozen.label} exact container cleanup`,
        { allowFailure: true },
      );
      if (removed === undefined) {
        cleanupError = new StagingFrozenComposeRuntimeError(
          "STAGING_ONE_SHOT_CLEANUP_FAILED",
          `${frozen.label} exact container cleanup failed.`,
        );
      }
    }
    try {
      validateFrozenResolution(
        runDocker,
        frozen,
        `${frozen.label} post-cleanup`,
      );
      assertBoundary(undefined, `${frozen.label} post-cleanup boundary`);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (primaryError && cleanupError) {
    Object.defineProperty(primaryError, "cleanupError", {
      value: cleanupError,
      enumerable: false,
      configurable: false,
    });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return oneShotStdout;
}
