import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
  validateProductionImmutableRuntimeBinding,
} from "./production-exact-0096-backup-contract.mjs";
import { createProductionMigrationRuntimeObservation } from "./production-migration-adapter.mjs";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const RESOLVED_CONFIG_LABEL = "io.modvolt.site-logbook.resolved-config-sha256";
const DEPLOYMENT_CONFIG_LABEL =
  "io.modvolt.site-logbook.deployment-config-sha256";
const SOURCE_SHA_LABEL = "org.opencontainers.image.revision";
const IMMUTABLE_DIGEST_SEPARATOR = "@sha256:";
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_SOURCE_SHA = "6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5";
const LEGACY_COMPOSE_PROJECT = "ef09696arga7h9ox6ojgv7ru";
const LEGACY_APPLICATION_REPOSITORY = `${LEGACY_COMPOSE_PROJECT}_api`;
const LEGACY_POSTGRES_REPOSITORY = "postgres";
const LEGACY_POSTGRES_CONFIG_IMAGE = "postgres:16-alpine";
const LEGACY_POSTGRES_VOLUME = `${LEGACY_COMPOSE_PROJECT}_pgdata`;
const POSTGRES_DATA_DESTINATION = "/var/lib/postgresql/data";
const LEGACY_POSTGRES_SERVICE_CONFIG_HASH =
  "a6b721760225d7b9ffe163067a8256c1bd7c87e7c30d8d972bba1d6adb8d847e";
const LEGACY_CONFIG_SURROGATE = `sha256:${LEGACY_POSTGRES_SERVICE_CONFIG_HASH}`;

const CONTAINER_PROJECTION = [
  '{"Id":{{json .Id}},"Image":{{json .Image}},',
  '"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},',
  '"State":{"Status":{{json .State.Status}}},',
  '"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}',
].join("");
const IMAGE_PROJECTION =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"RepoTags":{{json .RepoTags}},"Labels":{{json (index .Config "Labels")}}}';
const VOLUME_PROJECTION =
  '{"Name":{{json .Name}},"CreatedAt":{{json .CreatedAt}},"Labels":{{json .Labels}}}';
const NETWORK_PROJECTION =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Containers":{{json .Containers}}}';

export class ProductionMigrationRuntimeAuthorityError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationRuntimeAuthorityError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductionMigrationRuntimeAuthorityError(code, message, options);
}

function exactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INPUT_INVALID",
      `${field} must be an exact object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INPUT_INVALID",
      `${field} has fields outside the reviewed contract.`,
    );
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_ABORTED",
      "Runtime observation was aborted and failed closed.",
      { cause: signal.reason },
    );
  }
}

async function defaultExecFile(command, args, options) {
  return execFile(command, args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeoutMs,
    signal: options.signal,
  });
}

function parseProjection(result, field) {
  const stdout = typeof result === "string" ? result : result?.stdout;
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") === 0 ||
    Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_OUTPUT_INVALID",
      `${field} exceeded the fixed output contract.`,
    );
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_OUTPUT_INVALID",
      `${field} did not return one JSON projection.`,
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_OUTPUT_INVALID",
      `${field} did not return one object projection.`,
    );
  }
  return value;
}

function exactTimestamp(value, field) {
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    text,
  );
  const milliseconds = Date.parse(text);
  const expectedCanonical = match
    ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`
    : undefined;
  if (
    match === null ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== expectedCanonical
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_OUTPUT_INVALID",
      `${field} is not a bounded Docker UTC timestamp.`,
    );
  }
  return new Date(milliseconds).toISOString();
}

function labelsDigest(labels) {
  return productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(labels ?? {}),
  );
}

function immutableRepository(value, field) {
  const separator = value.lastIndexOf(IMMUTABLE_DIGEST_SEPARATOR);
  if (separator <= 0) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INPUT_INVALID",
      `${field} is not one digest-addressed image reference.`,
    );
  }
  return value.slice(0, separator);
}

