#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProductionHostAttestation,
  createProductionTargetEvidence,
  deriveProductionReleaseBinding,
  verifyDetachedHostAttestation,
} from "./host-attestation-contract.mjs";
import {
  PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION,
  collectCoolifyReadOnlyExport,
} from "./coolify-readonly-observer.mjs";

const MAX_INPUT_BYTES = 256 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/production-evidence/run-production-host-evidence.mjs observe --request FILE --coolify-request FILE --journal FILE --image-provenance FILE --image-provenance-signature FILE --coolify-export-out FILE --docker-export-out FILE --postgres-export-out FILE --target-out FILE",
    "  node scripts/production-evidence/run-production-host-evidence.mjs attest --request FILE --coolify-request FILE --journal FILE --image-provenance FILE --image-provenance-signature FILE --target FILE --intent-evidence FILE --execution-evidence FILE --steady-evidence FILE --release-evidence FILE --activation-approval FILE --key-id ID --attestation-out FILE",
    "  node scripts/production-evidence/run-production-host-evidence.mjs verify --attestation FILE --signature FILE --public-key FILE --public-key-sha256 DIGEST --key-id ID --target FILE --intent-evidence FILE --execution-evidence FILE --steady-evidence FILE --release-evidence FILE --activation-approval FILE",
    "",
    "The runner obtains Coolify, Docker and PostgreSQL observations itself. It does not accept caller-built host exports or a private key.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["observe", "attest", "verify"].includes(command)) {
    throw new Error(
      "PRODUCTION_HOST_USAGE_INVALID: expected observe, attest or verify.",
    );
  }
  if (rest.length % 2 !== 0) {
    throw new Error(
      "PRODUCTION_HOST_USAGE_INVALID: every option needs a value.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!option.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("PRODUCTION_HOST_USAGE_INVALID: malformed option.");
    }
    const key = option.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new Error(`PRODUCTION_HOST_USAGE_INVALID: duplicate --${key}.`);
    }
    options[key] = value;
  }
  return { command, options };
}

function exactOptions(options, required) {
  const actual = Object.keys(options).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `PRODUCTION_HOST_USAGE_INVALID: expected only ${required.map((key) => `--${key}`).join(", ")}.`,
    );
  }
}

async function readBounded(path, field, encoding = "utf8") {
  const absolute = resolve(path);
  const invalid = () =>
    new Error(
      `PRODUCTION_HOST_INPUT_INVALID: ${field} is invalid or too large.`,
    );
  const sameIdentity = (left, right) =>
    left.dev === right.dev && left.ino === right.ino;
  const sameSnapshot = (left, right) =>
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;

  let pathBefore;
  try {
    pathBefore = await lstat(absolute, { bigint: true });
  } catch {
    throw invalid();
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) throw invalid();

  const noFollow = Number.isInteger(constants.O_NOFOLLOW)
    ? constants.O_NOFOLLOW
    : 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
  } catch {
    throw invalid();
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !sameIdentity(pathBefore, before) ||
      before.size === 0n ||
      before.size > BigInt(MAX_INPUT_BYTES)
    ) {
      throw invalid();
    }

    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(absolute, { bigint: true });
    } catch {
      throw invalid();
    }
    if (
      offset === 0 ||
      offset > MAX_INPUT_BYTES ||
      BigInt(offset) !== before.size ||
      !sameSnapshot(before, after) ||
      !sameSnapshot(pathBefore, pathAfter) ||
      !sameIdentity(after, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw invalid();
    }
    const content = Buffer.from(buffer.subarray(0, offset));
    return encoding === null ? content : content.toString(encoding);
  } finally {
    await handle.close();
  }
}

async function readJson(path, field) {
  const raw = await readBounded(path, field);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`PRODUCTION_HOST_INPUT_INVALID: ${field} must be JSON.`);
  }
}

function objectInput(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `PRODUCTION_HOST_INPUT_INVALID: ${field} must be an object.`,
    );
  }
  return value;
}

function exactInputKeys(value, allowed, field) {
  const object = objectInput(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...allowed].sort())
  ) {
    throw new Error(
      `PRODUCTION_HOST_INPUT_INVALID: ${field} contains an unreviewed field.`,
    );
  }
  return object;
}

