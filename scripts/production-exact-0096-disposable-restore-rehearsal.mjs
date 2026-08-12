import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const CONFIRMATION =
  "RUN_LOCAL_SYNTHETIC_EXACT_0096_PG16_RESTORE_REHEARSAL_NO_PRODUCTION";
const NETWORK = "slb-exact0096-rehearsal-network";
const VOLUME = "slb-exact0096-rehearsal-volume";
const SOURCE = "slb-exact0096-rehearsal-source";
const RESTORE = "slb-exact0096-rehearsal-postgres";
const IMAGE_TAG = "postgres:16-alpine";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_STDERR_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const POSTGRES_CAPABILITIES = Object.freeze([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETGID",
  "SETUID",
]);
const MVE1_AAD = Buffer.from("modvolt:exact-0096:local-rehearsal", "utf8");

function syntheticMve1RoundTrip(plaintext) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(MVE1_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const header = Buffer.from(
      JSON.stringify({
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
      }),
      "utf8",
    );
    const prefix = Buffer.alloc(8);
    Buffer.from("MVE1", "ascii").copy(prefix);
    prefix.writeUInt32BE(header.length, 4);
    const envelope = Buffer.concat([prefix, header, ciphertext]);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(MVE1_AAD);
    decipher.setAuthTag(tag);
    const authenticated = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return Object.freeze({
      authenticated,
      envelopeBytes: envelope.length,
      envelopeSha256: `sha256:${createHash("sha256").update(envelope).digest("hex")}`,
    });
  } finally {
    key.fill(0);
  }
}

export class ProductionExact0096RehearsalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096RehearsalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionExact0096RehearsalError(code, message);
}

function boundedStderr(child) {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr);
    if (remaining > 0) {
      stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
    }
  });
  return () => stderr;
}

async function waitChild(child, stderr) {
  const [code] = await once(child, "close");
  return { code: Number(code ?? -1), stderr: stderr() };
}

function fixedContainerArgs({ name, network, imageId, database, data }) {
  const capabilities = POSTGRES_CAPABILITIES.flatMap((capability) => [
    "--cap-add",
    capability,
  ]);
  return [
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--cpus",
    "1",
    "--memory",
    "1536m",
    "--pids-limit",
    "256",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--tmpfs",
    "/var/run/postgresql:rw,nosuid,nodev,size=16m",
    "--cap-drop",
    "ALL",
    ...capabilities,
    "--security-opt",
    "no-new-privileges=true",
    data.kind === "tmpfs" ? "--tmpfs" : "--mount",
    data.kind === "tmpfs"
      ? "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m"
      : `type=volume,source=${data.volume},target=/var/lib/postgresql/data,volume-nocopy`,
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    "POSTGRES_USER=synthetic",
    imageId,
  ];
}

