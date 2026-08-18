import { eq } from "drizzle-orm";
import {
  db,
  deviceCredentialsTable,
  emailImportAccountsTable,
  emailImportSettingsTable,
  emailSettingsTable,
  openaiSettingsTable,
  switchboardsTable,
} from "@workspace/db";
import {
  clearedLegacyDeviceSecrets,
  decryptDeviceCredentialPayload,
  encryptDeviceCredentialPayload,
} from "../lib/device-credential-secrets";
import { decryptToken, encryptToken } from "../lib/token-crypto";
import { decryptQrToken, encryptQrToken } from "../lib/switchboard-qr";
import {
  encryptSecretValue,
  encryptionStatus,
  envelopeKeyId,
} from "../lib/secret-envelope";
import { readStoredSecret } from "../lib/stored-secret";

type Counts = {
  deviceCredentials: number;
  smtpPasswords: number;
  imapPasswords: number;
  openAiKeys: number;
  gmailRefreshTokens: number;
  switchboardQrTokens: number;
};

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const confirmation = [...args].find((arg) => arg.startsWith("--confirm="))?.slice(10);
const expectedDatabase = [...args].find((arg) => arg.startsWith("--database="))?.slice(11);

function databaseName(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }
}

function emptyCounts(): Counts {
  return {
    deviceCredentials: 0,
    smtpPasswords: 0,
    imapPasswords: 0,
    openAiKeys: 0,
    gmailRefreshTokens: 0,
    switchboardQrTokens: 0,
  };
}

async function candidates(activeKeyId: string): Promise<{
  counts: Counts;
  devices: Awaited<ReturnType<typeof loadDevices>>;
  smtp: Awaited<ReturnType<typeof loadSmtp>>;
  imap: Awaited<ReturnType<typeof loadImap>>;
  openai: Awaited<ReturnType<typeof loadOpenAi>>;
  gmail: Awaited<ReturnType<typeof loadGmail>>;
  qr: Awaited<ReturnType<typeof loadQr>>;
}> {
  const [devices, smtp, imap, openai, gmail, qr] = await Promise.all([
    loadDevices(activeKeyId),
    loadSmtp(activeKeyId),
    loadImap(activeKeyId),
    loadOpenAi(activeKeyId),
    loadGmail(activeKeyId),
    loadQr(activeKeyId),
  ]);
  return {
    counts: {
      deviceCredentials: devices.length,
      smtpPasswords: smtp.length,
      imapPasswords: imap.length,
      openAiKeys: openai.length,
      gmailRefreshTokens: gmail.length,
      switchboardQrTokens: qr.length,
    },
    devices,
    smtp,
    imap,
    openai,
    gmail,
    qr,
  };
}

async function loadDevices(activeKeyId: string) {
  const rows = await db.select().from(deviceCredentialsTable).orderBy(deviceCredentialsTable.id);
  return rows.filter((row) => !row.secretCiphertext || row.secretKeyId !== activeKeyId);
}

async function loadSmtp(activeKeyId: string) {
  const rows = await db.select().from(emailSettingsTable).orderBy(emailSettingsTable.id);
  return rows.filter(
    (row) =>
      Boolean(row.password || row.passwordCiphertext) && row.passwordKeyId !== activeKeyId,
  );
}

async function loadImap(activeKeyId: string) {
  const rows = await db.select().from(emailImportSettingsTable).orderBy(emailImportSettingsTable.id);
  return rows.filter(
    (row) =>
      Boolean(row.password || row.passwordCiphertext) && row.passwordKeyId !== activeKeyId,
  );
}

async function loadOpenAi(activeKeyId: string) {
  const rows = await db.select().from(openaiSettingsTable).orderBy(openaiSettingsTable.id);
  return rows.filter(
    (row) => Boolean(row.apiKey || row.apiKeyCiphertext) && row.apiKeyKeyId !== activeKeyId,
  );
}

async function loadGmail(activeKeyId: string) {
  const rows = await db
    .select()
    .from(emailImportAccountsTable)
    .orderBy(emailImportAccountsTable.id);
  return rows.filter(
    (row) =>
      Boolean(row.refreshTokenEncrypted) && row.refreshTokenKeyId !== activeKeyId,
  );
}

async function loadQr(activeKeyId: string) {
  const rows = await db.select().from(switchboardsTable).orderBy(switchboardsTable.id);
  return rows.filter(
    (row) => Boolean(row.qrTokenCiphertext) && row.qrTokenKeyId !== activeKeyId,
  );
}