function taggedRepository(value) {
  if (typeof value !== "string" || value.includes("@")) return undefined;
  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  if (colon <= slash || !DOCKER_TAG.test(value.slice(colon + 1))) {
    return undefined;
  }
  return value.slice(0, colon);
}

function hasOwnLabel(labels, name) {
  return Boolean(
    labels &&
    typeof labels === "object" &&
    !Array.isArray(labels) &&
    Object.hasOwn(labels, name),
  );
}

function modernConfigurationMatches(binding, labels) {
  const resolvedPresent = hasOwnLabel(labels, RESOLVED_CONFIG_LABEL);
  const deploymentPresent = hasOwnLabel(labels, DEPLOYMENT_CONFIG_LABEL);
  if (!resolvedPresent && !deploymentPresent) return undefined;
  return (
    resolvedPresent &&
    deploymentPresent &&
    labels[RESOLVED_CONFIG_LABEL] === binding.resolvedConfigSha256 &&
    labels[DEPLOYMENT_CONFIG_LABEL] === binding.deploymentConfigSha256
  );
}

function legacyConfigurationMatches(binding, projection) {
  const { container, applicationImage, postgresImage, volume } = projection;
  const labels = container.Config?.Labels;
  const applicationLabels = applicationImage.Labels;
  const expectedApplicationTag = `${LEGACY_APPLICATION_REPOSITORY}:${LEGACY_SOURCE_SHA}`;
  return (
    binding.sourceSha === LEGACY_SOURCE_SHA &&
    binding.applicationImageRef.startsWith(
      `${LEGACY_APPLICATION_REPOSITORY}${IMMUTABLE_DIGEST_SEPARATOR}`,
    ) &&
    binding.postgresImageRef.startsWith(
      `${LEGACY_POSTGRES_REPOSITORY}${IMMUTABLE_DIGEST_SEPARATOR}`,
    ) &&
    binding.networkName === LEGACY_COMPOSE_PROJECT &&
    binding.volumeName === LEGACY_POSTGRES_VOLUME &&
    binding.resolvedConfigSha256 === LEGACY_CONFIG_SURROGATE &&
    binding.deploymentConfigSha256 === LEGACY_CONFIG_SURROGATE &&
    labels?.["com.docker.compose.project"] === LEGACY_COMPOSE_PROJECT &&
    labels?.["com.docker.compose.service"] === "postgres" &&
    labels?.["com.docker.compose.oneoff"] === "False" &&
    labels?.["com.docker.compose.container-number"] === "1" &&
    labels?.["com.docker.compose.config-hash"] ===
      LEGACY_POSTGRES_SERVICE_CONFIG_HASH &&
    labels?.["coolify.managed"] === "true" &&
    labels?.["coolify.applicationId"] === "5" &&
    !hasOwnLabel(applicationLabels, SOURCE_SHA_LABEL) &&
    Array.isArray(applicationImage.RepoTags) &&
    applicationImage.RepoTags.length === 1 &&
    applicationImage.RepoTags[0] === expectedApplicationTag &&
    container.Config?.Image === LEGACY_POSTGRES_CONFIG_IMAGE &&
    taggedRepository(container.Config.Image) === LEGACY_POSTGRES_REPOSITORY &&
    Array.isArray(postgresImage.RepoTags) &&
    postgresImage.RepoTags.length === 1 &&
    postgresImage.RepoTags[0] === LEGACY_POSTGRES_CONFIG_IMAGE &&
    volume.Labels?.["com.docker.compose.project"] === LEGACY_COMPOSE_PROJECT &&
    volume.Labels?.["com.docker.compose.volume"] === LEGACY_POSTGRES_VOLUME
  );
}

function runtimeIdentityMode(binding, projection) {
  const modern = modernConfigurationMatches(
    binding,
    projection.container.Config?.Labels,
  );
  if (modern !== undefined) return modern ? "modern" : undefined;
  return legacyConfigurationMatches(binding, projection) ? "legacy" : undefined;
}