async function loadPostgresObserver(dependencies = {}) {
  if (globalThis.__SITE_LOGBOOK_STATIC_HOST_OPERATOR__ === true) {
    if (!dependencies.postgresObserver) {
      throw new Error(
        "PRODUCTION_HOST_PACKAGING_INVALID: the static PostgreSQL observer is unavailable.",
      );
    }
    return dependencies.postgresObserver;
  }
  if (Object.keys(dependencies).length !== 0) {
    throw new Error(
      "PRODUCTION_HOST_PACKAGING_INVALID: injected observers require the static source-pinned build.",
    );
  }
  // Keep the developer-only TypeScript loader behind a computed URL. The
  // dedicated host bundle injects the static observer and therefore neither
  // resolves nor packages this repository-only fallback.
  const loaderUrl = new URL(
    [
      "..",
      "..",
      "lib",
      "db",
      "node_modules",
      "tsx",
      "dist",
      "esm",
      "api",
      "index.mjs",
    ].join("/"),
    import.meta.url,
  );
  const { tsImport } = await import(loaderUrl.href);
  const observerUrl = new URL(
    [
      "..",
      "..",
      "artifacts",
      "api-server",
      "src",
      "production-host-postgres-observer.ts",
    ].join("/"),
    import.meta.url,
  );
  return tsImport(observerUrl.href, import.meta.url);
}

