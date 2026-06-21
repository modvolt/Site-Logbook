/**
 * Incoming-mail importer: polls an IMAP mailbox and turns supported supplier
 * invoice attachments (ISDOC/XML/PDF/images/…) into received cost documents.
 *
 * Design mirrors the outgoing-mail (`email.ts`) settings pattern: configuration
 * is a DB singleton (editable from Settings, no redeploy) with an IMAP_* env
 * fallback. The poller:
 *   1. resolves the active config (DB → env),
 *   2. opens the configured folder and SEARCHes unseen messages,
 *   3. for each message not already in `email_import_log` (dedupe by Message-ID),
 *      walks the bodyStructure for attachment parts, downloads each supported
 *      one and feeds it through the shared `ingestFile()` path (same dedup,
 *      storage and extraction queue as a manual upload),
 *   4. records the outcome — including failures — in `email_import_log` and the
 *      settings row's last-poll diagnostics so nothing is ever silently dropped,
 *   5. optionally marks the message \Seen.
 *
 * imapflow is used directly (no mailparser): bodyStructure already enumerates
 * the MIME parts and `download(part)` streams the raw bytes of any one of them.
 *
 * `startEmailImportWorker()` runs a single-flight, unref'd timer (like
 * extraction-worker.ts) so it never keeps the process alive on its own and
 * never overlaps a still-running poll.
 */
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { eq } from "drizzle-orm";
import {
  db,
  emailImportSettingsTable,
  emailImportLogTable,
} from "@workspace/db";
import { ingestFile } from "./cost-document-service";
import { logger } from "./logger";

const SINGLETON_ID = 1;

// System actor used for documents created by the importer (no human user).
const IMPORT_ACTOR = { userId: null as number | null, name: "E-mailový import" };

export type ResolvedImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  folder: string;
  markSeen: boolean;
  pollMinutes: number;
};

// ---------------------------------------------------------------------------
// Supported attachment types
// ---------------------------------------------------------------------------

// Content types accepted for cost documents (kept in sync with the manual
// upload route's ALLOWED_UPLOAD_TYPES). Attachments outside this set are ignored.
const ALLOWED_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/xml",
  "text/xml",
  "application/zip",
  "text/plain",
  "text/csv",
]);

// Map a filename extension to a canonical content type. Used when a message
// declares a generic type (application/octet-stream) for an otherwise supported
// attachment — common for ISDOC and some scanners.
const EXT_TO_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  xml: "application/xml",
  isdoc: "application/xml",
  isdocx: "application/zip",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
}

/**
 * Resolve the effective content type for an attachment. Trusts a recognised
 * declared type; otherwise infers from the filename extension. Returns null when
 * the attachment is not a supported cost-document type (so it is skipped).
 */
function resolveAttachmentType(
  declared: string | undefined,
  fileName: string,
): string | null {
  const normalized = (declared || "").split(";")[0].trim().toLowerCase();
  if (normalized && ALLOWED_TYPES.has(normalized)) return normalized;
  const fromExt = EXT_TO_TYPE[extOf(fileName)];
  if (fromExt && ALLOWED_TYPES.has(fromExt)) return fromExt;
  return null;
}

// ---------------------------------------------------------------------------
// Config resolution (DB → env)
// ---------------------------------------------------------------------------

async function loadDbSettings() {
  const [row] = await db
    .select()
    .from(emailImportSettingsTable)
    .where(eq(emailImportSettingsTable.id, SINGLETON_ID));
  return row;
}

/**
 * Resolve the active incoming-mail configuration. Prefers the DB-backed config
 * (editable from Settings) when it is enabled and has a host; otherwise falls
 * back to the IMAP_* environment variables. Returns null when nothing is
 * configured (the importer then stays idle).
 */
export async function resolveImapConfig(): Promise<ResolvedImapConfig | null> {
  const row = await loadDbSettings();

  if (row?.enabled && row.host) {
    const user = row.username?.trim() || undefined;
    return {
      host: row.host,
      port: row.port ?? 993,
      secure: row.secure ?? true,
      user,
      pass: user ? row.password ?? undefined : undefined,
      folder: row.folder?.trim() || "INBOX",
      markSeen: row.markSeen ?? true,
      pollMinutes: row.pollMinutes ?? 15,
    };
  }

  const host = process.env.IMAP_HOST;
  if (!host) return null;

  const port = Number(process.env.IMAP_PORT || "993");
  const secure = process.env.IMAP_SECURE
    ? process.env.IMAP_SECURE === "true"
    : port === 993;
  const user = process.env.IMAP_USER;
  return {
    host,
    port,
    secure,
    user: user || undefined,
    pass: user ? process.env.IMAP_PASSWORD : undefined,
    folder: process.env.IMAP_FOLDER?.trim() || "INBOX",
    markSeen: process.env.IMAP_MARK_SEEN
      ? process.env.IMAP_MARK_SEEN === "true"
      : true,
    pollMinutes: Number(process.env.IMAP_POLL_MINUTES || "15"),
  };
}

