import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  emailImportSettingsTable,
  emailImportLogTable,
  type EmailImportSettings,
} from "@workspace/db";
import { UpdateEmailImportSettingsBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import {
  testImapConnection,
  pollAndRecord,
} from "../lib/email-import";

const router: IRouter = Router();

const SINGLETON_ID = 1;

// All incoming-mail configuration is admin-only (it contains credentials).
router.use("/email-import-settings", requireRole("admin"));
router.use("/email-import-log", requireRole("admin"));
router.use("/email-import/poll", requireRole("admin"));

function computeSource(row: EmailImportSettings | undefined): "db" | "env" | "none" {
  if (row?.enabled && row.host) return "db";
  if (process.env.IMAP_HOST) return "env";
  return "none";
}

function serialize(row: EmailImportSettings | undefined) {
  return {
    enabled: row?.enabled ?? false,
    host: row?.host ?? null,
    port: row?.port ?? 993,
    secure: row?.secure ?? true,
    username: row?.username ?? null,
    folder: row?.folder ?? "INBOX",
    markSeen: row?.markSeen ?? true,
    pollMinutes: row?.pollMinutes ?? 15,
    passwordSet: Boolean(row?.password),
    lastPolledAt: row?.lastPolledAt ? row.lastPolledAt.toISOString() : null,
    lastStatus: row?.lastStatus ?? null,
    lastError: row?.lastError ?? null,
    source: computeSource(row),
  };
}

router.get("/email-import-settings", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(emailImportSettingsTable)
    .where(eq(emailImportSettingsTable.id, SINGLETON_ID));
  res.json(serialize(row));
});

router.put("/email-import-settings", async (req, res): Promise<void> => {
  const parsed = UpdateEmailImportSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;

  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    res.status(400).json({ error: "Port musí být celé číslo v rozsahu 1–65535." });
    return;
  }
  if (!Number.isInteger(d.pollMinutes) || d.pollMinutes < 1 || d.pollMinutes > 1440) {
    res.status(400).json({ error: "Interval musí být v rozsahu 1–1440 minut." });
    return;
  }

  const [existing] = await db
    .select()
    .from(emailImportSettingsTable)
    .where(eq(emailImportSettingsTable.id, SINGLETON_ID));

  // Password is write-only: a string (incl. empty) sets/clears it; null/omitted keeps it.
  const password =
    typeof d.password === "string" ? d.password : existing?.password ?? null;

  const values = {
    id: SINGLETON_ID,
    enabled: d.enabled,
    host: d.host?.trim() || null,
    port: d.port,
    secure: d.secure,
    username: d.username?.trim() || null,
    password,
    folder: d.folder?.trim() || "INBOX",
    markSeen: d.markSeen,
    pollMinutes: d.pollMinutes,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(emailImportSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: emailImportSettingsTable.id, set: values })
    .returning();

  res.json(serialize(row));
});

router.post("/email-import-settings/test", async (req, res): Promise<void> => {
  try {
    const info = await testImapConnection();
    res.json({ ok: true, folder: info.folder, messages: info.messages });
  } catch (err) {
    req.log.error({ err }, "IMAP connection test failed");
    res.status(502).json({
      error:
        err instanceof Error ? err.message : "Připojení k poštovní schránce selhalo.",
    });
  }
});

router.post("/email-import/poll", async (req, res): Promise<void> => {
  try {
    const result = await pollAndRecord();
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Manual email import poll failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Načtení e-mailů selhalo.",
    });
  }
});

router.get("/email-import-log", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(emailImportLogTable)
    .orderBy(desc(emailImportLogTable.createdAt))
    .limit(100);
  res.json(
    rows.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      sender: r.sender,
      subject: r.subject,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
      status: r.status,
      attachmentsTotal: r.attachmentsTotal,
      attachmentsImported: r.attachmentsImported,
      documentIds: r.documentIds,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

export default router;
