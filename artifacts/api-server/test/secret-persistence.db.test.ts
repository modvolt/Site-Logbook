import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  customersTable,
  db,
  deviceCredentialsTable,
  emailImportSettingsTable,
  emailSettingsTable,
  openaiSettingsTable,
  pool,
} from "@workspace/db";
import {
  clearedLegacyDeviceSecrets,
  encryptDeviceCredentialPayload,
  hydrateDeviceCredential,
} from "../src/lib/device-credential-secrets";
import { encryptSecretValue } from "../src/lib/secret-envelope";
import { resolveEmailConfig } from "../src/lib/email";
import { resolveImapConfig } from "../src/lib/email-import";
import { resolveOpenAiConfig } from "../src/lib/openai-extraction";

if (process.env.SECRET_PERSISTENCE_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing secret persistence DB test without SECRET_PERSISTENCE_DB_TEST_ENABLED=true.",
  );
}

const keyId = "db-test-key";
let customerId: number;
let credentialId: number;

beforeAll(async () => {
  process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID = keyId;
  process.env.SECRET_ENCRYPTION_KEYRING = JSON.stringify({
    [keyId]: Buffer.alloc(32, 0x73).toString("base64"),
  });
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.id, 1));
  await db.delete(emailImportSettingsTable).where(eq(emailImportSettingsTable.id, 1));
  await db.delete(openaiSettingsTable).where(eq(openaiSettingsTable.id, 1));

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `R05 secret test ${Date.now()}` })
    .returning();
  customerId = customer.id;

  const [inserted] = await db
    .insert(deviceCredentialsTable)
    .values({ customerId, type: "r05-test", ...clearedLegacyDeviceSecrets })
    .returning();
  credentialId = inserted.id;
  const encrypted = encryptDeviceCredentialPayload(inserted.id, {
    ipAddress: "192.0.2.20",
    pin: "2468",
    username: "service-user",
    password: "device-secret-canary",
    email: "service@example.test",
    note: "encrypted note",
    users: [],
    networkTopology: [],
  });
  await db
    .update(deviceCredentialsTable)
    .set(encrypted)
    .where(eq(deviceCredentialsTable.id, inserted.id));

  const smtp = encryptSecretValue("smtp-secret-canary", "email_settings:1:password");
  await db.insert(emailSettingsTable).values({
    id: 1,
    enabled: true,
    host: "smtp.example.test",
    port: 587,
    username: "smtp-user",
    fromAddress: "sender@example.test",
    password: null,
    passwordCiphertext: smtp.ciphertext,
    passwordKeyId: smtp.keyId,
    passwordEncryptedAt: new Date(),
  });

  const imap = encryptSecretValue(
    "imap-secret-canary",
    "email_import_settings:1:password",
  );
  await db.insert(emailImportSettingsTable).values({
    id: 1,
    enabled: true,
    host: "imap.example.test",
    port: 993,
    username: "imap-user",
    password: null,
    passwordCiphertext: imap.ciphertext,
    passwordKeyId: imap.keyId,
    passwordEncryptedAt: new Date(),
  });

  const openai = encryptSecretValue("sk-secret-canary", "openai_settings:1:api_key");
  await db.insert(openaiSettingsTable).values({
    id: 1,
    enabled: true,
    apiKey: null,
    apiKeyCiphertext: openai.ciphertext,
    apiKeyKeyId: openai.keyId,
    apiKeyEncryptedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(deviceCredentialsTable).where(eq(deviceCredentialsTable.id, credentialId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.id, 1));
  await db.delete(emailImportSettingsTable).where(eq(emailImportSettingsTable.id, 1));
  await db.delete(openaiSettingsTable).where(eq(openaiSettingsTable.id, 1));
  await pool.end();
});

describe("encrypted secret persistence", () => {
  it("keeps credential canaries out of legacy columns and hydrates the API shape", async () => {
    const [raw] = await db
      .select()
      .from(deviceCredentialsTable)
      .where(eq(deviceCredentialsTable.id, credentialId));
    expect(raw.password).toBeNull();
    expect(raw.pin).toBeNull();
    expect(raw.users).toEqual([]);
    expect(raw.secretCiphertext).toMatch(/^mve1\./);
    expect(raw.secretCiphertext).not.toContain("device-secret-canary");
    expect(hydrateDeviceCredential(raw)).toMatchObject({
      password: "device-secret-canary",
      pin: "2468",
      username: "service-user",
    });
  });

  it("resolves encrypted SMTP, IMAP and OpenAI settings without plaintext persistence", async () => {
    const [smtpRaw] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.id, 1));
    const [imapRaw] = await db
      .select()
      .from(emailImportSettingsTable)
      .where(eq(emailImportSettingsTable.id, 1));
    const [openAiRaw] = await db
      .select()
      .from(openaiSettingsTable)
      .where(eq(openaiSettingsTable.id, 1));
    expect([smtpRaw.password, imapRaw.password, openAiRaw.apiKey]).toEqual([
      null,
      null,
      null,
    ]);
    await expect(resolveEmailConfig()).resolves.toMatchObject({
      pass: "smtp-secret-canary",
    });
    await expect(resolveImapConfig()).resolves.toMatchObject({
      pass: "imap-secret-canary",
    });
    await expect(resolveOpenAiConfig()).resolves.toMatchObject({
      apiKey: "sk-secret-canary",
      source: "db",
    });
  });

  it("fails closed on a tampered credential envelope even though legacy columns are empty", async () => {
    const [raw] = await db
      .select()
      .from(deviceCredentialsTable)
      .where(eq(deviceCredentialsTable.id, credentialId));
    const payload = Buffer.from(raw.secretCiphertext!.slice(5), "base64url");
    payload[payload.length - 1] ^= 1;
    const tampered = `mve1.${payload.toString("base64url")}`;
    expect(() => hydrateDeviceCredential({ ...raw, secretCiphertext: tampered })).toThrow(
      /authentication failed/i,
    );
  });
});
