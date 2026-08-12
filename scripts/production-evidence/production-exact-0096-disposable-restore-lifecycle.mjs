import { spawn as spawnProcess } from "node:child_process";
import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
} from "./production-exact-0096-backup-contract.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST_IMAGE = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;
const RESOURCE = /^slb-exact0096-[a-f0-9]{16}-(?:network|volume|postgres)$/;
const DATABASE = /^site_logbook_restore_[a-f0-9]{16}$/;
const LABEL = "cz.modvolt.site-logbook.production-exact-0096-restore";
const MAX_STDERR_BYTES = 64 * 1024;

export class ProductionExact0096DisposableRestoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096DisposableRestoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionExact0096DisposableRestoreError(code, message);
}

function exactConfig(config) {
  const keys = [
    "activated",
    "executorContainerId",
    "executorImageRef",
    "invocationId",
    "postgresImageRef",
    "sourceContainerId",
    "sourceNetworkId",
    "sourceVolumeName",
    "timeoutMs",
  ];
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    JSON.stringify(Object.keys(config).sort()) !==
      JSON.stringify(keys.sort()) ||
    config.activated !== true
  ) {
    fail(
      "PRODUCTION_BACKUP_RESTORE_LIFECYCLE_DARK",
      "Disposable restore lifecycle requires one exact reviewed activation object.",
    );
  }
  if (
    !HEX64.test(config.invocationId) ||
    /^0{64}$/.test(config.invocationId) ||
    !HEX64.test(config.sourceContainerId) ||
    !HEX64.test(config.executorContainerId) ||
    config.executorContainerId === config.sourceContainerId ||
    !HEX64.test(config.sourceNetworkId) ||
    !config.sourceVolumeName ||
    !DIGEST_IMAGE.test(config.postgresImageRef) ||
    !DIGEST_IMAGE.test(config.executorImageRef) ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 10_000 ||
    config.timeoutMs > 15 * 60_000
  ) {
    fail(
      "PRODUCTION_BACKUP_RESTORE_LIFECYCLE_INVALID",
      "Restore identity, immutable images, source exclusions, or timeout are invalid.",
    );
  }
  const suffix = config.invocationId.slice(0, 16);
  return Object.freeze({
    ...config,
    containerName: `slb-exact0096-${suffix}-postgres`,
    networkName: `slb-exact0096-${suffix}-network`,
    volumeName: `slb-exact0096-${suffix}-volume`,
    databaseName: `site_logbook_restore_${suffix}`,
    databaseUser: "site_logbook_restore",
  });
}

function commandFailure(operation, result) {
  if (result.code === 0 && result.stderr === "") return;
  fail(
    "PRODUCTION_BACKUP_RESTORE_DOCKER_FAILED",
    `${operation} failed without exposing command output.`,
  );
}

async function runDocker(run, args, timeoutMs) {
  const result = await run("docker", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const normalized = {
    code: Number(result.code ?? 0),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
  commandFailure(args.slice(0, 2).join(" "), normalized);
  return normalized.stdout.trim();
}

function exactInspect(raw, field) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_BACKUP_RESTORE_INSPECT_INVALID", `${field} is not JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) {
    fail("PRODUCTION_BACKUP_RESTORE_INSPECT_INVALID", `${field} differs.`);
  }
  return parsed[0];
}

