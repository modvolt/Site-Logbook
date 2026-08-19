import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PRODUCTION_ACTIVATION_BUNDLE_BASENAME,
  PRODUCTION_ACTIVATION_BUNDLE_TRANSFER_CONFIRMATION,
  canonicalProductionActivationTransferJson,
  publishTransferredActivationBundle,
  runProductionHostOperator,
} from "../production-evidence/production-host-operator-packaging.mjs";

const SOURCE_SHA = "1".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

function activationBundle(overrides = {}) {
  return {
    activation: {
      schemaVersion: 2,
      kind: "site-logbook-production-activation-bundle-v2",
      sourceSha: SOURCE_SHA,
      issuedAt: "2026-08-18T10:00:00.000Z",
      evidence: {},
      ...overrides.activation,
    },
    activationSignature: {
      algorithm: "Ed25519",
      keyId: digest("a"),
      signatureBase64: Buffer.alloc(64, 1).toString("base64"),
    },
    hostAttestation: {
      schemaVersion: 2,
      kind: "site-logbook-production-host-attestation-v2",
      sourceSha: SOURCE_SHA,
      observedAt: "2026-08-18T10:00:00.000Z",
      ...overrides.hostAttestation,
    },
    hostAttestationSignature: {
      algorithm: "Ed25519",
      keyId: digest("b"),
      signatureBase64: Buffer.alloc(64, 2).toString("base64"),
    },
    ...overrides.bundle,
  };
}

function publishArgs(input, directory, expectedSha256) {
  return [
    "--input",
    input,
    "--expected-sha256",
    expectedSha256,
    "--evidence-dir",
    directory,
    "--confirm",
    PRODUCTION_ACTIVATION_BUNDLE_TRANSFER_CONFIRMATION,
  ];
}