function postgresConfigImageMatches(binding, container, postgresImage, mode) {
  const configured = container.Config?.Image;
  if (mode === "modern") return configured === binding.postgresImageRef;
  return (
    mode === "legacy" &&
    configured === LEGACY_POSTGRES_CONFIG_IMAGE &&
    taggedRepository(configured) ===
      immutableRepository(binding.postgresImageRef, "postgresImageRef") &&
    Array.isArray(postgresImage.RepoTags) &&
    postgresImage.RepoTags.length === 1 &&
    postgresImage.RepoTags[0] === configured
  );
}

function applicationSourceMatches(binding, applicationImage, mode) {
  const labels = applicationImage.Labels;
  if (mode === "modern") {
    return (
      hasOwnLabel(labels, SOURCE_SHA_LABEL) &&
      labels[SOURCE_SHA_LABEL] === binding.sourceSha
    );
  }
  if (mode !== "legacy" || hasOwnLabel(labels, SOURCE_SHA_LABEL)) return false;
  const repository = immutableRepository(
    binding.applicationImageRef,
    "applicationImageRef",
  );
  const expectedTag = `${repository}:${binding.sourceSha}`;
  if (
    !Array.isArray(applicationImage.RepoTags) ||
    !applicationImage.RepoTags.includes(expectedTag)
  ) {
    return false;
  }
  const sourceTags = applicationImage.RepoTags.filter((tag) => {
    if (typeof tag !== "string" || !tag.startsWith(`${repository}:`)) {
      return false;
    }
    return /^[0-9a-f]{40}$/.test(tag.slice(repository.length + 1));
  });
  return sourceTags.length === 1 && sourceTags[0] === expectedTag;
}

function validateProjection(binding, projection) {
  const { container, postgresImage, applicationImage, volume, network } =
    projection;
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const networks = container.NetworkSettings?.Networks ?? {};
  const postgresDataMounts = mounts.filter(
    (mount) => mount?.Destination === POSTGRES_DATA_DESTINATION,
  );
  const networkNames =
    networks && typeof networks === "object" && !Array.isArray(networks)
      ? Object.keys(networks)
      : [];
  const networkContainerIds =
    network.Containers &&
    typeof network.Containers === "object" &&
    !Array.isArray(network.Containers)
      ? Object.keys(network.Containers).sort()
      : [];
  const mode = runtimeIdentityMode(binding, projection);
  if (
    mode === undefined ||
    container.Id !== binding.containerId ||
    container.Image !== binding.postgresImageId ||
    !postgresConfigImageMatches(binding, container, postgresImage, mode) ||
    container.State?.Status !== "running" ||
    postgresDataMounts.length !== 1 ||
    postgresDataMounts[0]?.Type !== "volume" ||
    postgresDataMounts[0]?.Name !== binding.volumeName ||
    postgresDataMounts[0]?.RW !== true ||
    networkNames.length !== 1 ||
    networkNames[0] !== binding.networkName ||
    networks[binding.networkName]?.NetworkID !== binding.networkId ||
    postgresImage.Id !== binding.postgresImageId ||
    !Array.isArray(postgresImage.RepoDigests) ||
    !postgresImage.RepoDigests.includes(binding.postgresImageRef) ||
    typeof applicationImage.Id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(applicationImage.Id) ||
    !Array.isArray(applicationImage.RepoDigests) ||
    !applicationImage.RepoDigests.includes(binding.applicationImageRef) ||
    !applicationSourceMatches(binding, applicationImage, mode) ||
    volume.Name !== binding.volumeName ||
    exactTimestamp(volume.CreatedAt, "volume.CreatedAt") !==
      binding.volumeCreatedAt ||
    labelsDigest(volume.Labels) !== binding.volumeLabelsSha256 ||
    network.Id !== binding.networkId ||
    network.Name !== binding.networkName ||
    canonicalProjection(networkContainerIds) !==
      canonicalProjection([binding.containerId])
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
      "Docker container, image, volume or network identity differs from the reviewed runtime binding.",
    );
  }
}