function exactNames(output) {
  return new Set(
    output
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export async function runProductionExact0096DisposableRestoreRehearsal(
  confirmation,
  dependencies = {},
) {
  if (confirmation !== CONFIRMATION) {
    fail(
      "PRODUCTION_BACKUP_REHEARSAL_DARK",
      "Exact local synthetic rehearsal confirmation is required.",
    );
  }
  const run = dependencies.execFile ?? execFile;
  const spawnProcess = dependencies.spawn ?? spawn;
  const now = dependencies.now ?? (() => new Date());
  const command = async (args, { allowFailure = false } = {}) => {
    try {
      const result = await run("docker", args, {
        encoding: "utf8",
        maxBuffer: 512 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      return String(result.stdout ?? "").trim();
    } catch (error) {
      if (allowFailure) return "";
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_DOCKER_FAILED",
        `Fixed Docker operation ${args[0]} ${args[1] ?? ""} failed.`,
      );
    }
  };

  const imageId = await command([
    "image",
    "inspect",
    IMAGE_TAG,
    "--format",
    "{{.Id}}",
  ]);
  if (!IMAGE_ID.test(imageId)) {
    fail(
      "PRODUCTION_BACKUP_REHEARSAL_IMAGE_INVALID",
      "A local immutable PostgreSQL 16 image ID is required; no pull is allowed.",
    );
  }
  const existingContainers = exactNames(
    await command(["ps", "--all", "--format", "{{.Names}}"]),
  );
  const existingNetworks = exactNames(
    await command(["network", "ls", "--format", "{{.Name}}"]),
  );
  const existingVolumes = exactNames(
    await command(["volume", "ls", "--format", "{{.Name}}"]),
  );
  if (
    existingContainers.has(SOURCE) ||
    existingContainers.has(RESTORE) ||
    existingNetworks.has(NETWORK) ||
    existingVolumes.has(VOLUME)
  ) {
    fail(
      "PRODUCTION_BACKUP_REHEARSAL_PREEXISTING_RESOURCE",
      "Exact rehearsal resources must not pre-exist.",
    );
  }

  let networkCreated = false;
  let volumeCreated = false;
  let sourceCreated = false;
  let restoreCreated = false;
  let result;
  try {
    await command([
      "network",
      "create",
      "--internal",
      "--label",
      "cz.modvolt.rehearsal=true",
      NETWORK,
    ]);
    networkCreated = true;
    await command([
      "volume",
      "create",
      "--label",
      "cz.modvolt.rehearsal=true",
      VOLUME,
    ]);
    volumeCreated = true;
    await command([
      "run",
      ...fixedContainerArgs({
        name: SOURCE,
        network: NETWORK,
        imageId,
        database: "synthetic_source",
        data: { kind: "tmpfs" },
      }),
    ]);
    sourceCreated = true;
    await command([
      "run",
      ...fixedContainerArgs({
        name: RESTORE,
        network: NETWORK,
        imageId,
        database: "synthetic_restore",
        data: { kind: "volume", volume: VOLUME },
      }),
    ]);
    restoreCreated = true;

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const sourceReady = await command(
        [
          "exec",
          SOURCE,
          "pg_isready",
          "--username",
          "synthetic",
          "--dbname",
          "synthetic_source",
        ],
        { allowFailure: true },
      );
      const restoreReady = await command(
        [
          "exec",
          RESTORE,
          "pg_isready",
          "--username",
          "synthetic",
          "--dbname",
          "synthetic_restore",
        ],
        { allowFailure: true },
      );
      if (
        sourceReady.includes("accepting connections") &&
        restoreReady.includes("accepting connections")
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_NOT_READY",
        "Synthetic PostgreSQL containers did not become ready.",
      );
    }
    await command([
      "exec",
      SOURCE,
      "psql",
      "--username",
      "synthetic",
      "--dbname",
      "synthetic_source",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      "CREATE TABLE rehearsal(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO rehearsal VALUES (1, 'exact-0096');",
    ]);

    const dump = spawnProcess(
      "docker",
      [
        "exec",
        SOURCE,
        "pg_dump",
        "--username",
        "synthetic",
        "--dbname",
        "synthetic_source",
        "--format=custom",
        "--no-owner",
        "--no-acl",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    if (!dump.stdout || !dump.stderr) {
      dump.kill("SIGTERM");
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_STREAM_INVALID",
        "Binary-safe dump pipe is unavailable.",
      );
    }
    const dumpStderr = boundedStderr(dump);
    const dumpDone = waitChild(dump, dumpStderr);
    const chunks = [];
    let dumpBytes = 0;
    dump.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      dumpBytes += bytes.length;
      chunks.push(bytes);
      if (dumpBytes > 1024 * 1024) {
        dump.kill("SIGTERM");
      }
    });
    await once(dump.stdout, "end");
    const dumpExit = await dumpDone;
    if (
      dumpExit.code !== 0 ||
      dumpExit.stderr !== "" ||
      dumpBytes < 1024 ||
      dumpBytes > 1024 * 1024
    ) {
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_RESTORE_FAILED",
        "Synthetic binary-stream custom dump/restore did not finish exactly.",
      );
    }
    const mve1 = syntheticMve1RoundTrip(Buffer.concat(chunks));
    chunks.length = 0;
    const restore = spawnProcess(
      "docker",
      [
        "exec",
        "--interactive",
        RESTORE,
        "pg_restore",
        "--username",
        "synthetic",
        "--dbname",
        "synthetic_restore",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
      ],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
    );
    if (!restore.stdin || !restore.stderr) {
      restore.kill("SIGTERM");
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_STREAM_INVALID",
        "Binary-safe restore pipe is unavailable.",
      );
    }
    const restoreStderr = boundedStderr(restore);
    const restoreDone = waitChild(restore, restoreStderr);
    restore.stdin.end(mve1.authenticated);
    const restoreExit = await restoreDone;
    mve1.authenticated.fill(0);
    if (restoreExit.code !== 0 || restoreExit.stderr !== "") {
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_RESTORE_FAILED",
        "Authenticated local MVE1 plaintext did not restore exactly.",
      );
    }
    const parity = await command([
      "exec",
      RESTORE,
      "psql",
      "--username",
      "synthetic",
      "--dbname",
      "synthetic_restore",
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT value FROM rehearsal WHERE id=1",
    ]);
    const networkInspect = JSON.parse(
      await command(["network", "inspect", NETWORK]),
    );
    const restoreInspect = JSON.parse(
      await command(["container", "inspect", RESTORE]),
    );
    const binding = restoreInspect[0];
    if (
      parity !== "exact-0096" ||
      networkInspect?.[0]?.Internal !== true ||
      binding?.Config?.Image !== imageId ||
      binding?.HostConfig?.NetworkMode !== NETWORK ||
      binding?.HostConfig?.Memory !== 1536 * 1024 * 1024 ||
      binding?.HostConfig?.NanoCpus !== 1_000_000_000 ||
      binding?.HostConfig?.PidsLimit !== 256 ||
      Object.keys(binding?.HostConfig?.PortBindings ?? {}).length !== 0
    ) {
      fail(
        "PRODUCTION_BACKUP_REHEARSAL_PARITY_INVALID",
        "Synthetic parity or Docker isolation binding differs.",
      );
    }
    result = Object.freeze({
      schemaVersion: "site-logbook.production-exact-0096-local-rehearsal/v1",
      completedAt: now().toISOString(),
      imageId,
      dumpBytes,
      mve1EnvelopeBytes: mve1.envelopeBytes,
      mve1EnvelopeSha256: mve1.envelopeSha256,
      parity,
      internalNetwork: true,
      publishedPorts: 0,
      cpuLimit: 1,
      memoryBytes: 1536 * 1024 * 1024,
      pidsLimit: 256,
      productionAccess: false,
      externalNetworkAccess: false,
    });
  } finally {
    if (restoreCreated)
      await command(["container", "rm", "--force", RESTORE], {
        allowFailure: true,
      });
    if (sourceCreated)
      await command(["container", "rm", "--force", SOURCE], {
        allowFailure: true,
      });
    if (volumeCreated)
      await command(["volume", "rm", VOLUME], { allowFailure: true });
    if (networkCreated)
      await command(["network", "rm", NETWORK], { allowFailure: true });
  }

  const remainingContainers = exactNames(
    await command(["ps", "--all", "--format", "{{.Names}}"]),
  );
  const remainingNetworks = exactNames(
    await command(["network", "ls", "--format", "{{.Name}}"]),
  );
  const remainingVolumes = exactNames(
    await command(["volume", "ls", "--format", "{{.Name}}"]),
  );
  if (
    remainingContainers.has(SOURCE) ||
    remainingContainers.has(RESTORE) ||
    remainingNetworks.has(NETWORK) ||
    remainingVolumes.has(VOLUME)
  ) {
    fail(
      "PRODUCTION_BACKUP_REHEARSAL_CLEANUP_FAILED",
      "Exact synthetic Docker resources remain after cleanup.",
    );
  }
  return Object.freeze({ ...result, cleanupVerified: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await runProductionExact0096DisposableRestoreRehearsal(
      process.argv[2],
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ProductionExact0096RehearsalError
        ? error.code
        : "PRODUCTION_BACKUP_REHEARSAL_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
