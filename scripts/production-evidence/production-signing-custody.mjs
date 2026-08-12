import { spawn, spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveRecoveryMaterial,
  generateRecoveryMaterial,
} from "../recovery-ceremony-core.mjs";
import { sensitiveEnvironmentKeys } from "../assert-safe-test-env.mjs";

const SCHEMA = "site-logbook.production-signing-custody/v1";
const KEY_ID = /^ed25519:[a-z0-9][a-z0-9._-]{2,63}$/;
const SYMMETRIC_KEY_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BACKUP_SIGNATURE_DOMAIN =
  "site-logbook.production-exact-0096-backup-executor-signature/v1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DPAPI_SCRIPT = join(SCRIPT_DIR, "production-signing-dpapi.ps1");
const MANIFEST_FILE = "public-trust-roots.json";
const PRIVATE_FILES = Object.freeze({
  publisherProvenance: "publisher-provenance.pkcs8.dpapi",
  hostEvidence: "host-evidence.pkcs8.dpapi",
  secretEnvelope: "secret-envelope.key.dpapi",
  backupEncryption: "backup-encryption.key.dpapi",
});
const RECOVERY_FILES = Object.freeze({
  publisherProvenance: "publisher-provenance.recovery.dpapi",
  hostEvidence: "host-evidence.recovery.dpapi",
  secretEnvelope: "secret-envelope.recovery.dpapi",
  backupEncryption: "backup-encryption.recovery.dpapi",
});
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const POWERSHELL =
  process.env.SystemRoot == null
    ? "powershell.exe"
    : join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );

function fail(message) {
  throw new Error(`PRODUCTION_SIGNING_CUSTODY_INVALID: ${message}`);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/production-evidence/production-signing-custody.mjs init --vault ABSOLUTE_PATH --publisher-key-id ID --host-key-id ID --secret-key-id ID --backup-key-id ID --confirm INITIALIZE_NEW_PRODUCTION_KEY_VAULT",
    "  node scripts/production-evidence/production-signing-custody.mjs restore --vault NEW_ABSOLUTE_PATH --public-manifest ABSOLUTE_PATH --confirm RESTORE_NEW_PRODUCTION_KEY_VAULT",
    "  node scripts/production-evidence/production-signing-custody.mjs status --vault ABSOLUTE_PATH",
    "  node scripts/production-evidence/production-signing-custody.mjs sign --vault ABSOLUTE_PATH --purpose publisher-provenance|host-attestation|backup-receipt --input ABSOLUTE_PATH --output ABSOLUTE_PATH",
    "  node scripts/production-evidence/production-signing-custody.mjs export-coolify-clipboard --vault ABSOLUTE_PATH --clipboard-seconds 30..600 --confirm COPY_COOLIFY_SECRETS_TO_CLIPBOARD",
    "  node scripts/production-evidence/production-signing-custody.mjs export-recovery-clipboard --vault ABSOLUTE_PATH --role publisher-provenance|host-evidence|secret-envelope|backup-encryption --clipboard-seconds 30..600 --confirm COPY_RECOVERY_CARD_TO_CLIPBOARD",
    "",
    "Private material is current-user DPAPI protected outside the repository.",
    "No command writes a private key to stdout or accepts one via argv/env.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const token = rest[index];
    const value = rest[index + 1];
    if (!token?.startsWith("--") || value == null || value.startsWith("--")) {
      fail("Every option must have one explicit value.");
    }
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) fail(`Duplicate option --${name}.`);
    options[name] = value;
  }
  return { command, options };
}

function exactOptions(options, names) {
  const actual = Object.keys(options).sort();
  const expected = [...names].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`Expected exactly: ${expected.map((name) => `--${name}`).join(" ")}.`);
  }
}

