import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, emailSettingsTable, type EmailSettings } from "@workspace/db";
import { UpdateEmailSettingsBody, SendTestEmailBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { sendTestEmail } from "../lib/email";
import { hasStoredSecret, writeStoredSecret } from "../lib/stored-secret";

const router: IRouter = Router();

const SINGLETON_ID = 1;

// All e-mail configuration is admin-only (it contains credentials).
router.use("/email-settings", requireRole("admin"));

function computeSource(row: EmailSettings | undefined): "db" | "env" | "none" {
  if (row?.enabled && row.host) return "db";
  if (process.env.SMTP_HOST) return "env";
  return "none";
}

function serialize(row: EmailSettings | undefined) {
  return {
    enabled: row?.enabled ?? false,
    host: row?.host ?? null,
    port: row?.port ?? 587,
    secure: row?.secure ?? false,
    username: row?.username ?? null,
    fromAddress: row?.fromAddress ?? null,
    fromName: row?.fromName ?? null,
    passwordSet: row
      ? hasStoredSecret({ plaintext: row.password, ciphertext: row.passwordCiphertext })
      : false,
    source: computeSource(row),
  };
}

router.get("/email-settings", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(emailSettingsTable)
    .where(eq(emailSettingsTable.id, SINGLETON_ID));
  res.json(serialize(row));
});

router.put("/email-settings", async (req, res): Promise<void> => {
  const parsed = UpdateEmailSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;

  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    res.status(400).json({ error: "Port musí být celé číslo v rozsahu 1–65535." });
    return;
  }

  const [existing] = await db
    .select()
    .from(emailSettingsTable)
    .where(eq(emailSettingsTable.id, SINGLETON_ID));

  // Password is write-only: a string (incl. empty) sets/clears it; null/omitted keeps it.
  const password = writeStoredSecret(
    d.password,
    existing
      ? {
          plaintext: existing.password,
          ciphertext: existing.passwordCiphertext,
          keyId: existing.passwordKeyId,
          encryptedAt: existing.passwordEncryptedAt,
        }
      : undefined,
    "email_settings:1:password",
  );

  const values = {
    id: SINGLETON_ID,
    enabled: d.enabled,
    host: d.host?.trim() || null,
    port: d.port,
    secure: d.secure,
    username: d.username?.trim() || null,
    password: password.plaintext,
    passwordCiphertext: password.ciphertext,
    passwordKeyId: password.keyId,
    passwordEncryptedAt: password.encryptedAt,
    fromAddress: d.fromAddress?.trim() || null,
    fromName: d.fromName?.trim() || null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(emailSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: emailSettingsTable.id, set: values })
    .returning();

  res.json(serialize(row));
});

router.post("/email-settings/test", async (req, res): Promise<void> => {
  const parsed = SendTestEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const to = parsed.data.to.trim();
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) {
    res.status(400).json({ error: "Neplatná e-mailová adresa." });
    return;
  }

  try {
    await sendTestEmail(to);
  } catch (err) {
    req.log.error({ err }, "Failed to send test email");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Odeslání testovacího e-mailu selhalo.",
    });
    return;
  }

  res.json({ sent: true, to });
});

export default router;
