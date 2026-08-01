import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "mve1";
const BINARY_MAGIC = Buffer.from("MVE1", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_HEADER_LENGTH = 4_096;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const SECRET_KEYRING_ENV = "SECRET_ENCRYPTION_KEYRING";
export const SECRET_ACTIVE_KEY_ENV = "SECRET_ENCRYPTION_ACTIVE_KEY_ID";
export const BACKUP_KEYRING_ENV = "BACKUP_ENCRYPTION_KEYRING";
export const BACKUP_ACTIVE_KEY_ENV = "BACKUP_ENCRYPTION_ACTIVE_KEY_ID";

export class SecretEncryptionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "keyring_not_configured"
      | "keyring_invalid"
      | "active_key_missing"
      | "unknown_key_id"
      | "invalid_envelope"
      | "authentication_failed",
  ) {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

export type EncryptionKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

type EnvelopeHeader = {
  k: string;
  wi: string;
  wt: string;
  wk: string;
  di: string;
  dt: string;
};

function invalidKeyring(): SecretEncryptionError {
  return new SecretEncryptionError(
    "Encryption keyring has an invalid format.",
    "keyring_invalid",
  );
}

function decodeCanonicalKey(value: unknown): Buffer {
  if (typeof value !== "string") throw invalidKeyring();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== KEY_LENGTH || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw invalidKeyring();
  }
  return decoded;
}

export function loadEncryptionKeyring(
  keyringEnv = SECRET_KEYRING_ENV,
  activeKeyEnv = SECRET_ACTIVE_KEY_ENV,
): EncryptionKeyring {
  const raw = process.env[keyringEnv]?.trim();
  const activeKeyId = process.env[activeKeyEnv]?.trim();
  if (!raw || !activeKeyId) {
    throw new SecretEncryptionError(
      "Encryption keyring is not configured.",
      "keyring_not_configured",
    );
  }
  if (!KEY_ID_PATTERN.test(activeKeyId)) throw invalidKeyring();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidKeyring();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidKeyring();
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32) throw invalidKeyring();
  const keys = new Map<string, Buffer>();
  try {
    for (const [keyId, encoded] of entries) {
      if (!KEY_ID_PATTERN.test(keyId)) throw invalidKeyring();
      keys.set(keyId, decodeCanonicalKey(encoded));
    }
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    throw error;
  }
  if (!keys.has(activeKeyId)) {
    for (const key of keys.values()) key.fill(0);
    throw new SecretEncryptionError(
      "The active encryption key is absent from the keyring.",
      "active_key_missing",
    );
  }
  return { activeKeyId, keys };
}

function aad(kind: "data" | "wrap", context: string, keyId?: string): Buffer {
  if (!context || context.length > 512) {
    throw new SecretEncryptionError("Invalid encryption context.", "invalid_envelope");
  }
  return Buffer.from(
    `modvolt:${FORMAT_VERSION}:${kind}:${keyId ?? "-"}:${context}`,
    "utf8",
  );
}

function encryptAesGcm(data: Buffer, key: Buffer, context: Buffer) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decryptAesGcm(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  context: Buffer,
): Buffer {
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(context);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SecretEncryptionError(
      "Encrypted value authentication failed.",
      "authentication_failed",
    );
  }
}

function parseB64(value: unknown): Buffer {
  if (typeof value !== "string" || !value) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
}

function encodeEnvelope(data: Buffer, context: string, keyring: EncryptionKeyring): Buffer {
  const kek = keyring.keys.get(keyring.activeKeyId);
  if (!kek) {
    throw new SecretEncryptionError(
      "The active encryption key is absent from the keyring.",
      "active_key_missing",
    );
  }

  const dataKey = randomBytes(KEY_LENGTH);
  try {
    const encryptedData = encryptAesGcm(data, dataKey, aad("data", context));
    const wrappedKey = encryptAesGcm(
      dataKey,
      kek,
      aad("wrap", context, keyring.activeKeyId),
    );
    const header: EnvelopeHeader = {
      k: keyring.activeKeyId,
      wi: wrappedKey.iv.toString("base64url"),
      wt: wrappedKey.tag.toString("base64url"),
      wk: wrappedKey.ciphertext.toString("base64url"),
      di: encryptedData.iv.toString("base64url"),
      dt: encryptedData.tag.toString("base64url"),
    };
    const encodedHeader = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encodedHeader.length);
    return Buffer.concat([
      BINARY_MAGIC,
      length,
      encodedHeader,
      encryptedData.ciphertext,
    ]);
  } finally {
    dataKey.fill(0);
  }
}