function newClient(cfg: ResolvedImapConfig): ImapFlow {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : { user: "", pass: "" },
    // Silence imapflow's own pino logger; we log outcomes ourselves.
    logger: false,
  });
  // ImapFlow is an EventEmitter that emits an 'error' event on socket-level
  // failures (e.g. "Socket timeout" / ETIMEOUT) which can fire AFTER connect()
  // resolved — during idle or while streaming. An EventEmitter 'error' with no
  // listener throws and crashes the whole API process (the observed deploy
  // crash-loop). Attach a no-throw listener so these are logged, never fatal;
  // the per-poll try/catch already records the operational outcome.
  client.on("error", (err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "IMAP klient nahlásil chybu (ignorováno, spojení se obnoví při dalším pollu)",
    );
  });
  return client;
}

/**
 * Connect, open the folder, and immediately close. Used by the Settings "test
 * connection" action. Throws a Czech-friendly message on failure.
 */
export async function testImapConnection(): Promise<{ folder: string; messages: number }> {
  const cfg = await resolveImapConfig();
  if (!cfg) {
    throw new Error(
      "Příjem e-mailů není nakonfigurován. Vyplňte nastavení (nebo proměnné IMAP_*).",
    );
  }
  const client = newClient(cfg);
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen(cfg.folder);
    return { folder: cfg.folder, messages: mailbox.exists };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Připojení k poštovní schránce selhalo: ${detail}`);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Attachment extraction from a fetched message
// ---------------------------------------------------------------------------

type AttachmentPart = {
  part: string;
  fileName: string;
  contentType: string;
};

/**
 * Walk a message's bodyStructure and collect attachment-like leaf parts. A part
 * is considered an attachment when its disposition is "attachment" or it carries
 * a filename (covers inline-but-named scanner output). Multipart containers are
 * recursed; the textual body parts (no filename, inline) are ignored.
 */
function collectAttachments(node: unknown): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n.childNodes) && n.childNodes.length) {
      for (const child of n.childNodes) visit(child);
      return;
    }
    const dispositionRaw =
      typeof n.disposition === "string" ? n.disposition.toLowerCase() : "";
    const fileName: string | undefined =
      n.dispositionParameters?.filename ||
      n.parameters?.name ||
      undefined;
    const isAttachment = dispositionRaw === "attachment" || Boolean(fileName);
    if (!isAttachment || !n.part) return;
    const contentType =
      typeof n.type === "string"
        ? n.type.toLowerCase()
        : `${n.type ?? ""}`.toLowerCase();
    out.push({
      part: String(n.part),
      fileName: fileName || `priloha-${n.part}`,
      contentType,
    });
  };
  visit(node);
  return out;
}

function senderOf(msg: FetchMessageObject): string | null {
  const addr = msg.envelope?.from?.[0];
  if (!addr) return null;
  const email = addr.address ?? "";
  const name = addr.name?.trim();
  return name ? `${name} <${email}>` : email || null;
}

function messageIdOf(msg: FetchMessageObject, folder: string): string {
  const raw = msg.envelope?.messageId?.trim();
  if (raw) return raw;
  // Synthesize a stable token when the header is missing.
  return `uid:${msg.uid}@${folder}`;
}

async function alreadyLogged(messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailImportLogTable.id })
    .from(emailImportLogTable)
    .where(eq(emailImportLogTable.messageId, messageId))
    .limit(1);
  return Boolean(row);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export type PollResult = {
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  noAttachments: number;
};

/**
 * Run one polling pass. Connects, processes every unseen message that has not
 * already been logged, and records per-message outcomes. Updates the settings
 * row's last-poll diagnostics. Throws only on connection-level failures (the
 * caller records that as the last error); per-message failures are caught and
 * logged individually so one bad message never aborts the batch.
 */
export async function pollOnce(): Promise<PollResult> {
  const cfg = await resolveImapConfig();
  if (!cfg) {
    throw new Error(
      "Příjem e-mailů není nakonfigurován. Vyplňte nastavení (nebo proměnné IMAP_*).",
    );
  }

  const result: PollResult = {
    processed: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    noAttachments: 0,
  };

  const client = newClient(cfg);
  try {
    await client.connect();
  } catch (err) {
    await client.logout().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Připojení k poštovní schránce selhalo: ${detail}`);
  }

  const lock = await client.getMailboxLock(cfg.folder);
  try {
    // Only look at messages not yet marked \Seen. The email_import_log table is
    // the authoritative dedupe; \Seen just narrows the working set.
    const uids = await client.search({ seen: false }, { uid: true });
    if (!uids || !uids.length) return result;

    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true },
    )) {
      const messageId = messageIdOf(msg, cfg.folder);
      if (await alreadyLogged(messageId)) continue;

      result.processed += 1;
      const sender = senderOf(msg);
      const subject = msg.envelope?.subject ?? null;
      const receivedAt: Date | null = msg.internalDate
        ? new Date(msg.internalDate)
        : null;

      try {
        const attachments = collectAttachments(msg.bodyStructure).filter((a) =>
          resolveAttachmentType(a.contentType, a.fileName),
        );

        if (!attachments.length) {
          await db.insert(emailImportLogTable).values({
            messageId,
            sender,
            subject,
            receivedAt,
            status: "no_attachments",
            attachmentsTotal: 0,
            attachmentsImported: 0,
          });
          result.noAttachments += 1;
          if (cfg.markSeen) {
            await client.messageFlagsAdd(
              { uid: String(msg.uid) },
              ["\\Seen"],
              { uid: true },
            );
          }
          continue;
        }

        const createdIds: number[] = [];
        let importedCount = 0;
        for (const att of attachments) {
          const contentType = resolveAttachmentType(att.contentType, att.fileName)!;
          const { content } = await client.download(String(msg.uid), att.part, {
            uid: true,
          });
          const buffer = await streamToBuffer(content);
          if (!buffer.length) continue;

          const ingest = await ingestFile(
            buffer,
            {
              fileName: att.fileName,
              contentType,
              source: "email",
              sourceRef: sender,
            },
            IMPORT_ACTOR,
          );
          if (ingest.status === "created") {
            createdIds.push(ingest.document.id);
            importedCount += 1;
          }
        }

        const status =
          importedCount > 0
            ? "imported"
            : // had supported attachments but all were duplicates
              "skipped";
        await db.insert(emailImportLogTable).values({
          messageId,
          sender,
          subject,
          receivedAt,
          status,
          attachmentsTotal: attachments.length,
          attachmentsImported: importedCount,
          documentIds: createdIds.length ? createdIds.join(",") : null,
        });
        if (importedCount > 0) result.imported += 1;
        else result.skipped += 1;

        if (cfg.markSeen) {
          await client.messageFlagsAdd(
            { uid: String(msg.uid) },
            ["\\Seen"],
            { uid: true },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "neznámá chyba";
        result.failed += 1;
        // Record the failure so it is visible; do NOT mark \Seen so a fixed
        // config can retry. Re-poll dedupe still holds via the logged messageId.
        await db
          .insert(emailImportLogTable)
          .values({
            messageId,
            sender,
            subject,
            receivedAt,
            status: "failed",
            error: message,
          })
          .catch((logErr) =>
            logger.error(
              { err: logErr, messageId },
              "Failed to write email_import_log failure row",
            ),
          );
        logger.error({ err, messageId }, "Email import: message failed");
      }
    }

    return result;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

/**
 * Poll and persist last-poll diagnostics to the settings row. Returns the
 * result, or rethrows after recording the error so callers (poll-now route) can
 * surface it. Used by both the worker and the manual "poll now" action.
 */
export async function pollAndRecord(): Promise<PollResult> {
  const now = new Date();
  try {
    const result = await pollOnce();
    const summary = `Načteno ${result.imported}, přeskočeno ${result.skipped}, bez příloh ${result.noAttachments}, chyb ${result.failed}.`;
    await db
      .update(emailImportSettingsTable)
      .set({ lastPolledAt: now, lastStatus: summary, lastError: null })
      .where(eq(emailImportSettingsTable.id, SINGLETON_ID));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(emailImportSettingsTable)
      .set({ lastPolledAt: now, lastStatus: "failed", lastError: message })
      .where(eq(emailImportSettingsTable.id, SINGLETON_ID))
      .catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------

let schedulerStarted = false;
let polling = false;

const DEFAULT_POLL_MS = 15 * 60 * 1000;
// Check the config this often; the effective interval is governed by each
// config's pollMinutes via the lastPolledAt gate below.
const TICK_MS = 60 * 1000;

async function tick(): Promise<void> {
  if (polling) return;
  const cfg = await resolveImapConfig();
  if (!cfg) return; // not configured → idle

  // Respect the configured cadence: only poll when at least pollMinutes have
  // elapsed since the last recorded poll.
  const [row] = await db
    .select({ lastPolledAt: emailImportSettingsTable.lastPolledAt })
    .from(emailImportSettingsTable)
    .where(eq(emailImportSettingsTable.id, SINGLETON_ID));
  const intervalMs = Math.max(1, cfg.pollMinutes) * 60 * 1000 || DEFAULT_POLL_MS;
  const last = row?.lastPolledAt ? new Date(row.lastPolledAt).getTime() : 0;
  if (Date.now() - last < intervalMs) return;

  polling = true;
  try {
    await pollAndRecord();
  } catch (err) {
    logger.error({ err }, "Email import poll failed");
  } finally {
    polling = false;
  }
}

export function startEmailImportWorker(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const timer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Email import tick failed"));
  }, TICK_MS);
  timer.unref();

  logger.info({ tickMs: TICK_MS }, "Email import worker started");
}
