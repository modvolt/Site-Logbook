#!/usr/bin/env node

import process from "node:process";
import {
  deriveRecoveryMaterial,
  generateRecoveryMaterial,
  safeRecoverySummary,
  validateExpectedFingerprint,
} from "./recovery-ceremony-core.mjs";
import { sensitiveEnvironmentKeys } from "./assert-safe-test-env.mjs";

const HELP = `Modvolt offline recovery ceremony

Usage:
  pnpm recovery:ceremony -- generate --purpose <application|backup> --key-id <id> \\
    --acknowledge-offline --acknowledge-separate-storage

  pnpm recovery:ceremony -- verify --purpose <application|backup> --key-id <id> \\
    --expected-fingerprint <sha256:hex> --acknowledge-offline \\
    --acknowledge-separate-storage

Optional verify flags:
  --show-derived-key --acknowledge-secret-output

The command deliberately refuses non-interactive output, CI, production mode,
secret-bearing command-line arguments, and file output. Generate displays the
recovery material once and clears the terminal after confirmation. Verify reads
the mnemonic and passphrase through a masked TTY prompt.
`;

class CliError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CliError";
    this.code = code;
  }
}

const cliArguments = process.argv.slice(2).filter((value) => value !== "--");
const VALUE_OPTIONS = new Set([
  "--purpose",
  "--key-id",
  "--expected-fingerprint",
]);
const COMMON_FLAGS = new Set([
  "--acknowledge-offline",
  "--acknowledge-separate-storage",
]);
const COMMAND_FLAGS = Object.freeze({
  generate: new Set(COMMON_FLAGS),
  verify: new Set([
    ...COMMON_FLAGS,
    "--show-derived-key",
    "--acknowledge-secret-output",
  ]),
});

function fail(code, message) {
  throw new CliError(code, message);
}

function flag(name) {
  return cliArguments.includes(name);
}

function option(name) {
  const matches = cliArguments
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value === name);
  if (matches.length !== 1) {
    fail("RECOVERY_OPTION_INVALID", `${name} must be provided exactly once.`);
  }
  const value = cliArguments[matches[0].index + 1];
  if (!value || value.startsWith("--")) {
    fail("RECOVERY_OPTION_INVALID", `${name} requires a value.`);
  }
  return value;
}

function assertKnownArguments(command) {
  const allowedValues =
    command === "generate" ? new Set(["--purpose", "--key-id"]) : VALUE_OPTIONS;
  const allowedFlags = COMMAND_FLAGS[command];
  const seenFlags = new Set();

  for (let index = 1; index < cliArguments.length; index += 1) {
    const argument = cliArguments[index];
    if (allowedValues.has(argument)) {
      const value = cliArguments[index + 1];
      if (!value || value.startsWith("--")) {
        fail(
          "RECOVERY_OPTION_INVALID",
          "A required command-line option value is missing.",
        );
      }
      index += 1;
      continue;
    }
    if (allowedFlags.has(argument)) {
      if (seenFlags.has(argument)) {
        fail(
          "RECOVERY_OPTION_INVALID",
          "A command-line acknowledgement or output flag was provided more than once.",
        );
      }
      seenFlags.add(argument);
      continue;
    }
    fail(
      "RECOVERY_OPTION_FORBIDDEN",
      "Unsupported argument. Mnemonic, passphrase, and other recovery secrets must never be passed on the command line.",
    );
  }
}

function requireSafeInteractiveEnvironment() {
  if (process.env.CI === "true" || process.env.NODE_ENV === "production") {
    fail(
      "RECOVERY_ENVIRONMENT_UNSAFE",
      "Recovery material cannot be generated or entered in CI or production mode.",
    );
  }
  const sensitiveKeys = sensitiveEnvironmentKeys(process.env);
  if (sensitiveKeys.length > 0) {
    fail(
      "RECOVERY_AMBIENT_SECRETS_PRESENT",
      `Clear ambient provider/application secrets before the ceremony: ${sensitiveKeys.join(", ")}.`,
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "RECOVERY_TTY_REQUIRED",
      "Use a trusted local interactive terminal; redirection and pipes are refused.",
    );
  }
  if (
    !flag("--acknowledge-offline") ||
    !flag("--acknowledge-separate-storage")
  ) {
    fail(
      "RECOVERY_ACKNOWLEDGEMENT_REQUIRED",
      "Both offline and separate-storage acknowledgements are required.",
    );
  }
}