function decodeEnvelope(
  envelope: Buffer,
  context: string,
  keyring: EncryptionKeyring,
): { plaintext: Buffer; keyId: string } {
  if (
    envelope.length < BINARY_MAGIC.length + 4 + 1 ||
    !envelope.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)
  ) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const headerLength = envelope.readUInt32BE(BINARY_MAGIC.length);
  const headerStart = BINARY_MAGIC.length + 4;
  const dataStart = headerStart + headerLength;
  if (
    headerLength < 1 ||
    headerLength > MAX_HEADER_LENGTH ||
    dataStart >= envelope.length
  ) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }

  let header: EnvelopeHeader;
  try {
    header = JSON.parse(envelope.subarray(headerStart, dataStart).toString("utf8"));
  } catch {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  if (!header || typeof header !== "object" || !KEY_ID_PATTERN.test(header.k)) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const kek = keyring.keys.get(header.k);
  if (!kek) {
    throw new SecretEncryptionError(
      "The encrypted value references an unavailable key.",
      "unknown_key_id",
    );
  }

  const dataKey = decryptAesGcm(
    parseB64(header.wk),
    kek,
    parseB64(header.wi),
    parseB64(header.wt),
    aad("wrap", context, header.k),
  );
  if (dataKey.length !== KEY_LENGTH) {
    dataKey.fill(0);
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  try {
    return {
      plaintext: decryptAesGcm(
        envelope.subarray(dataStart),
        dataKey,
        parseB64(header.di),
        parseB64(header.dt),
        aad("data", context),
      ),
      keyId: header.k,
    };
  } finally {
    dataKey.fill(0);
  }
}

export function encryptSecretValue(
  plaintext: string,
  context: string,
  keyring = loadEncryptionKeyring(),
): { ciphertext: string; keyId: string } {
  const envelope = encodeEnvelope(Buffer.from(plaintext, "utf8"), context, keyring);
  return {
    ciphertext: `${FORMAT_VERSION}.${envelope.toString("base64url")}`,
    keyId: keyring.activeKeyId,
  };
}

export function decryptSecretValue(
  ciphertext: string,
  context: string,
  keyring = loadEncryptionKeyring(),
): string {
  const prefix = `${FORMAT_VERSION}.`;
  if (!ciphertext.startsWith(prefix)) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const envelope = Buffer.from(ciphertext.slice(prefix.length), "base64url");
  return decodeEnvelope(envelope, context, keyring).plaintext.toString("utf8");
}

export function envelopeKeyId(ciphertext: string): string {
  const prefix = `${FORMAT_VERSION}.`;
  if (!ciphertext.startsWith(prefix)) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const envelope = Buffer.from(ciphertext.slice(prefix.length), "base64url");
  if (
    envelope.length < BINARY_MAGIC.length + 4 + 1 ||
    !envelope.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)
  ) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const headerLength = envelope.readUInt32BE(BINARY_MAGIC.length);
  const headerStart = BINARY_MAGIC.length + 4;
  if (
    headerLength < 1 ||
    headerLength > MAX_HEADER_LENGTH ||
    headerStart + headerLength > envelope.length
  ) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  try {
    const header = JSON.parse(
      envelope
        .subarray(headerStart, headerStart + headerLength)
        .toString("utf8"),
    ) as EnvelopeHeader;
    if (!KEY_ID_PATTERN.test(header.k)) throw new Error("bad key id");
    return header.k;
  } catch {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
}

export function encryptBackupPayload(
  plaintext: Buffer,
  filename: string,
  keyring = loadEncryptionKeyring(BACKUP_KEYRING_ENV, BACKUP_ACTIVE_KEY_ENV),
): { payload: Buffer; keyId: string; format: typeof FORMAT_VERSION } {
  return {
    payload: encodeEnvelope(plaintext, `backup_log:${filename}:pg_dump`, keyring),
    keyId: keyring.activeKeyId,
    format: FORMAT_VERSION,
  };
}

export function decryptBackupPayload(
  payload: Buffer,
  filename: string,
  keyring = loadEncryptionKeyring(BACKUP_KEYRING_ENV, BACKUP_ACTIVE_KEY_ENV),
): Buffer {
  return decodeEnvelope(payload, `backup_log:${filename}:pg_dump`, keyring).plaintext;
}

export function encryptionStatus(
  keyringEnv = SECRET_KEYRING_ENV,
  activeKeyEnv = SECRET_ACTIVE_KEY_ENV,
): { configured: boolean; activeKeyId: string | null; keyIds: string[]; errorCode: string | null } {
  try {
    const keyring = loadEncryptionKeyring(keyringEnv, activeKeyEnv);
    return {
      configured: true,
      activeKeyId: keyring.activeKeyId,
      keyIds: [...keyring.keys.keys()].sort(),
      errorCode: null,
    };
  } catch (error) {
    return {
      configured: false,
      activeKeyId: null,
      keyIds: [],
      errorCode:
        error instanceof SecretEncryptionError ? error.code : "keyring_invalid",
    };
  }
}