function canonicalProjection(value) {
  return canonicalProductionExact0096BackupJson(value);
}

export function createProductionMigrationDockerRuntimeAuthority({
  execFile: run = defaultExecFile,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (
    typeof run !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DEPENDENCY_INVALID",
      "Runtime authority dependencies are outside the reviewed bounds.",
    );
  }

  async function inspect(args, field, signal) {
    throwIfAborted(signal);
    let output;
    try {
      output = await run("docker", args, { timeoutMs, signal });
    } catch (error) {
      throwIfAborted(signal);
      fail(
        "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INSPECT_FAILED",
        `${field} failed closed.`,
        { cause: error },
      );
    }
    throwIfAborted(signal);
    return parseProjection(output, field);
  }

  async function observeOnce(binding, signal) {
    return Object.freeze({
      container: await inspect(
        [
          "container",
          "inspect",
          "--format",
          CONTAINER_PROJECTION,
          binding.containerId,
        ],
        "container inspect",
        signal,
      ),
      postgresImage: await inspect(
        [
          "image",
          "inspect",
          "--format",
          IMAGE_PROJECTION,
          binding.postgresImageRef,
        ],
        "PostgreSQL image inspect",
        signal,
      ),
      applicationImage: await inspect(
        [
          "image",
          "inspect",
          "--format",
          IMAGE_PROJECTION,
          binding.applicationImageRef,
        ],
        "application image inspect",
        signal,
      ),
      volume: await inspect(
        [
          "volume",
          "inspect",
          "--format",
          VOLUME_PROJECTION,
          binding.volumeName,
        ],
        "volume inspect",
        signal,
      ),
      network: await inspect(
        [
          "network",
          "inspect",
          "--format",
          NETWORK_PROJECTION,
          binding.networkName,
        ],
        "network inspect",
        signal,
      ),
    });
  }

  return Object.freeze({
    async observeProductionMigrationRuntime(input) {
      const request = exactObject(
        input,
        ["expectedRuntimeBindingCanonical", "signal"],
        "runtimeAuthority.request",
      );
      const { signal } = request;
      throwIfAborted(signal);
      let parsed;
      try {
        parsed = JSON.parse(request.expectedRuntimeBindingCanonical);
      } catch (error) {
        fail(
          "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INPUT_INVALID",
          "Expected runtime binding must be exact canonical JSON.",
          { cause: error },
        );
      }
      const binding = validateProductionImmutableRuntimeBinding(
        parsed,
        "runtimeAuthority.expectedRuntimeBinding",
      );
      if (
        canonicalProductionExact0096BackupJson(binding) !==
        request.expectedRuntimeBindingCanonical
      ) {
        fail(
          "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_INPUT_INVALID",
          "Expected runtime binding bytes are not canonical.",
        );
      }
      const first = await observeOnce(binding, signal);
      validateProjection(binding, first);
      const second = await observeOnce(binding, signal);
      validateProjection(binding, second);
      if (canonicalProjection(first) !== canonicalProjection(second)) {
        fail(
          "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
          "Docker runtime projection changed during the bounded observation.",
        );
      }
      const observedAt = now();
      if (
        !(observedAt instanceof Date) ||
        !Number.isFinite(observedAt.getTime())
      ) {
        fail(
          "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_CLOCK_INVALID",
          "Runtime authority clock is invalid.",
        );
      }
      return createProductionMigrationRuntimeObservation({
        runtimeBinding: binding,
        observedAt: observedAt.toISOString(),
      });
    },
  });
}

const productionRuntimeAuthority =
  createProductionMigrationDockerRuntimeAuthority();

export const observeProductionMigrationRuntime =
  productionRuntimeAuthority.observeProductionMigrationRuntime;
