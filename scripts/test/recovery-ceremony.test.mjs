import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveRecoveryMaterial,
  generateRecoveryMaterial,
  safeRecoverySummary,
  validateExpectedFingerprint,
} from "../recovery-ceremony-core.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(
  new URL("../recovery-ceremony.mjs", import.meta.url),
);

function deterministicRandom(...chunks) {
  let index = 0;
  return (size) => {
    const chunk = chunks[index++];
    assert.ok(chunk, "Unexpected random source call.");
    assert.equal(chunk.length, size);
    return chunk;
  };
}

function deterministicMaterial() {
  return generateRecoveryMaterial({
    purpose: "backup",
    keyId: "backup-test-v1",
    randomSource: deterministicRandom(Buffer.alloc(32), Buffer.alloc(16)),
  });
}

test("uses the public 256-bit BIP-39 zero-entropy vector", () => {
  const material = deterministicMaterial();
  assert.equal(material.mnemonic, `${Array(23).fill("abandon").join(" ")} art`);
  assert.equal(material.passphrase, Array(8).fill("abandon").join("-"));
  assert.equal(material.mnemonic.split(" ").length, 24);
  assert.equal(material.passphrase.split("-").length, 8);
});

test("derives a stable canonical 32-byte key and keyring entry", () => {
  const first = deterministicMaterial();
  const second = deriveRecoveryMaterial({
    mnemonic: first.mnemonic,
    passphrase: first.passphrase,
    purpose: first.purpose,
    keyId: first.keyId,
  });
  assert.equal(second.keyBase64, first.keyBase64);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(Buffer.from(first.keyBase64, "base64").length, 32);
  assert.deepEqual(JSON.parse(first.keyringJson), {
    "backup-test-v1": first.keyBase64,
  });
  assert.match(first.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("domain-separates purpose, key ID, and passphrase", () => {
  const material = deterministicMaterial();
  const differentPurpose = deriveRecoveryMaterial({
    ...material,
    purpose: "application",
  });
  const differentKeyId = deriveRecoveryMaterial({
    ...material,
    keyId: "backup-test-v2",
  });
  const differentPassphrase = deriveRecoveryMaterial({
    ...material,
    passphrase: `${Array(7).fill("abandon").join("-")}-ability`,
  });
  assert.notEqual(differentPurpose.keyBase64, material.keyBase64);
  assert.notEqual(differentKeyId.keyBase64, material.keyBase64);
  assert.notEqual(differentPassphrase.keyBase64, material.keyBase64);
});

test("rejects invalid mnemonic, passphrase, key ID, purpose, and fingerprint", () => {
  const material = deterministicMaterial();
  assert.throws(
    () => deriveRecoveryMaterial({ ...material, mnemonic: "abandon" }),
    /RECOVERY_MNEMONIC_INVALID/,
  );
  assert.throws(
    () => deriveRecoveryMaterial({ ...material, passphrase: "password" }),
    /RECOVERY_PASSPHRASE_INVALID/,
  );
  assert.throws(
    () => deriveRecoveryMaterial({ ...material, keyId: "bad key" }),
    /RECOVERY_KEY_ID_INVALID/,
  );
  assert.throws(
    () => deriveRecoveryMaterial({ ...material, purpose: "wallet" }),
    /RECOVERY_PURPOSE_INVALID/,
  );
  assert.throws(
    () => validateExpectedFingerprint("sha256:abcd"),
    /RECOVERY_FINGERPRINT_INVALID/,
  );
});

test("safe summary never contains recovery secrets or key material", () => {
  const material = deterministicMaterial();
  const serialized = JSON.stringify(safeRecoverySummary(material));
  assert.doesNotMatch(serialized, /abandon/);
  assert.doesNotMatch(serialized, new RegExp(material.keyBase64));
  assert.match(serialized, /backup-test-v1/);
  assert.match(serialized, /sha256/);
});

test("CLI refuses generation when output is not an interactive TTY", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      "--purpose",
      "backup",
      "--key-id",
      "backup-test-v1",
      "--acknowledge-offline",
      "--acknowledge-separate-storage",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RECOVERY_TTY_REQUIRED/);
  assert.doesNotMatch(result.stderr, /Mnemonic:|Passphrase:|KEYRING=/);
});

test("CLI accepts the literal pnpm argument separator before the command", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--",
      "generate",
      "--purpose",
      "backup",
      "--key-id",
      "backup-test-v1",
      "--acknowledge-offline",
      "--acknowledge-separate-storage",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RECOVERY_TTY_REQUIRED/);
  assert.doesNotMatch(result.stderr, /RECOVERY_COMMAND_INVALID/);
});

test("CLI rejects recovery secrets and unknown values in command-line arguments", () => {
  const commandLineSecret = "do-not-repeat-this-fixture";
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      "--purpose",
      "backup",
      "--key-id",
      "backup-test-v1",
      "--mnemonic",
      commandLineSecret,
      "--acknowledge-offline",
      "--acknowledge-separate-storage",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RECOVERY_OPTION_FORBIDDEN/);
  assert.doesNotMatch(result.stderr, new RegExp(commandLineSecret));
});

test("CLI refuses CI and ambient secret environments before generation", () => {
  for (const env of [
    { PATH: process.env.PATH ?? "", CI: "true" },
    {
      PATH: process.env.PATH ?? "",
      STAGING_S3_SECRET_ACCESS_KEY: "fixture-not-a-real-secret",
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "generate",
        "--purpose",
        "backup",
        "--key-id",
        "backup-test-v1",
        "--acknowledge-offline",
        "--acknowledge-separate-storage",
      ],
      { cwd: projectRoot, encoding: "utf8", env },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /RECOVERY_ENVIRONMENT_UNSAFE|RECOVERY_AMBIENT_SECRETS_PRESENT/,
    );
    assert.doesNotMatch(result.stderr, /fixture-not-a-real-secret/);
    assert.doesNotMatch(result.stderr, /Mnemonic:|Passphrase:|KEYRING=/);
  }
});

test("CLI help is safe in non-interactive environments", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /offline recovery ceremony/);
  assert.doesNotMatch(result.stdout, /sha256:[a-f0-9]{64}/);
});

test("operational sources contain no persistence or network client", () => {
  const sources = [
    readFileSync(cliPath, "utf8"),
    readFileSync(
      fileURLToPath(new URL("../recovery-ceremony-core.mjs", import.meta.url)),
      "utf8",
    ),
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /node:(?:fs|http|https|net|tls|dgram)|\bfetch\s*\(|localStorage|sessionStorage|indexedDB/,
  );
});