function absolutePath(value, name) {
  if (!isAbsolute(value)) fail(`${name} must be absolute.`);
  return resolve(value);
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function outsideRepository(value, name) {
  const path = absolutePath(value, name);
  if (isWithin(REPOSITORY_ROOT, path)) {
    fail(`${name} must remain outside the repository.`);
  }
  return path;
}

function keyId(value, name, pattern) {
  if (!pattern.test(value)) fail(`${name} is invalid.`);
  return value;
}

function canonicalJson(value) {
  const canonical = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([name, nested]) => [name, canonical(nested)]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(canonical(value))}\n`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeExclusive(path, bytes) {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function runDpapi(operation, path, role, input) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    DPAPI_SCRIPT,
    "-Operation",
    operation,
    "-Path",
    path,
  ];
  if (role) args.push("-Role", role);
  const result = spawnSync(POWERSHELL, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024,
  });
  if (result.status !== 0) {
    fail(`Windows DPAPI operation ${operation} failed.`);
  }
  return result.stdout;
}

function runClipboard(path, seconds, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DPAPI_SCRIPT,
        "-Operation",
        "clipboard",
        "-Path",
        path,
        "-ClipboardSeconds",
        String(seconds),
      ],
      { stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
    );
    child.once("error", () =>
      rejectPromise(
        new Error(
          "PRODUCTION_SIGNING_CUSTODY_INVALID: Clipboard operation failed.",
        ),
      ),
    );
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            "PRODUCTION_SIGNING_CUSTODY_INVALID: Clipboard operation failed.",
          ),
        );
    });
    child.stdin.end(input);
  });
}

function publicRecord(keyIdValue, publicKey) {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  return { keyId: keyIdValue, publicKeyPem: pem, publicKeySha256: sha256(der) };
}

function recoveryMaterial(role, keyIdValue, purpose) {
  const recoveryKeyId = `${role}-${keyIdValue.replace(/^ed25519:/, "")}`;
  const material = generateRecoveryMaterial({
    purpose,
    keyId: recoveryKeyId,
  });
  const key = Buffer.from(material.keyBase64, "base64");
  if (key.length !== 32) fail(`${role} recovery material is not 32 bytes.`);
  const card = Buffer.from(
    canonicalJson({
      schemaVersion: SCHEMA,
      kind: "site-logbook-production-signing-recovery-card",
      role,
      keyId: keyIdValue,
      recoveryFormat: material.format,
      recoveryPurpose: material.purpose,
      recoveryKeyId: material.keyId,
      recoveryFingerprint: material.fingerprint,
      mnemonic: material.mnemonic,
      passphrase: material.passphrase,
    }),
  );
  return { key, card, fingerprint: material.fingerprint, recoveryKeyId };
}

function ed25519FromSeed(seed) {
  if (seed.length !== 32) fail("Ed25519 seed must be 32 bytes.");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    type: "pkcs8",
    format: "der",
  });
}

function parseManifestCanonical(bytes) {
  if (bytes.length > 64 * 1024) fail("Public manifest exceeds its byte limit.");
  const raw = bytes.toString("utf8");
  const value = JSON.parse(raw);
  if (canonicalJson(value) !== raw)
    fail("Public manifest is not canonical JSON.");
  if (
    value.schemaVersion !== SCHEMA ||
    value.kind !== "site-logbook-production-signing-public-trust-roots" ||
    typeof value.createdAt !== "string"
  ) {
    fail("Public manifest schema is invalid.");
  }
  for (const [name, expectedRole] of [
    ["publisherProvenance", "publisher-provenance"],
    ["hostEvidence", "host-evidence"],
  ]) {
    const record = value[name];
    keyId(record?.keyId, `${name}.keyId`, KEY_ID);
    if (record.role !== expectedRole || !SHA256.test(record.publicKeySha256)) {
      fail(`${name} public record is invalid.`);
    }
    const publicKey = createPublicKey(record.publicKeyPem);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      sha256(publicKey.export({ type: "spki", format: "der" })) !==
        record.publicKeySha256
    ) {
      fail(`${name} SPKI/pin binding is invalid.`);
    }
  }
  keyId(value.secretEnvelope?.keyId, "secretEnvelope.keyId", SYMMETRIC_KEY_ID);
  keyId(
    value.backupEncryption?.keyId,
    "backupEncryption.keyId",
    SYMMETRIC_KEY_ID,
  );
  for (const [name, record] of Object.entries({
    publisherProvenance: value.publisherProvenance,
    hostEvidence: value.hostEvidence,
    secretEnvelope: value.secretEnvelope,
    backupEncryption: value.backupEncryption,
  })) {
    keyId(record?.recoveryKeyId, `${name}.recoveryKeyId`, SYMMETRIC_KEY_ID);
    if (!SHA256.test(record?.recoveryFingerprint ?? "")) {
      fail(`${name} recovery fingerprint is invalid.`);
    }
  }
  if (
    value.publisherProvenance.keyId === value.hostEvidence.keyId ||
    value.secretEnvelope.keyId === value.backupEncryption.keyId ||
    value.publisherProvenance.publicKeySha256 ===
      value.hostEvidence.publicKeySha256
  ) {
    fail("The four custody roles are not independent.");
  }
  return value;
}

function parseManifest(vault) {
  return parseManifestCanonical(readFileSync(join(vault, MANIFEST_FILE)));
}

function protect(vault, role, filename, bytes) {
  try {
    runDpapi("protect", join(vault, filename), role, bytes.toString("base64"));
  } finally {
    bytes.fill(0);
  }
}

function unprotect(vault, role, filename) {
  const encoded = runDpapi("unprotect", join(vault, filename), role);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) fail("DPAPI returned an empty secret.");
  return bytes;
}

const RESTORE_ROLES = Object.freeze([
  Object.freeze({
    name: "publisherProvenance",
    role: "publisher-provenance",
    purpose: "application",
    privateFile: PRIVATE_FILES.publisherProvenance,
    recoveryFile: RECOVERY_FILES.publisherProvenance,
    signing: true,
  }),
  Object.freeze({
    name: "hostEvidence",
    role: "host-evidence",
    purpose: "backup",
    privateFile: PRIVATE_FILES.hostEvidence,
    recoveryFile: RECOVERY_FILES.hostEvidence,
    signing: true,
  }),
  Object.freeze({
    name: "secretEnvelope",
    role: "secret-envelope",
    purpose: "application",
    privateFile: PRIVATE_FILES.secretEnvelope,
    recoveryFile: RECOVERY_FILES.secretEnvelope,
    signing: false,
  }),
  Object.freeze({
    name: "backupEncryption",
    role: "backup-encryption",
    purpose: "backup",
    privateFile: PRIVATE_FILES.backupEncryption,
    recoveryFile: RECOVERY_FILES.backupEncryption,
    signing: false,
  }),
]);

function parseRecoveryCard(raw, entry, publicRecordValue) {
  if (typeof raw !== "string") fail(`${entry.name} recovery card is missing.`);
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length < 256 || bytes.length > 16 * 1024) {
    fail(`${entry.name} recovery card is outside the reviewed byte boundary.`);
  }
  const card = JSON.parse(raw);
  const expectedKeys = [
    "keyId",
    "kind",
    "mnemonic",
    "passphrase",
    "recoveryFingerprint",
    "recoveryFormat",
    "recoveryKeyId",
    "recoveryPurpose",
    "role",
    "schemaVersion",
  ].sort();
  if (
    canonicalJson(card) !== raw ||
    JSON.stringify(Object.keys(card).sort()) !== JSON.stringify(expectedKeys) ||
    card.schemaVersion !== SCHEMA ||
    card.kind !== "site-logbook-production-signing-recovery-card" ||
    card.role !== entry.role ||
    card.keyId !== publicRecordValue.keyId ||
    card.recoveryPurpose !== entry.purpose ||
    card.recoveryKeyId !== publicRecordValue.recoveryKeyId ||
    card.recoveryFingerprint !== publicRecordValue.recoveryFingerprint
  ) {
    fail(`${entry.name} recovery card does not match the public manifest.`);
  }
  keyId(
    card.keyId,
    `${entry.name}.keyId`,
    entry.signing ? KEY_ID : SYMMETRIC_KEY_ID,
  );
  const derived = deriveRecoveryMaterial({
    mnemonic: card.mnemonic,
    passphrase: card.passphrase,
    purpose: card.recoveryPurpose,
    keyId: card.recoveryKeyId,
  });
  if (
    derived.format !== card.recoveryFormat ||
    derived.fingerprint !== card.recoveryFingerprint
  ) {
    fail(`${entry.name} recovery derivation fingerprint differs.`);
  }
  const seed = Buffer.from(derived.keyBase64, "base64");
  if (seed.length !== 32) {
    seed.fill(0);
    fail(`${entry.name} recovery derivation is not 32 bytes.`);
  }
  let protectedValue;
  if (entry.signing) {
    const privateKey = ed25519FromSeed(seed);
    const publicKey = createPublicKey(privateKey);
    if (
      sha256(publicKey.export({ type: "spki", format: "der" })) !==
        publicRecordValue.publicKeySha256 ||
      publicKey.export({ type: "spki", format: "pem" }).toString() !==
        publicRecordValue.publicKeyPem
    ) {
      seed.fill(0);
      fail(`${entry.name} recovery card differs from its public SPKI pin.`);
    }
    protectedValue = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "der" }),
    );
    seed.fill(0);
  } else {
    protectedValue = seed;
  }
  return { protectedValue, recoveryBytes: bytes };
}

export function restoreProductionSigningVault({
  vault: rawVault,
  publicManifestCanonical,
  recoveryCards,
}) {
  if (process.platform !== "win32") fail("DPAPI custody requires Windows.");
  const vault = outsideRepository(rawVault, "vault");
  const manifestBytes = Buffer.isBuffer(publicManifestCanonical)
    ? Buffer.from(publicManifestCanonical)
    : Buffer.from(publicManifestCanonical, "utf8");
  const manifest = parseManifestCanonical(manifestBytes);
  const cardNames = Object.keys(recoveryCards ?? {}).sort();
  const expectedNames = RESTORE_ROLES.map((entry) => entry.name).sort();
  if (JSON.stringify(cardNames) !== JSON.stringify(expectedNames)) {
    fail("Restore requires exactly four reviewed recovery cards.");
  }
  const restored = [];
  try {
    for (const entry of RESTORE_ROLES) {
      restored.push({
        ...entry,
        ...parseRecoveryCard(
          recoveryCards[entry.name],
          entry,
          manifest[entry.name],
        ),
      });
    }
    if (restored[2].protectedValue.equals(restored[3].protectedValue)) {
      fail("Application and backup symmetric keys are not independent.");
    }
    runDpapi("verify-new-path", vault);
    mkdirSync(dirname(vault), { recursive: true });
    mkdirSync(vault, { recursive: false });
    runDpapi("secure-directory", vault);
    for (const entry of restored) {
      protect(vault, entry.role, entry.privateFile, entry.protectedValue);
      protect(vault, entry.role, entry.recoveryFile, entry.recoveryBytes);
    }
    writeExclusive(join(vault, MANIFEST_FILE), manifestBytes);
    runDpapi("verify-directory", vault);
    parseManifest(vault);
    return Object.freeze({
      vault,
      publisherKeyId: manifest.publisherProvenance.keyId,
      hostKeyId: manifest.hostEvidence.keyId,
    });
  } finally {
    manifestBytes.fill(0);
    for (const entry of restored) {
      entry.protectedValue.fill(0);
      entry.recoveryBytes.fill(0);
    }
  }
}

function requireSafeRestoreTerminal() {
  if (
    process.env.CI === "true" ||
    process.env.NODE_ENV === "production" ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    fail("Restore requires a trusted local interactive masked TTY.");
  }
  const ambient = sensitiveEnvironmentKeys(process.env);
  if (ambient.length > 0) {
    fail(`Clear ambient secrets before restore: ${ambient.join(", ")}.`);
  }
}

function promptMasked(label) {
  return new Promise((resolvePromise, rejectPromise) => {
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
          rejectPromise(new Error("PRODUCTION_SIGNING_CUSTODY_ABORTED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          if (value.length === 0) continue;
          cleanup();
          process.stdout.write("\n");
          resolvePromise(`${value}\n`);
          return;
        }
        if (code === 8 || code === 127) {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (code >= 32 && code <= 126 && value.length < 16 * 1024) {
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

async function restore(options) {
  exactOptions(options, ["vault", "public-manifest", "confirm"]);
  if (options.confirm !== "RESTORE_NEW_PRODUCTION_KEY_VAULT") {
    fail("The exact restore confirmation is required.");
  }
  requireSafeRestoreTerminal();
  const manifestPath = absolutePath(
    options["public-manifest"],
    "public-manifest",
  );
  const manifestState = statSync(manifestPath);
  if (!manifestState.isFile() || manifestState.size > 64 * 1024) {
    fail("Public restore manifest is invalid.");
  }
  const recoveryCards = {};
  for (const entry of RESTORE_ROLES) {
    recoveryCards[entry.name] = await promptMasked(
      `Paste ${entry.role} recovery card (masked), then Enter: `,
    );
  }
  const result = restoreProductionSigningVault({
    vault: options.vault,
    publicManifestCanonical: readFileSync(manifestPath),
    recoveryCards,
  });
  for (const name of Object.keys(recoveryCards)) recoveryCards[name] = "";
  process.stdout.write(
    `restored=true\nvault=${result.vault}\npublisherKeyId=${result.publisherKeyId}\nhostKeyId=${result.hostKeyId}\nprivateMaterialPrinted=false\n`,
  );
}

function init(options) {
  exactOptions(options, [
    "vault",
    "publisher-key-id",
    "host-key-id",
    "secret-key-id",
    "backup-key-id",
    "confirm",
  ]);
  if (process.platform !== "win32") fail("DPAPI custody requires Windows.");
  const vault = outsideRepository(options.vault, "vault");
  if (options.confirm !== "INITIALIZE_NEW_PRODUCTION_KEY_VAULT") {
    fail("The exact new-vault confirmation is required.");
  }
  const publisherKeyId = keyId(
    options["publisher-key-id"],
    "publisher-key-id",
    KEY_ID,
  );
  const hostKeyId = keyId(options["host-key-id"], "host-key-id", KEY_ID);
  const secretKeyId = keyId(
    options["secret-key-id"],
    "secret-key-id",
    SYMMETRIC_KEY_ID,
  );
  const backupKeyId = keyId(
    options["backup-key-id"],
    "backup-key-id",
    SYMMETRIC_KEY_ID,
  );
  if (publisherKeyId === hostKeyId || secretKeyId === backupKeyId) {
    fail("Key ids must be distinct across matching key types.");
  }
  runDpapi("verify-new-path", vault);
  mkdirSync(dirname(vault), { recursive: true });
  mkdirSync(vault, { recursive: false });
  runDpapi("secure-directory", vault);

  const publisherRecovery = recoveryMaterial(
    "publisher-provenance",
    publisherKeyId,
    "application",
  );
  const hostRecovery = recoveryMaterial("host-evidence", hostKeyId, "backup");
  const secretRecovery = recoveryMaterial(
    "secret-envelope",
    secretKeyId,
    "application",
  );
  const backupRecovery = recoveryMaterial(
    "backup-encryption",
    backupKeyId,
    "backup",
  );
  const publisherPrivate = ed25519FromSeed(publisherRecovery.key);
  const hostPrivate = ed25519FromSeed(hostRecovery.key);
  publisherRecovery.key.fill(0);
  hostRecovery.key.fill(0);
  const publisherPublic = createPublicKey(publisherPrivate);
  const hostPublic = createPublicKey(hostPrivate);
  protect(
    vault,
    "publisher-provenance",
    PRIVATE_FILES.publisherProvenance,
    Buffer.from(publisherPrivate.export({ type: "pkcs8", format: "der" })),
  );
  protect(
    vault,
    "host-evidence",
    PRIVATE_FILES.hostEvidence,
    Buffer.from(hostPrivate.export({ type: "pkcs8", format: "der" })),
  );
  protect(
    vault,
    "secret-envelope",
    PRIVATE_FILES.secretEnvelope,
    secretRecovery.key,
  );
  protect(
    vault,
    "backup-encryption",
    PRIVATE_FILES.backupEncryption,
    backupRecovery.key,
  );
  protect(
    vault,
    "publisher-provenance",
    RECOVERY_FILES.publisherProvenance,
    publisherRecovery.card,
  );
  protect(
    vault,
    "host-evidence",
    RECOVERY_FILES.hostEvidence,
    hostRecovery.card,
  );
  protect(
    vault,
    "secret-envelope",
    RECOVERY_FILES.secretEnvelope,
    secretRecovery.card,
  );
  protect(
    vault,
    "backup-encryption",
    RECOVERY_FILES.backupEncryption,
    backupRecovery.card,
  );
  const manifest = {
    schemaVersion: SCHEMA,
    kind: "site-logbook-production-signing-public-trust-roots",
    createdAt: new Date().toISOString(),
    publisherProvenance: {
      role: "publisher-provenance",
      ...publicRecord(publisherKeyId, publisherPublic),
      recoveryFingerprint: publisherRecovery.fingerprint,
      recoveryKeyId: publisherRecovery.recoveryKeyId,
    },
    hostEvidence: {
      role: "host-evidence",
      ...publicRecord(hostKeyId, hostPublic),
      recoveryFingerprint: hostRecovery.fingerprint,
      recoveryKeyId: hostRecovery.recoveryKeyId,
    },
    secretEnvelope: {
      role: "secret-envelope",
      keyId: secretKeyId,
      recoveryFingerprint: secretRecovery.fingerprint,
      recoveryKeyId: secretRecovery.recoveryKeyId,
    },
    backupEncryption: {
      role: "backup-encryption",
      keyId: backupKeyId,
      recoveryFingerprint: backupRecovery.fingerprint,
      recoveryKeyId: backupRecovery.recoveryKeyId,
    },
  };
  writeExclusive(join(vault, MANIFEST_FILE), canonicalJson(manifest));
  parseManifest(vault);
  process.stdout.write(
    `created=true\nmanifest=${join(vault, MANIFEST_FILE)}\nprivateMaterialPrinted=false\n`,
  );
}

function status(options) {
  exactOptions(options, ["vault"]);
  const vault = outsideRepository(options.vault, "vault");
  runDpapi("verify-directory", vault);
  const manifest = parseManifest(vault);
  for (const filename of Object.values(PRIVATE_FILES)) {
    const state = statSync(join(vault, filename));
    if (!state.isFile() || state.size < 32 || state.size > 16 * 1024) {
      fail("A protected private record is invalid.");
    }
  }
  for (const filename of Object.values(RECOVERY_FILES)) {
    const state = statSync(join(vault, filename));
    if (!state.isFile() || state.size < 32 || state.size > 16 * 1024) {
      fail("A protected recovery record is invalid.");
    }
  }
  const roles = [
    {
      name: "publisherProvenance",
      role: "publisher-provenance",
      purpose: "application",
      privateFile: PRIVATE_FILES.publisherProvenance,
      recoveryFile: RECOVERY_FILES.publisherProvenance,
      publicRecord: manifest.publisherProvenance,
      signing: true,
    },
    {
      name: "hostEvidence",
      role: "host-evidence",
      purpose: "backup",
      privateFile: PRIVATE_FILES.hostEvidence,
      recoveryFile: RECOVERY_FILES.hostEvidence,
      publicRecord: manifest.hostEvidence,
      signing: true,
    },
    {
      name: "secretEnvelope",
      role: "secret-envelope",
      purpose: "application",
      privateFile: PRIVATE_FILES.secretEnvelope,
      recoveryFile: RECOVERY_FILES.secretEnvelope,
      publicRecord: manifest.secretEnvelope,
      signing: false,
    },
    {
      name: "backupEncryption",
      role: "backup-encryption",
      purpose: "backup",
      privateFile: PRIVATE_FILES.backupEncryption,
      recoveryFile: RECOVERY_FILES.backupEncryption,
      publicRecord: manifest.backupEncryption,
      signing: false,
    },
  ];
  for (const entry of roles) {
    const protectedValue = unprotect(vault, entry.role, entry.privateFile);
    const recoveryBytes = unprotect(vault, entry.role, entry.recoveryFile);
    let derived;
    try {
      const cardRaw = recoveryBytes.toString("utf8");
      const card = JSON.parse(cardRaw);
      if (
        canonicalJson(card) !== cardRaw ||
        card.schemaVersion !== SCHEMA ||
        card.kind !== "site-logbook-production-signing-recovery-card" ||
        card.role !== entry.role ||
        card.keyId !== entry.publicRecord.keyId ||
        card.recoveryPurpose !== entry.purpose ||
        card.recoveryKeyId !== entry.publicRecord.recoveryKeyId ||
        card.recoveryFingerprint !== entry.publicRecord.recoveryFingerprint
      ) {
        fail(`${entry.name} recovery card does not match the public manifest.`);
      }
      derived = deriveRecoveryMaterial({
        mnemonic: card.mnemonic,
        passphrase: card.passphrase,
        purpose: card.recoveryPurpose,
        keyId: card.recoveryKeyId,
      });
      if (derived.fingerprint !== card.recoveryFingerprint) {
        fail(`${entry.name} recovery derivation fingerprint differs.`);
      }
      const seed = Buffer.from(derived.keyBase64, "base64");
      try {
        if (entry.signing) {
          const recoveredPrivate = ed25519FromSeed(seed);
          const recoveredDer = Buffer.from(
            recoveredPrivate.export({ type: "pkcs8", format: "der" }),
          );
          try {
            if (!recoveredDer.equals(protectedValue)) {
              fail(
                `${entry.name} protected key differs from its recovery card.`,
              );
            }
            const recoveredPublic = createPublicKey(recoveredPrivate);
            if (
              sha256(
                recoveredPublic.export({ type: "spki", format: "der" }),
              ) !== entry.publicRecord.publicKeySha256
            ) {
              fail(`${entry.name} protected key differs from its public pin.`);
            }
          } finally {
            recoveredDer.fill(0);
          }
        } else if (!seed.equals(protectedValue)) {
          fail(`${entry.name} protected key differs from its recovery card.`);
        }
      } finally {
        seed.fill(0);
      }
    } finally {
      protectedValue.fill(0);
      recoveryBytes.fill(0);
    }
  }
  process.stdout.write(
    [
      "ready=true",
      `publisherKeyId=${manifest.publisherProvenance.keyId}`,
      `publisherPublicKeySha256=${manifest.publisherProvenance.publicKeySha256}`,
      `hostKeyId=${manifest.hostEvidence.keyId}`,
      `hostPublicKeySha256=${manifest.hostEvidence.publicKeySha256}`,
      `secretKeyId=${manifest.secretEnvelope.keyId}`,
      `backupKeyId=${manifest.backupEncryption.keyId}`,
      "privateMaterialPrinted=false",
      "recoveryCardsProtected=true",
      "recoveryBindingsVerified=true",
      "",
    ].join("\n"),
  );
}

function signArtifact(options) {
  exactOptions(options, ["vault", "purpose", "input", "output"]);
  const vault = outsideRepository(options.vault, "vault");
  const input = absolutePath(options.input, "input");
  const output = outsideRepository(options.output, "output");
  if (isWithin(REPOSITORY_ROOT, input)) {
    // Public canonical evidence may be read from a reviewed checkout.
  }
  const bytes = readFileSync(input);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    fail("Signing input is outside the reviewed byte boundary.");
  }
  const manifest = parseManifest(vault);
  let role;
  let filename;
  let publicRecordValue;
  let payload = bytes;
  if (options.purpose === "publisher-provenance") {
    role = "publisher-provenance";
    filename = PRIVATE_FILES.publisherProvenance;
    publicRecordValue = manifest.publisherProvenance;
  } else if (options.purpose === "host-attestation") {
    role = "host-evidence";
    filename = PRIVATE_FILES.hostEvidence;
    publicRecordValue = manifest.hostEvidence;
  } else if (options.purpose === "backup-receipt") {
    role = "host-evidence";
    filename = PRIVATE_FILES.hostEvidence;
    publicRecordValue = manifest.hostEvidence;
    payload = Buffer.concat([
      Buffer.from(`${BACKUP_SIGNATURE_DOMAIN}\0`, "utf8"),
      bytes,
    ]);
  } else {
    fail("purpose is invalid.");
  }
  const privateBytes = unprotect(vault, role, filename);
  try {
    const privateKey = createPrivateKey({
      key: privateBytes,
      type: "pkcs8",
      format: "der",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      fail("Protected signing key is not Ed25519.");
    }
    const publicKey = createPublicKey(privateKey);
    if (
      sha256(publicKey.export({ type: "spki", format: "der" })) !==
      publicRecordValue.publicKeySha256
    ) {
      fail("Protected private key does not match its public pin.");
    }
    const signature = sign(null, payload, privateKey);
    if (!verify(null, payload, publicKey, signature)) {
      fail("Detached signature self-verification failed.");
    }
    writeExclusive(output, signature);
  } finally {
    privateBytes.fill(0);
    if (payload !== bytes) payload.fill(0);
    bytes.fill(0);
  }
  process.stdout.write(
    `signed=true\npurpose=${options.purpose}\nkeyId=${publicRecordValue.keyId}\noutput=${output}\nprivateMaterialPrinted=false\n`,
  );
}

async function exportCoolifyClipboard(options) {
  exactOptions(options, ["vault", "clipboard-seconds", "confirm"]);
  const vault = outsideRepository(options.vault, "vault");
  if (options.confirm !== "COPY_COOLIFY_SECRETS_TO_CLIPBOARD") {
    fail("The exact clipboard confirmation is required.");
  }
  const seconds = Number(options["clipboard-seconds"]);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 600) {
    fail("clipboard-seconds must be an integer from 30 through 600.");
  }
  runDpapi("verify-directory", vault);
  const manifest = parseManifest(vault);
  const secret = unprotect(
    vault,
    "secret-envelope",
    PRIVATE_FILES.secretEnvelope,
  );
  const backup = unprotect(
    vault,
    "backup-encryption",
    PRIVATE_FILES.backupEncryption,
  );
  try {
    if (secret.length !== 32 || backup.length !== 32 || secret.equals(backup)) {
      fail("Symmetric custody keys are invalid or not independent.");
    }
    const secretRing = JSON.stringify({
      [manifest.secretEnvelope.keyId]: secret.toString("base64"),
    });
    const backupRing = JSON.stringify({
      [manifest.backupEncryption.keyId]: backup.toString("base64"),
    });
    const clipboard = [
      `SECRET_ENCRYPTION_KEYRING=${secretRing}`,
      `SECRET_ENCRYPTION_ACTIVE_KEY_ID=${manifest.secretEnvelope.keyId}`,
      `BACKUP_ENCRYPTION_KEYRING=${backupRing}`,
      `BACKUP_ENCRYPTION_ACTIVE_KEY_ID=${manifest.backupEncryption.keyId}`,
      "",
    ].join("\n");
    await runClipboard(vault, seconds, clipboard);
  } finally {
    secret.fill(0);
    backup.fill(0);
  }
  process.stdout.write(
    "exported=true\ncontainsSecrets=true\nprivateMaterialPrinted=false\n",
  );
}

async function exportRecoveryClipboard(options) {
  exactOptions(options, ["vault", "role", "clipboard-seconds", "confirm"]);
  const vault = outsideRepository(options.vault, "vault");
  if (options.confirm !== "COPY_RECOVERY_CARD_TO_CLIPBOARD") {
    fail("The exact recovery-card confirmation is required.");
  }
  const seconds = Number(options["clipboard-seconds"]);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 600) {
    fail("clipboard-seconds must be an integer from 30 through 600.");
  }
  const roles = {
    "publisher-provenance": [
      "publisher-provenance",
      RECOVERY_FILES.publisherProvenance,
    ],
    "host-evidence": ["host-evidence", RECOVERY_FILES.hostEvidence],
    "secret-envelope": ["secret-envelope", RECOVERY_FILES.secretEnvelope],
    "backup-encryption": ["backup-encryption", RECOVERY_FILES.backupEncryption],
  };
  const selected = roles[options.role];
  if (!selected) fail("Recovery-card role is invalid.");
  runDpapi("verify-directory", vault);
  const card = unprotect(vault, selected[0], selected[1]);
  try {
    await runClipboard(vault, seconds, card.toString("utf8"));
  } finally {
    card.fill(0);
  }
  process.stdout.write(
    `exported=true\nrole=${options.role}\ncontainsSecrets=true\nprivateMaterialPrinted=false\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "init") return init(options);
  if (command === "restore") return restore(options);
  if (command === "status") return status(options);
  if (command === "sign") return signArtifact(options);
  if (command === "export-coolify-clipboard")
    return exportCoolifyClipboard(options);
  if (command === "export-recovery-clipboard")
    return exportRecoveryClipboard(options);
  fail("Command is missing or unsupported.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