function clearTerminal() {
  process.stdout.write("\u001b[3J\u001b[2J\u001b[H");
}

function promptMasked(label, { allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof process.stdin.setRawMode !== "function") {
      reject(
        new CliError(
          "RECOVERY_TTY_REQUIRED",
          "This terminal cannot provide masked input.",
        ),
      );
      return;
    }
    let value = "";
    const previousRawMode = Boolean(process.stdin.isRaw);
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        const code = character.charCodeAt(0);
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          reject(new CliError("RECOVERY_ABORTED", "Ceremony aborted."));
          return;
        }
        if (character === "\r" || character === "\n") {
          if (!allowEmpty && value.length === 0) continue;
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (code === 8 || code === 127) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code >= 32 && code <= 126 && value.length < 4096) {
          value += character;
          process.stdout.write("*");
        }
      }
    };

    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function confirmRecordedAndClear() {
  await promptMasked(
    "After recording every value in separate offline locations, press Enter to clear this terminal: ",
    { allowEmpty: true },
  );
  clearTerminal();
  process.stdout.write(
    "Recovery material cleared from the visible terminal. Complete an independent verify ceremony before use.\n",
  );
}

function printSecretMaterial(material) {
  process.stdout.write("\n=== SECRET RECOVERY MATERIAL - DISPLAYED ONCE ===\n");
  process.stdout.write(`Format: ${material.format}\n`);
  process.stdout.write(`Purpose: ${material.purpose}\n`);
  process.stdout.write(`Key ID: ${material.keyId}\n`);
  process.stdout.write(`Mnemonic: ${material.mnemonic}\n`);
  process.stdout.write(`Passphrase: ${material.passphrase}\n`);
  process.stdout.write(`Fingerprint: ${material.fingerprint}\n`);
  process.stdout.write(
    `${material.keyringEnvironment}=${material.keyringJson}\n`,
  );
  process.stdout.write(
    `${material.activeKeyIdEnvironment}=${material.keyId}\n`,
  );
  process.stdout.write("=== END SECRET RECOVERY MATERIAL ===\n\n");
}

async function generate() {
  requireSafeInteractiveEnvironment();
  const material = generateRecoveryMaterial({
    purpose: option("--purpose"),
    keyId: option("--key-id"),
  });
  printSecretMaterial(material);
  await confirmRecordedAndClear();
}

async function verify() {
  requireSafeInteractiveEnvironment();
  const purpose = option("--purpose");
  const keyId = option("--key-id");
  const expectedFingerprint = validateExpectedFingerprint(
    option("--expected-fingerprint"),
  );
  const mnemonic = await promptMasked("Mnemonic (24 words): ");
  const passphrase = await promptMasked("Passphrase (8 dashed words): ");
  const material = deriveRecoveryMaterial({
    mnemonic,
    passphrase,
    purpose,
    keyId,
  });
  clearTerminal();
  if (material.fingerprint !== expectedFingerprint) {
    fail(
      "RECOVERY_FINGERPRINT_MISMATCH",
      "Recovered key does not match the approved fingerprint.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ...safeRecoverySummary(material), verified: true }, null, 2)}\n`,
  );

  if (flag("--show-derived-key")) {
    if (!flag("--acknowledge-secret-output")) {
      fail(
        "RECOVERY_SECRET_OUTPUT_ACKNOWLEDGEMENT_REQUIRED",
        "Showing the derived key requires --acknowledge-secret-output.",
      );
    }
    printSecretMaterial(material);
    await confirmRecordedAndClear();
  }
}

async function main() {
  if (flag("--help") || flag("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const command = cliArguments[0];
  if (command === "generate") {
    assertKnownArguments(command);
    await generate();
    return;
  }
  if (command === "verify") {
    assertKnownArguments(command);
    await verify();
    return;
  }
  fail("RECOVERY_COMMAND_INVALID", "Use generate, verify, or --help.");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown recovery error."}\n`,
  );
  process.exitCode = 1;
});