async function collectLiveObservation(options, dependencies = {}) {
  const request = exactInputKeys(
    await readJson(options.request, "request"),
    [
      "composeProject",
      "databaseName",
      "databaseUser",
      "expectedApiImage",
      "expectedNetworkServices",
      "postgresService",
      "postgresVolumeDestination",
      "schemaFingerprintSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "request",
  );
  if (
    dependencies.expectedSourceSha !== undefined &&
    request.sourceSha !== dependencies.expectedSourceSha
  ) {
    throw new Error(
      "PRODUCTION_HOST_SOURCE_MISMATCH: request source differs from the immutable host-operator build.",
    );
  }
  const rawCoolifyRequest = objectInput(
    await readJson(options["coolify-request"], "coolifyRequest"),
    "coolifyRequest",
  );
  const coolifyKeys = Object.keys(rawCoolifyRequest).sort();
  if (
    JSON.stringify(coolifyKeys) !== JSON.stringify(["expected"]) &&
    JSON.stringify(coolifyKeys) !== JSON.stringify(["expected", "timeoutMs"])
  ) {
    throw new Error(
      "PRODUCTION_HOST_INPUT_INVALID: coolifyRequest contains an unreviewed field.",
    );
  }
  const expectedJournalRows = await readJson(options.journal, "journal");
  if (!Array.isArray(expectedJournalRows)) {
    throw new Error(
      "PRODUCTION_HOST_INPUT_INVALID: journal must be the reviewed row array.",
    );
  }
  const controller = new AbortController();
  const coolify = await collectCoolifyReadOnlyExport({
    confirmation: PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION,
    expected: rawCoolifyRequest.expected,
    signal: controller.signal,
    ...(rawCoolifyRequest.timeoutMs === undefined
      ? {}
      : { timeoutMs: rawCoolifyRequest.timeoutMs }),
  });
  const postgresObserver = await loadPostgresObserver(dependencies);
  const dockerAuthority =
    await postgresObserver.observeProductionHostDockerAuthority({
      confirmation:
        postgresObserver.PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION,
      composeProject: request.composeProject,
      postgresService: request.postgresService,
      expectedPostgresImage: coolify.value.deployedConfig.images.postgres,
      postgresVolumeDestination: request.postgresVolumeDestination,
      expectedNetworkServices: request.expectedNetworkServices,
      signal: controller.signal,
    });
  const postgres = await postgresObserver.collectProductionHostPostgresExport({
    confirmation:
      postgresObserver.PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION,
    databaseName: request.databaseName,
    databaseUser: request.databaseUser,
    schemaFingerprintSha256: request.schemaFingerprintSha256,
    expectedJournalRows,
    dockerAuthority,
    signal: controller.signal,
  });
  let docker;
  try {
    docker = JSON.parse(dockerAuthority.canonical);
  } catch {
    throw new Error(
      "PRODUCTION_HOST_OBSERVER_INVALID: module-issued Docker authority is not JSON.",
    );
  }
  return {
    request,
    imageProvenanceCanonical: await readBounded(
      options["image-provenance"],
      "imageProvenance",
    ),
    imageProvenanceSignature: await readBounded(
      options["image-provenance-signature"],
      "imageProvenanceSignature",
      null,
    ),
    coolify: coolify.value,
    docker,
    postgres: postgres.value,
    canonical: Object.freeze({
      coolify: coolify.canonical,
      docker: dockerAuthority.canonical,
      postgres: postgres.canonical,
    }),
  };
}

async function writeExclusive(path, content) {
  const absolute = resolve(path);
  const handle = await open(absolute, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return absolute;
}

async function observe(options, dependencies) {
  exactOptions(options, [
    "request",
    "coolify-request",
    "journal",
    "image-provenance",
    "image-provenance-signature",
    "coolify-export-out",
    "docker-export-out",
    "postgres-export-out",
    "target-out",
  ]);
  const observation = await collectLiveObservation(options, dependencies);
  const artifact = createProductionTargetEvidence(observation);
  const coolifyOutput = await writeExclusive(
    options["coolify-export-out"],
    observation.canonical.coolify,
  );
  const dockerOutput = await writeExclusive(
    options["docker-export-out"],
    observation.canonical.docker,
  );
  const postgresOutput = await writeExclusive(
    options["postgres-export-out"],
    observation.canonical.postgres,
  );
  const output = await writeExclusive(
    options["target-out"],
    artifact.canonical,
  );
  process.stdout.write(
    [
      `coolifyExport=${coolifyOutput}`,
      `dockerExport=${dockerOutput}`,
      `postgresExport=${postgresOutput}`,
      `target=${output}`,
      `targetSha256=${artifact.sha256}`,
      "",
    ].join("\n"),
  );
}

async function attest(options, dependencies) {
  exactOptions(options, [
    "request",
    "coolify-request",
    "journal",
    "image-provenance",
    "image-provenance-signature",
    "target",
    "intent-evidence",
    "execution-evidence",
    "steady-evidence",
    "release-evidence",
    "activation-approval",
    "key-id",
    "attestation-out",
  ]);
  const artifact = createProductionHostAttestation({
    targetCanonical: await readBounded(options.target, "targetEvidence"),
    intentEvidenceCanonical: await readBounded(
      options["intent-evidence"],
      "intentEvidence",
    ),
    executionEvidenceCanonical: await readBounded(
      options["execution-evidence"],
      "executionEvidence",
    ),
    steadyEvidenceCanonical: await readBounded(
      options["steady-evidence"],
      "steadyEvidence",
    ),
    releaseEvidenceCanonical: await readBounded(
      options["release-evidence"],
      "releaseEvidence",
    ),
    activationApprovalCanonical: await readBounded(
      options["activation-approval"],
      "activationApprovalEvidence",
    ),
    keyId: options["key-id"],
    currentObservation: await collectLiveObservation(options, dependencies),
  });
  const output = await writeExclusive(
    options["attestation-out"],
    artifact.canonical,
  );
  process.stdout.write(
    `attestation=${output}\nattestationSha256=${artifact.sha256}\n`,
  );
}

async function verify(options, dependencies) {
  exactOptions(options, [
    "attestation",
    "signature",
    "public-key",
    "public-key-sha256",
    "key-id",
    "target",
    "intent-evidence",
    "execution-evidence",
    "steady-evidence",
    "release-evidence",
    "activation-approval",
  ]);
  const targetCanonical = await readBounded(options.target, "targetEvidence");
  const releaseEvidenceCanonical = await readBounded(
    options["release-evidence"],
    "releaseEvidence",
  );
  const intentEvidenceCanonical = await readBounded(
    options["intent-evidence"],
    "intentEvidence",
  );
  const executionEvidenceCanonical = await readBounded(
    options["execution-evidence"],
    "executionEvidence",
  );
  const steadyEvidenceCanonical = await readBounded(
    options["steady-evidence"],
    "steadyEvidence",
  );
  const activationApprovalCanonical = await readBounded(
    options["activation-approval"],
    "activationApprovalEvidence",
  );
  const expectedBinding = deriveProductionReleaseBinding(
    targetCanonical,
    intentEvidenceCanonical,
    executionEvidenceCanonical,
    steadyEvidenceCanonical,
    releaseEvidenceCanonical,
    activationApprovalCanonical,
  );
  if (
    dependencies?.expectedSourceSha !== undefined &&
    expectedBinding.sourceSha !== dependencies.expectedSourceSha
  ) {
    throw new Error(
      "PRODUCTION_HOST_SOURCE_MISMATCH: verified source differs from the immutable host-operator build.",
    );
  }
  const result = verifyDetachedHostAttestation({
    attestationCanonical: await readBounded(
      options.attestation,
      "hostAttestation",
    ),
    signature: await readBounded(options.signature, "signature", null),
    publicKeyPem: await readBounded(options["public-key"], "publicKey"),
    expectedPublicKeySha256: options["public-key-sha256"],
    expectedKeyId: options["key-id"],
    expectedBinding,
    expectedTargetCanonical: targetCanonical,
  });
  process.stdout.write(
    `verified=true\nattestationSha256=${result.sha256}\nkeyId=${options["key-id"]}\n`,
  );
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  if (command === "observe") return observe(options, dependencies);
  if (command === "attest") return attest(options, dependencies);
  return verify(options, dependencies);
}

if (
  globalThis.__SITE_LOGBOOK_STATIC_HOST_OPERATOR__ !== true &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
