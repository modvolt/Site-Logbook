import {
  decryptSecretValue,
  encryptSecretValue,
  envelopeKeyId,
  SecretEncryptionError,
} from "./secret-envelope";

export type StoredSecretColumns = {
  plaintext: string | null;
  ciphertext: string | null;
  keyId: string | null;
  encryptedAt: Date | null;
};

export function readStoredSecret(
  stored: StoredSecretColumns,
  context: string,
): string | null {
  if (!stored.ciphertext) return stored.plaintext;
  if (!stored.keyId || envelopeKeyId(stored.ciphertext) !== stored.keyId) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  return decryptSecretValue(stored.ciphertext, context);
}

export function writeStoredSecret(
  input: string | null | undefined,
  existing: StoredSecretColumns | undefined,
  context: string,
): StoredSecretColumns {
  // null/omitted is the API contract for preserving a write-only secret.
  if (typeof input !== "string") {
    return (
      existing ?? {
        plaintext: null,
        ciphertext: null,
        keyId: null,
        encryptedAt: null,
      }
    );
  }
  if (input.length === 0) {
    return { plaintext: null, ciphertext: null, keyId: null, encryptedAt: null };
  }
  const encrypted = encryptSecretValue(input, context);
  return {
    plaintext: null,
    ciphertext: encrypted.ciphertext,
    keyId: encrypted.keyId,
    encryptedAt: new Date(),
  };
}

export function hasStoredSecret(stored: Pick<StoredSecretColumns, "plaintext" | "ciphertext">): boolean {
  return Boolean(stored.ciphertext || stored.plaintext);
}