function waitForChild(child, timeoutMs) {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr);
    if (remaining > 0) stderr += Buffer.from(chunk).subarray(0, remaining);
  });
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
      reject(
        new ProductionExact0096DisposableRestoreError(
          "PRODUCTION_BACKUP_RESTORE_TIMEOUT",
          "pg_restore exceeded the reviewed timeout.",
        ),
      );
    }, timeoutMs);
    timer.unref();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function createProductionExact0096DisposableRestoreLifecycle(
  rawConfig,
  dependencies = {},
) {
  const config = exactConfig(rawConfig);
  const run = dependencies.execFile;
  const spawn = dependencies.spawn ?? spawnProcess;
  const now = dependencies.now ?? (() => new Date());
  if (typeof run !== "function") {
    fail(
      "PRODUCTION_BACKUP_RESTORE_LIFECYCLE_INVALID",
      "A fixed-argv Docker execFile implementation is required.",
    );
  }
  for (const name of [
    config.containerName,
    config.networkName,
    config.volumeName,
  ]) {
    if (!RESOURCE.test(name)) {
      fail(
        "PRODUCTION_BACKUP_RESTORE_LIFECYCLE_INVALID",
        "Resource name differs.",
      );
    }
  }
  if (!DATABASE.test(config.databaseName)) {
    fail(
      "PRODUCTION_BACKUP_RESTORE_LIFECYCLE_INVALID",
      "Database name differs.",
    );
  }

  let networkCreated = false;
  let volumeCreated = false;
  let containerCreated = false;
  let restoreCompleted = false;
  let closed = false;
  const startedAt = now().toISOString();
  try {
    await runDocker(
      run,
      [
        "network",
        "create",
        "--internal",
        "--label",
        `${LABEL}=true`,
        "--label",
        `cz.modvolt.invocation=${config.invocationId}`,
        config.networkName,
      ],
      config.timeoutMs,
    );
    networkCreated = true;
    await runDocker(
      run,
      [
        "volume",
        "create",
        "--label",
        `${LABEL}=true`,
        "--label",
        `cz.modvolt.invocation=${config.invocationId}`,
        config.volumeName,
      ],
      config.timeoutMs,
    );
    volumeCreated = true;
    await runDocker(
      run,
      [
        "container",
        "create",
        "--name",
        config.containerName,
        "--network",
        config.networkName,
        "--mount",
        `type=volume,source=${config.volumeName},target=/var/lib/postgresql/data,volume-nocopy`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--tmpfs",
        "/var/run/postgresql:rw,nosuid,nodev,size=16m",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETUID",
        "--security-opt",
        "no-new-privileges=true",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "--env",
        `POSTGRES_DB=${config.databaseName}`,
        "--env",
        `POSTGRES_USER=${config.databaseUser}`,
        config.postgresImageRef,
      ],
      config.timeoutMs,
    );
    containerCreated = true;
    await runDocker(
      run,
      ["container", "start", config.containerName],
      config.timeoutMs,
    );
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await run(
        "docker",
        [
          "container",
          "exec",
          config.containerName,
          "pg_isready",
          "--dbname",
          config.databaseName,
          "--username",
          config.databaseUser,
        ],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: Math.min(config.timeoutMs, 10_000),
          windowsHide: true,
        },
      );
      if (Number(result.code ?? 0) === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      fail(
        "PRODUCTION_BACKUP_RESTORE_NOT_READY",
        "Disposable PostgreSQL did not become ready.",
      );
    }

    const containerInspect = exactInspect(
      await runDocker(
        run,
        ["container", "inspect", config.containerName],
        config.timeoutMs,
      ),
      "container",
    );
    const networkInspect = exactInspect(
      await runDocker(
        run,
        ["network", "inspect", config.networkName],
        config.timeoutMs,
      ),
      "network",
    );
    const volumeInspect = exactInspect(
      await runDocker(
        run,
        ["volume", "inspect", config.volumeName],
        config.timeoutMs,
      ),
      "volume",
    );
    const executorInspect = exactInspect(
      await runDocker(
        run,
        ["container", "inspect", config.executorContainerId],
        config.timeoutMs,
      ),
      "executor container",
    );
    const executorImageInspect = exactInspect(
      await runDocker(
        run,
        ["image", "inspect", config.executorImageRef],
        config.timeoutMs,
      ),
      "executor image",
    );
    const postgresImageInspect = exactInspect(
      await runDocker(
        run,
        ["image", "inspect", config.postgresImageRef],
        config.timeoutMs,
      ),
      "PostgreSQL image",
    );
    if (
      !HEX64.test(String(containerInspect.Id ?? "")) ||
      !HEX64.test(String(networkInspect.Id ?? "")) ||
      containerInspect.Id === config.sourceContainerId ||
      networkInspect.Id === config.sourceNetworkId ||
      volumeInspect.Name !== config.volumeName ||
      volumeInspect.Name === config.sourceVolumeName ||
      containerInspect.Config?.Image !== config.postgresImageRef ||
      executorInspect.Id !== config.executorContainerId ||
      executorInspect.Config?.Image !== config.executorImageRef ||
      !Array.isArray(executorImageInspect.RepoDigests) ||
      !executorImageInspect.RepoDigests.includes(config.executorImageRef) ||
      !Array.isArray(postgresImageInspect.RepoDigests) ||
      !postgresImageInspect.RepoDigests.includes(config.postgresImageRef) ||
      containerInspect.Image !== postgresImageInspect.Id ||
      containerInspect.HostConfig?.NetworkMode !== config.networkName ||
      networkInspect.Internal !== true
    ) {
      fail(
        "PRODUCTION_BACKUP_RESTORE_ISOLATION_INVALID",
        "Disposable resources are not distinct, internal, or immutable-image-bound.",
      );
    }
    const runtimeBinding = Object.freeze({
      executorImageRef: config.executorImageRef,
      containerId: containerInspect.Id,
      postgresImageRef: config.postgresImageRef,
      postgresImageId: String(containerInspect.Image),
      volumeName: config.volumeName,
      volumeCreatedAt: new Date(volumeInspect.CreatedAt).toISOString(),
      volumeLabelsSha256: productionExact0096BackupSha256(
        canonicalProductionExact0096BackupJson(volumeInspect.Labels ?? {}),
      ),
      networkName: config.networkName,
      networkId: networkInspect.Id,
      resolvedConfigSha256: productionExact0096BackupSha256(
        canonicalProductionExact0096BackupJson({
          databaseName: config.databaseName,
          databaseUser: config.databaseUser,
          internalNetwork: true,
          noPublishedPorts: true,
          postgresImageRef: config.postgresImageRef,
          productionSourceAttached: false,
          readOnlyRoot: true,
        }),
      ),
    });

    return Object.freeze({
      restoreId: `prod-restore-${config.invocationId.slice(0, 32)}`,
      startedAt,
      database: Object.freeze({
        name: config.databaseName,
        user: config.databaseUser,
        serverVersionMajor: 16,
      }),
      runtimeBinding,
      createPgRestoreDestination() {
        if (closed || restoreCompleted) {
          fail(
            "PRODUCTION_BACKUP_RESTORE_STATE_INVALID",
            "Restore destination is unavailable.",
          );
        }
        const child = spawn(
          "docker",
          [
            "container",
            "exec",
            "--interactive",
            config.containerName,
            "pg_restore",
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            "--dbname",
            config.databaseName,
            "--username",
            config.databaseUser,
          ],
          { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
        );
        if (!child.stdin) {
          fail(
            "PRODUCTION_BACKUP_RESTORE_DOCKER_FAILED",
            "pg_restore stdin is unavailable.",
          );
        }
        const completion = waitForChild(child, config.timeoutMs).then(
          (result) => {
            if (result.code !== 0) {
              fail(
                "PRODUCTION_BACKUP_PG_RESTORE_FAILED",
                "pg_restore exited non-zero.",
              );
            }
            restoreCompleted = true;
            return Object.freeze({
              exitCode: 0,
              completedAt: now().toISOString(),
            });
          },
        );
        return Object.freeze({ destination: child.stdin, completion });
      },
      async close() {
        if (closed) return;
        closed = true;
        const errors = [];
        if (containerCreated) {
          try {
            await runDocker(
              run,
              ["container", "rm", "--force", config.containerName],
              config.timeoutMs,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (volumeCreated) {
          try {
            await runDocker(
              run,
              ["volume", "rm", config.volumeName],
              config.timeoutMs,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (networkCreated) {
          try {
            await runDocker(
              run,
              ["network", "rm", config.networkName],
              config.timeoutMs,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          fail(
            "PRODUCTION_BACKUP_RESTORE_CLEANUP_FAILED",
            "Disposable cleanup was incomplete.",
          );
        }
      },
    });
  } catch (error) {
    if (containerCreated)
      await run(
        "docker",
        ["container", "rm", "--force", config.containerName],
        { windowsHide: true },
      ).catch(() => undefined);
    if (volumeCreated)
      await run("docker", ["volume", "rm", config.volumeName], {
        windowsHide: true,
      }).catch(() => undefined);
    if (networkCreated)
      await run("docker", ["network", "rm", config.networkName], {
        windowsHide: true,
      }).catch(() => undefined);
    throw error;
  }
}
