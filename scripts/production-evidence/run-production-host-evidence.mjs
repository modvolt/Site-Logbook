#!/usr/bin/env node

import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProductionHostAttestation,
  createProductionTargetEvidence,
  deriveProductionReleaseBinding,
  verifyDetachedHostAttestation,
} from "./host-attestation-contract.mjs";
import { collectDockerReadOnlyExport } from "./docker-readonly-observer.mjs";

const MAX_INPUT_BYTES = 256 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/production-evidence/run-production-host-evidence.mjs collect-docker --request FILE --docker-export-out FILE",
    "  node scripts/production-evidence/run-production-host-evidence.mjs observe --request FILE --image-provenance FILE --image-provenance-signature FILE --coolify-export FILE --docker-export FILE --postgres-export FILE --target-out FILE",
    "  node scripts/production-evidence/run-production-host-evidence.mjs attest --request FILE --image-provenance FILE --image-provenance-signature FILE --coolify-export FILE --docker-export FILE --postgres-export FILE --target FILE --intent-evidence FILE --execution-evidence FILE --steady-evidence FILE --release-evidence FILE --activation-approval FILE --key-id ID --attestation-out FILE",
    "  node scripts/production-evidence/run-production-host-evidence.mjs verify --attestation FILE --signature FILE --public-key FILE --public-key-sha256 DIGEST --key-id ID --target FILE --intent-evidence FILE --execution-evidence FILE --steady-evidence FILE --release-evidence FILE --activation-approval FILE",
    "",
    "All inputs are explicit secret-free read-only exports. This runner never accepts a private key.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (
    !command ||
    !["collect-docker", "observe", "attest", "verify"].includes(command)
  ) {
    throw new Error(
      "PRODUCTION_HOST_USAGE_INVALID: expected collect-docker, observe, attest or verify.",
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
  const metadata = await stat(absolute);
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_INPUT_BYTES
  ) {
    throw new Error(
      `PRODUCTION_HOST_INPUT_INVALID: ${field} is invalid or too large.`,
    );
  }
  return readFile(absolute, encoding);
}

async function readJson(path, field) {
  const raw = await readBounded(path, field);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`PRODUCTION_HOST_INPUT_INVALID: ${field} must be JSON.`);
  }
}

async function readObservation(options) {
  return {
    request: await readJson(options.request, "request"),
    imageProvenanceCanonical: await readBounded(
      options["image-provenance"],
      "imageProvenance",
    ),
    imageProvenanceSignature: await readBounded(
      options["image-provenance-signature"],
      "imageProvenanceSignature",
      null,
    ),
    coolify: await readJson(options["coolify-export"], "coolifyExport"),
    docker: await readJson(options["docker-export"], "dockerExport"),
    postgres: await readJson(options["postgres-export"], "postgresExport"),
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

async function observe(options) {
  exactOptions(options, [
    "request",
    "image-provenance",
    "image-provenance-signature",
    "coolify-export",
    "docker-export",
    "postgres-export",
    "target-out",
  ]);
  const artifact = createProductionTargetEvidence(
    await readObservation(options),
  );
  const output = await writeExclusive(
    options["target-out"],
    artifact.canonical,
  );
  process.stdout.write(`target=${output}\ntargetSha256=${artifact.sha256}\n`);
}

async function collectDocker(options) {
  exactOptions(options, ["request", "docker-export-out"]);
  const artifact = await collectDockerReadOnlyExport(
    await readJson(options.request, "request"),
  );
  const output = await writeExclusive(
    options["docker-export-out"],
    artifact.canonical,
  );
  process.stdout.write(`dockerExport=${output}\n`);
}

async function attest(options) {
  exactOptions(options, [
    "request",
    "image-provenance",
    "image-provenance-signature",
    "coolify-export",
    "docker-export",
    "postgres-export",
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
    currentObservation: await readObservation(options),
  });
  const output = await writeExclusive(
    options["attestation-out"],
    artifact.canonical,
  );
  process.stdout.write(
    `attestation=${output}\nattestationSha256=${artifact.sha256}\n`,
  );
}

async function verify(options) {
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

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "collect-docker") return collectDocker(options);
  if (command === "observe") return observe(options);
  if (command === "attest") return attest(options);
  return verify(options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