test("host-operator Docker target is exact-digest isolated from the final runtime", async () => {
  const [dockerfile, build, entrypoint, runner, packaging] = await Promise.all([
    readFile(
      new URL("../../artifacts/api-server/Dockerfile", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../artifacts/api-server/build.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../artifacts/api-server/src/production-host-evidence-operator.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../production-evidence/run-production-host-evidence.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../production-evidence/production-host-operator-packaging.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const cliDigest =
    "sha256:a35dae37a79d2b84ccf0100045aec5ab920e4cc8e84f9141d355da602f8af899";
  const indexDigest =
    "sha256:9190b0613792e658a7783cf14b2d5ace5941bb68ede7276922ea36ee457d76ad";
  assert.match(
    dockerfile,
    new RegExp(`FROM docker:28\\.5\\.1-cli@${cliDigest} AS docker-cli-amd64`),
  );
  assert.ok(dockerfile.includes(indexDigest));
  assert.match(dockerfile, /AS host-operator/);
  assert.match(
    dockerfile,
    /COPY --from=docker-cli-amd64 \/usr\/local\/bin\/docker \/usr\/local\/bin\/docker/,
  );
  const finalTarget = dockerfile.slice(
    dockerfile.lastIndexOf("FROM runtime AS production"),
  );
  assert.doesNotMatch(
    finalTarget,
    /docker-cli|docker\.sock|host-evidence-operator/,
  );
  assert.match(build, /production-host-evidence-operator\.ts/);
  assert.match(
    build,
    /"globalThis\.__SITE_LOGBOOK_STATIC_HOST_OPERATOR__": "true"/,
  );
  assert.match(entrypoint, /requireEmbeddedProductionBuildSha/);
  assert.match(entrypoint, /postgresObserver/);
  assert.match(runner, /__SITE_LOGBOOK_STATIC_HOST_OPERATOR__/);
  assert.match(runner, /expectedSourceSha/);
  assert.match(packaging, /fsConstants\.O_DIRECTORY/);
  assert.match(packaging, /await handle\.sync\(\)/);
  assert.equal(packaging.match(/await sync\(directory\)/g)?.length, 2);
  assert.match(packaging, /await link\(temporary, destination\)/);
  assert.match(packaging, /await readStableSingleLinkFile\(destination/);
});

test("host operator is default-dark and source-pins delegated commands", async () => {
  await assert.rejects(
    runProductionHostOperator([], {
      sourceSha: SOURCE_SHA,
      runHostEvidence: async () => {},
    }),
    /PRODUCTION_HOST_OPERATOR_DARK/,
  );
  await assert.rejects(
    runProductionHostOperator(["verify"], {
      sourceSha: "dev",
      runHostEvidence: async () => {},
    }),
    /PRODUCTION_HOST_OPERATOR_SOURCE_INVALID/,
  );
  let delegated;
  await runProductionHostOperator(["verify", "--target", "unused"], {
    sourceSha: SOURCE_SHA,
    runHostEvidence: async (argv, sourceSha) => {
      delegated = { argv, sourceSha };
    },
  });
  assert.deepEqual(delegated, {
    argv: ["verify", "--target", "unused"],
    sourceSha: SOURCE_SHA,
  });
});

test("publishes exact canonical public evidence with no-clobber, fsync and readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-operator-publish-"));
  const evidenceDirectory = join(directory, "evidence");
  const input = join(directory, "staged.json");
  await mkdir(evidenceDirectory);
  const bytes = Buffer.from(
    canonicalProductionActivationTransferJson(activationBundle()),
  );
  const expectedSha256 = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  await writeFile(input, bytes);
  let directorySyncs = 0;
  try {
    const result = await publishTransferredActivationBundle(
      publishArgs(input, evidenceDirectory, expectedSha256),
      SOURCE_SHA,
      {
        syncDirectory: async () => {
          directorySyncs += 1;
        },
      },
    );
    assert.equal(
      result.output,
      join(evidenceDirectory, PRODUCTION_ACTIVATION_BUNDLE_BASENAME),
    );
    assert.equal(result.sha256, expectedSha256);
    assert.equal(directorySyncs, 2);
    assert.deepEqual(await readFile(result.output), bytes);
    assert.equal((await lstat(result.output, { bigint: true })).nlink, 1n);

    await assert.rejects(
      publishTransferredActivationBundle(
        publishArgs(input, evidenceDirectory, expectedSha256),
        SOURCE_SHA,
        { syncDirectory: async () => {} },
      ),
      /PRODUCTION_ACTIVATION_TRANSFER_DESTINATION_EXISTS/,
    );
    assert.deepEqual(await readFile(result.output), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transfer rejects digest drift, noncanonical bytes, secrets and multi-link input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-operator-reject-"));
  try {
    for (const name of ["digest", "canonical", "secret", "linked"]) {
      await mkdir(join(directory, name));
    }
    const canonical =
      canonicalProductionActivationTransferJson(activationBundle());

    const digestInput = join(directory, "digest-input.json");
    await writeFile(digestInput, canonical);
    await assert.rejects(
      publishTransferredActivationBundle(
        publishArgs(digestInput, join(directory, "digest"), digest("f")),
        SOURCE_SHA,
      ),
      /PRODUCTION_ACTIVATION_TRANSFER_DIGEST_MISMATCH/,
    );

    const canonicalInput = join(directory, "canonical-input.json");
    await writeFile(canonicalInput, canonical.replaceAll("\n", "\r\n"));
    const canonicalDigest = `sha256:${createHash("sha256")
      .update(await readFile(canonicalInput))
      .digest("hex")}`;
    await assert.rejects(
      publishTransferredActivationBundle(
        publishArgs(
          canonicalInput,
          join(directory, "canonical"),
          canonicalDigest,
        ),
        SOURCE_SHA,
      ),
      /PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID/,
    );

    const secretInput = join(directory, "secret-input.json");
    const secret = canonicalProductionActivationTransferJson(
      activationBundle({
        activation: {
          evidence: {
            neutral: "github_pat_abcdefghijklmnop1234567890",
          },
        },
      }),
    );
    await writeFile(secretInput, secret);
    const secretDigest = `sha256:${createHash("sha256")
      .update(secret)
      .digest("hex")}`;
    await assert.rejects(
      publishTransferredActivationBundle(
        publishArgs(secretInput, join(directory, "secret"), secretDigest),
        SOURCE_SHA,
      ),
      /PRODUCTION_ACTIVATION_TRANSFER_PRIVATE_MATERIAL/,
    );

    const linkedInput = join(directory, "linked-input.json");
    const secondLink = join(directory, "linked-input-copy.json");
    await writeFile(linkedInput, canonical);
    await link(linkedInput, secondLink);
    const linkedDigest = `sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`;
    await assert.rejects(
      publishTransferredActivationBundle(
        publishArgs(linkedInput, join(directory, "linked"), linkedDigest),
        SOURCE_SHA,
      ),
      /PRODUCTION_ACTIVATION_TRANSFER_INPUT_UNSAFE/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
