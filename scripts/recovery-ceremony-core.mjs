import { createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  entropyToMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const RECOVERY_FORMAT = "modvolt-recovery-mnemonic/v1";
export const MNEMONIC_WORDS = 24;
export const PASSPHRASE_WORDS = 8;

const ENTROPY_BYTES = 32;
const DERIVED_KEY_BYTES = 32;
const WORD_INDEX_BYTES = 2;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PURPOSES = new Set(["application", "backup"]);
const PASSPHRASE_PATTERN = /^[a-z]+(?:-[a-z]+){7}$/;
const WORD_SET = new Set(wordlist);
const HKDF_SALT = Buffer.from(RECOVERY_FORMAT, "utf8");

export class RecoveryCeremonyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RecoveryCeremonyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RecoveryCeremonyError(code, message);
}

function validatePurpose(purpose) {
  if (!PURPOSES.has(purpose)) {
    fail("RECOVERY_PURPOSE_INVALID", "Purpose must be application or backup.");
  }
  return purpose;
}

function validateKeyId(keyId) {
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    fail(
      "RECOVERY_KEY_ID_INVALID",
      "Key ID must contain 1-64 letters, digits, dots, underscores, or dashes.",
    );
  }
  return keyId;
}

function normalizeMnemonic(mnemonic) {
  if (typeof mnemonic !== "string") {
    fail("RECOVERY_MNEMONIC_INVALID", "Mnemonic must be a string.");
  }
  const normalized = mnemonic.trim().replace(/\s+/g, " ");
  if (
    normalized.split(" ").length !== MNEMONIC_WORDS ||
    !validateMnemonic(normalized, wordlist)
  ) {
    fail(
      "RECOVERY_MNEMONIC_INVALID",
      "Mnemonic must be a valid 24-word English BIP-39 phrase.",
    );
  }
  return normalized;
}

function normalizePassphrase(passphrase) {
  if (typeof passphrase !== "string" || !PASSPHRASE_PATTERN.test(passphrase)) {
    fail(
      "RECOVERY_PASSPHRASE_INVALID",
      "Passphrase must contain exactly eight lowercase English words joined by dashes.",
    );
  }
  const words = passphrase.split("-");
  if (!words.every((word) => WORD_SET.has(word))) {
    fail(
      "RECOVERY_PASSPHRASE_INVALID",
      "Every passphrase word must belong to the English BIP-39 wordlist.",
    );
  }
  return passphrase;
}

function randomBuffer(size, randomSource) {
  const bytes = Buffer.from(randomSource(size));
  if (bytes.length !== size) {
    bytes.fill(0);
    fail(
      "RECOVERY_RANDOM_SOURCE_INVALID",
      `Random source must return exactly ${size} bytes.`,
    );
  }
  return bytes;
}

function generatePassphrase(randomSource) {
  const bytes = randomBuffer(PASSPHRASE_WORDS * WORD_INDEX_BYTES, randomSource);
  try {
    const words = [];
    for (let offset = 0; offset < bytes.length; offset += WORD_INDEX_BYTES) {
      // 65536 is exactly divisible by the 2048-word BIP-39 list, so modulo
      // introduces no bias for a uniformly random unsigned 16-bit value.
      words.push(wordlist[bytes.readUInt16BE(offset) % wordlist.length]);
    }
    return words.join("-");
  } finally {
    bytes.fill(0);
  }
}

function keyFingerprint(key) {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function keyringEnvironment(purpose) {
  return purpose === "backup"
    ? {
        keyring: "BACKUP_ENCRYPTION_KEYRING",
        activeKeyId: "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
      }
    : {
        keyring: "SECRET_ENCRYPTION_KEYRING",
        activeKeyId: "SECRET_ENCRYPTION_ACTIVE_KEY_ID",
      };
}

export function deriveRecoveryMaterial({
  mnemonic,
  passphrase,
  purpose,
  keyId,
}) {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  const normalizedPassphrase = normalizePassphrase(passphrase);
  const normalizedPurpose = validatePurpose(purpose);
  const normalizedKeyId = validateKeyId(keyId);
  const seed = Buffer.from(
    mnemonicToSeedSync(normalizedMnemonic, normalizedPassphrase),
  );
  let key;
  try {
    const info = Buffer.from(
      `${RECOVERY_FORMAT}:${normalizedPurpose}:${normalizedKeyId}:aes-256`,
      "utf8",
    );
    key = Buffer.from(
      hkdfSync("sha256", seed, HKDF_SALT, info, DERIVED_KEY_BYTES),
    );
    const keyBase64 = key.toString("base64");
    const environment = keyringEnvironment(normalizedPurpose);
    return Object.freeze({
      format: RECOVERY_FORMAT,
      purpose: normalizedPurpose,
      keyId: normalizedKeyId,
      mnemonic: normalizedMnemonic,
      passphrase: normalizedPassphrase,
      fingerprint: keyFingerprint(key),
      keyBase64,
      keyringEnvironment: environment.keyring,
      activeKeyIdEnvironment: environment.activeKeyId,
      keyringJson: JSON.stringify({ [normalizedKeyId]: keyBase64 }),
    });
  } finally {
    seed.fill(0);
    key?.fill(0);
  }
}

export function generateRecoveryMaterial({
  purpose,
  keyId,
  randomSource = randomBytes,
}) {
  validatePurpose(purpose);
  validateKeyId(keyId);
  const entropy = randomBuffer(ENTROPY_BYTES, randomSource);
  let mnemonic;
  try {
    mnemonic = entropyToMnemonic(entropy, wordlist);
  } finally {
    entropy.fill(0);
  }
  return deriveRecoveryMaterial({
    mnemonic,
    passphrase: generatePassphrase(randomSource),
    purpose,
    keyId,
  });
}

export function validateExpectedFingerprint(fingerprint) {
  if (
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    fail(
      "RECOVERY_FINGERPRINT_INVALID",
      "Expected fingerprint must be sha256 followed by 64 lowercase hex characters.",
    );
  }
  return fingerprint;
}

export function safeRecoverySummary(material) {
  const key = Buffer.from(material.keyBase64, "base64");
  try {
    return Object.freeze({
      format: material.format,
      purpose: material.purpose,
      keyId: material.keyId,
      fingerprint: material.fingerprint,
      mnemonicWords: material.mnemonic.split(" ").length,
      passphraseWords: material.passphrase.split("-").length,
      keyBytes: key.length,
    });
  } finally {
    key.fill(0);
  }
}