async function main(): Promise<void> {
  const database = databaseName();
  const status = encryptionStatus();
  if (!status.configured || !status.activeKeyId) {
    throw new Error(`Application encryption keyring is unavailable (${status.errorCode ?? "unknown"}).`);
  }

  const plan = await candidates(status.activeKeyId);
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry-run", database, planned: plan.counts }, null, 2));
    return;
  }
  if (confirmation !== "ENCRYPT_SECRETS") {
    throw new Error("Execution requires --confirm=ENCRYPT_SECRETS.");
  }
  if (!expectedDatabase || expectedDatabase !== database) {
    throw new Error("Execution requires --database=<exact DATABASE_URL database name>.");
  }

  const updated = emptyCounts();
  await db.transaction(async (tx) => {
    for (const row of plan.devices) {
      const encrypted = encryptDeviceCredentialPayload(
        row.id,
        decryptDeviceCredentialPayload(row),
      );
      await tx
        .update(deviceCredentialsTable)
        .set({ ...clearedLegacyDeviceSecrets, ...encrypted })
        .where(eq(deviceCredentialsTable.id, row.id));
      updated.deviceCredentials += 1;
    }

    for (const row of plan.smtp) {
      const value = readStoredSecret(
        {
          plaintext: row.password,
          ciphertext: row.passwordCiphertext,
          keyId: row.passwordKeyId,
          encryptedAt: row.passwordEncryptedAt,
        },
        `email_settings:${row.id}:password`,
      );
      if (!value) continue;
      const encrypted = encryptSecretValue(value, `email_settings:${row.id}:password`);
      await tx.update(emailSettingsTable).set({
        password: null,
        passwordCiphertext: encrypted.ciphertext,
        passwordKeyId: encrypted.keyId,
        passwordEncryptedAt: new Date(),
      }).where(eq(emailSettingsTable.id, row.id));
      updated.smtpPasswords += 1;
    }

    for (const row of plan.imap) {
      const value = readStoredSecret(
        {
          plaintext: row.password,
          ciphertext: row.passwordCiphertext,
          keyId: row.passwordKeyId,
          encryptedAt: row.passwordEncryptedAt,
        },
        `email_import_settings:${row.id}:password`,
      );
      if (!value) continue;
      const encrypted = encryptSecretValue(
        value,
        `email_import_settings:${row.id}:password`,
      );
      await tx.update(emailImportSettingsTable).set({
        password: null,
        passwordCiphertext: encrypted.ciphertext,
        passwordKeyId: encrypted.keyId,
        passwordEncryptedAt: new Date(),
      }).where(eq(emailImportSettingsTable.id, row.id));
      updated.imapPasswords += 1;
    }

    for (const row of plan.openai) {
      const value = readStoredSecret(
        {
          plaintext: row.apiKey,
          ciphertext: row.apiKeyCiphertext,
          keyId: row.apiKeyKeyId,
          encryptedAt: row.apiKeyEncryptedAt,
        },
        `openai_settings:${row.id}:api_key`,
      );
      if (!value) continue;
      const encrypted = encryptSecretValue(value, `openai_settings:${row.id}:api_key`);
      await tx.update(openaiSettingsTable).set({
        apiKey: null,
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyKeyId: encrypted.keyId,
        apiKeyEncryptedAt: new Date(),
      }).where(eq(openaiSettingsTable.id, row.id));
      updated.openAiKeys += 1;
    }

    for (const row of plan.gmail) {
      if (!row.refreshTokenEncrypted) continue;
      const value = decryptToken(row.refreshTokenEncrypted, row.id);
      const encrypted = encryptToken(value, row.id);
      await tx.update(emailImportAccountsTable).set({
        refreshTokenEncrypted: encrypted,
        refreshTokenKeyId: envelopeKeyId(encrypted),
        refreshTokenEncryptedAt: new Date(),
      }).where(eq(emailImportAccountsTable.id, row.id));
      updated.gmailRefreshTokens += 1;
    }

    for (const row of plan.qr) {
      if (!row.qrTokenCiphertext) continue;
      const value = decryptQrToken(row.qrTokenCiphertext, row.id);
      const encrypted = encryptQrToken(value, row.id);
      await tx.update(switchboardsTable).set({
        qrTokenCiphertext: encrypted.ciphertext,
        qrTokenKeyId: encrypted.keyId,
        qrTokenEncryptedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(switchboardsTable.id, row.id));
      updated.switchboardQrTokens += 1;
    }
  });

  console.log(JSON.stringify({ mode: "execute", database, planned: plan.counts, updated }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Secret backfill failed.");
    process.exit(1);
  });
