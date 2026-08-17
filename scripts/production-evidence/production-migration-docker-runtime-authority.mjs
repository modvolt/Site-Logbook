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

const CONTAINER_PROJECTION = [
  '{"Id":{{json .Id}},"Image":{{json .Image}},',
  '"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},',
  '"State":{"Status":{{json .State.Status}}},',
  '"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}',
].join("");
const IMAGE_PROJECTION =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Labels":{{json .Config.Labels}}}';
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
  const milliseconds = Date.parse(String(value));
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_OUTPUT_INVALID",
      `${field} is not an exact canonical timestamp.`,
    );
  }
  return value;
}

function labelsDigest(labels) {
  return productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(labels ?? {}),
  );
}

function requireLabel(labels, name, expected) {
  if (!labels || labels[name] !== expected) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
      `Required immutable label ${name} differs from the reviewed binding.`,
    );
  }
}

function validateProjection(binding, projection) {
  const { container, postgresImage, applicationImage, volume, network } =
    projection;
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const networks = container.NetworkSettings?.Networks ?? {};
  if (
    container.Id !== binding.containerId ||
    container.Image !== binding.postgresImageId ||
    container.Config?.Image !== binding.postgresImageRef ||
    container.State?.Status !== "running" ||
    !mounts.some(
      (mount) => mount?.Type === "volume" && mount?.Name === binding.volumeName,
    ) ||
    networks[binding.networkName]?.NetworkID !== binding.networkId ||
    postgresImage.Id !== binding.postgresImageId ||
    !Array.isArray(postgresImage.RepoDigests) ||
    !postgresImage.RepoDigests.includes(binding.postgresImageRef) ||
    applicationImage.Id === undefined ||
    !Array.isArray(applicationImage.RepoDigests) ||
    !applicationImage.RepoDigests.includes(binding.applicationImageRef) ||
    volume.Name !== binding.volumeName ||
    exactTimestamp(volume.CreatedAt, "volume.CreatedAt") !==
      binding.volumeCreatedAt ||
    labelsDigest(volume.Labels) !== binding.volumeLabelsSha256 ||
    network.Id !== binding.networkId ||
    network.Name !== binding.networkName ||
    !Object.hasOwn(network.Containers ?? {}, binding.containerId)
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
      "Docker container, image, volume or network identity differs from the reviewed runtime binding.",
    );
  }
  requireLabel(applicationImage.Labels, SOURCE_SHA_LABEL, binding.sourceSha);
  requireLabel(
    container.Config?.Labels,
    RESOLVED_CONFIG_LABEL,
    binding.resolvedConfigSha256,
  );
  requireLabel(
    container.Config?.Labels,
    DEPLOYMENT_CONFIG_LABEL,
    binding.deploymentConfigSha256,
  );
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
