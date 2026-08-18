import type {
  DeviceCredential,
  JablotronUser,
  NetworkDevice,
} from "@workspace/db";
import {
  decryptSecretValue,
  encryptSecretValue,
  envelopeKeyId,
  SecretEncryptionError,
} from "./secret-envelope";

export type DeviceCredentialSecretPayload = {
  ipAddress: string | null;
  pin: string | null;
  username: string | null;
  password: string | null;
  email: string | null;
  note: string | null;
  users: JablotronUser[];
  networkTopology: NetworkDevice[];
};

export const DEVICE_SECRET_FIELDS = [
  "ipAddress",
  "pin",
  "username",
  "password",
  "email",
  "note",
  "users",
  "networkTopology",
] as const;

export function deviceCredentialContext(id: number): string {
  return `device_credentials:${id}:secret_payload`;
}

export function legacyDeviceSecretPayload(
  row: Pick<DeviceCredential, (typeof DEVICE_SECRET_FIELDS)[number]>,
): DeviceCredentialSecretPayload {
  return {
    ipAddress: row.ipAddress,
    pin: row.pin,
    username: row.username,
    password: row.password,
    email: row.email,
    note: row.note,
    users: row.users,
    networkTopology: row.networkTopology,
  };
}

function validatePayload(value: unknown): DeviceCredentialSecretPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const payload = value as Partial<DeviceCredentialSecretPayload>;
  for (const field of ["ipAddress", "pin", "username", "password", "email", "note"] as const) {
    if (payload[field] !== null && typeof payload[field] !== "string") {
      throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
    }
  }
  if (!Array.isArray(payload.users) || !Array.isArray(payload.networkTopology)) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  return payload as DeviceCredentialSecretPayload;
}

export function decryptDeviceCredentialPayload(
  row: DeviceCredential,
): DeviceCredentialSecretPayload {
  if (!row.secretCiphertext) return legacyDeviceSecretPayload(row);
  if (!row.secretKeyId || envelopeKeyId(row.secretCiphertext) !== row.secretKeyId) {
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
  const plaintext = decryptSecretValue(
    row.secretCiphertext,
    deviceCredentialContext(row.id),
  );
  try {
    return validatePayload(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof SecretEncryptionError) throw error;
    throw new SecretEncryptionError("Invalid encrypted envelope.", "invalid_envelope");
  }
}

export function encryptDeviceCredentialPayload(
  id: number,
  payload: DeviceCredentialSecretPayload,
): { secretCiphertext: string; secretKeyId: string; secretEncryptedAt: Date } {
  const encrypted = encryptSecretValue(
    JSON.stringify(payload),
    deviceCredentialContext(id),
  );
  return {
    secretCiphertext: encrypted.ciphertext,
    secretKeyId: encrypted.keyId,
    secretEncryptedAt: new Date(),
  };
}

export function hydrateDeviceCredential(row: DeviceCredential): DeviceCredential {
  return { ...row, ...decryptDeviceCredentialPayload(row) };
}

export const clearedLegacyDeviceSecrets = {
  ipAddress: null,
  pin: null,
  username: null,
  password: null,
  email: null,
  note: null,
  users: [] as JablotronUser[],
  networkTopology: [] as NetworkDevice[],
};
