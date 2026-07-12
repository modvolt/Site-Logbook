/**
 * OPTIONAL Gmail import of supplier cost documents — admin-only HTTP surface.
 *
 * Every route is gated to the "admin" role via a path-scoped middleware (the
 * routers in routes/index.ts are mounted pathlessly, so we must NOT use a
 * pathless router.use(requireRole) here — it would leak to all other routers).
 *
 * The whole feature is modular: when getGmailConfig().configured is false the
 * status endpoint still works (so the UI can explain what is missing) but the
 * connect/sync/import actions return 400.
 */
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db,
  emailImportMessagesTable,
  emailImportAttachmentsTable,
  type EmailImportAccount,
  type EmailImportMessage,
  type EmailImportAttachment,
} from "@workspace/db";
import type { Actor } from "../lib/cost-document-service";
import {
  getGmailConfig,
  getActiveAccount,
  buildAuthUrl,
  completeConnect,
  disconnect,
  syncAccount,
  listLabels,
  updateAccountSettings,
  importMessage,
  setMessageStatus,
  parseLabelFilter,
} from "../lib/gmail-import";

const router: IRouter = Router();

// Where to send the browser back to after the OAuth callback (same-origin SPA).
const FRONTEND_PATH = "/billing/email-import";

function actorOf(req: Request): Actor {
  return { userId: req.auth!.userId, name: req.auth!.name };
}

function parseId(raw: string | string[]): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(s);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAppError(err: unknown): err is Error & { statusCode: number } {
  return (
    err instanceof Error &&
    typeof (err as { statusCode?: unknown }).statusCode === "number"
  );
}

function handleError(err: unknown, fallback: string, res: import("express").Response): void {
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : fallback });
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializeAccount(row: EmailImportAccount | null) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    emailAddress: row.emailAddress,
    labels: parseLabelFilter(row.labelFilter),
    labelAfterImport: row.labelAfterImport === 1,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
  };
}

function serializeMessage(row: EmailImportMessage) {
  return {
    id: row.id,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    snippet: row.snippet,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    status: row.status,
    error: row.error,
    attachmentCount: row.attachmentCount,
    importedCount: row.importedCount,
    labeled: row.labeled === 1,
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
  };
}

function serializeAttachment(row: EmailImportAttachment) {
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    skipped: row.skipped === 1,
    skipReason: row.skipReason,
    billingDocumentId: row.billingDocumentId,
  };
}

// ---------------------------------------------------------------------------
// Status (works even when unconfigured)
// ---------------------------------------------------------------------------

router.get("/billing/email-import/status", async (_req, res): Promise<void> => {
  const cfg = getGmailConfig();
  const account = cfg.configured ? await getActiveAccount() : null;
  res.json({
    configured: cfg.configured,
    missing: cfg.missing,
    connected: Boolean(account),
    account: serializeAccount(account),
  });
});

// ---------------------------------------------------------------------------
// OAuth connect (GET → redirect to Google) + callback
// ---------------------------------------------------------------------------

router.get("/billing/email-import/connect", (req, res): void => {
  const cfg = getGmailConfig();
  if (!cfg.configured) {
    res.status(400).json({
      error: `Import z e-mailu není nakonfigurován. Chybí: ${cfg.missing.join(", ")}.`,
    });
    return;
  }
  const state = randomBytes(24).toString("hex");
  req.session.gmailOAuthState = state;
  try {
    const url = buildAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    handleError(err, "Nepodařilo se sestavit přihlašovací odkaz.", res);
  }
});

router.get("/billing/email-import/callback", async (req, res): Promise<void> => {
  const redirectBack = (params: Record<string, string>): void => {
    const qs = new URLSearchParams(params).toString();
    res.redirect(`${FRONTEND_PATH}?${qs}`);
  };

  const error = typeof req.query.error === "string" ? req.query.error : null;
  if (error) {
    redirectBack({ emailImport: "error", reason: error });
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const expected = req.session.gmailOAuthState;
  delete req.session.gmailOAuthState;

  if (!code || !state || !expected || state !== expected) {
    redirectBack({ emailImport: "error", reason: "state_mismatch" });
    return;
  }

  try {
    await completeConnect(code, actorOf(req));
    redirectBack({ emailImport: "connected" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "connect_failed";
    redirectBack({ emailImport: "error", reason });
  }
});

router.post("/billing/email-import/disconnect", async (req, res): Promise<void> => {
  try {
    await disconnect(actorOf(req));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, "Odpojení selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Labels + settings
// ---------------------------------------------------------------------------

router.get("/billing/email-import/labels", async (_req, res): Promise<void> => {
  try {
    const labels = await listLabels();
    res.json({ labels });
  } catch (err) {
    handleError(err, "Načtení štítků selhalo.", res);
  }
});

router.put("/billing/email-import/settings", async (req, res): Promise<void> => {
  const body = req.body as { labels?: unknown; labelAfterImport?: unknown };
  const input: { labels?: string[]; labelAfterImport?: boolean } = {};

  if (body.labels !== undefined) {
    if (
      !Array.isArray(body.labels) ||
      !body.labels.every((x) => typeof x === "string")
    ) {
      res.status(400).json({ error: "labels musí být pole řetězců." });
      return;
    }
    input.labels = body.labels as string[];
  }
  if (body.labelAfterImport !== undefined) {
    if (typeof body.labelAfterImport !== "boolean") {
      res.status(400).json({ error: "labelAfterImport musí být boolean." });
      return;
    }
    input.labelAfterImport = body.labelAfterImport;
  }

  try {
    const account = await updateAccountSettings(input, actorOf(req));
    res.json(serializeAccount(account));
  } catch (err) {
    handleError(err, "Uložení nastavení selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

router.post("/billing/email-import/sync", async (req, res): Promise<void> => {
  try {
    const result = await syncAccount(actorOf(req));
    res.json(result);
  } catch (err) {
    handleError(err, "Synchronizace selhala.", res);
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

router.get("/billing/email-import/messages", async (req, res): Promise<void> => {
  const account = await getActiveAccount();
  if (!account) {
    res.json([]);
    return;
  }
  const status =
    typeof req.query.status === "string" && req.query.status !== ""
      ? req.query.status
      : undefined;

  const where = status
    ? and(
        eq(emailImportMessagesTable.accountId, account.id),
        eq(emailImportMessagesTable.status, status),
      )
    : eq(emailImportMessagesTable.accountId, account.id);

  const rows = await db
    .select()
    .from(emailImportMessagesTable)
    .where(where)
    .orderBy(desc(emailImportMessagesTable.sentAt), desc(emailImportMessagesTable.id));

  res.json(rows.map(serializeMessage));
});

router.get("/billing/email-import/messages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Neplatné ID." });
    return;
  }
  const account = await getActiveAccount();
  if (!account) {
    res.status(404).json({ error: "Zpráva nenalezena." });
    return;
  }
  const [message] = await db
    .select()
    .from(emailImportMessagesTable)
    .where(
      and(
        eq(emailImportMessagesTable.id, id),
        eq(emailImportMessagesTable.accountId, account.id),
      ),
    );
  if (!message) {
    res.status(404).json({ error: "Zpráva nenalezena." });
    return;
  }
  const attachments = await db
    .select()
    .from(emailImportAttachmentsTable)
    .where(eq(emailImportAttachmentsTable.messageId, message.id))
    .orderBy(emailImportAttachmentsTable.id);

  res.json({
    ...serializeMessage(message),
    attachments: attachments.map(serializeAttachment),
  });
});

router.post(
  "/billing/email-import/messages/:id/import",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Neplatné ID." });
      return;
    }
    try {
      const result = await importMessage(id, actorOf(req));
      res.json(result);
    } catch (err) {
      handleError(err, "Import selhal.", res);
    }
  },
);

router.post(
  "/billing/email-import/messages/:id/ignore",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Neplatné ID." });
      return;
    }
    try {
      await setMessageStatus(id, "ignored");
      res.json({ ok: true });
    } catch (err) {
      handleError(err, "Akce selhala.", res);
    }
  },
);

router.post(
  "/billing/email-import/messages/:id/reprocess",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Neplatné ID." });
      return;
    }
    try {
      await setMessageStatus(id, "new");
      res.json({ ok: true });
    } catch (err) {
      handleError(err, "Akce selhala.", res);
    }
  },
);

export default router;
