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
  folders: string[];
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

/**
 * Parse the configured folder field into a de-duplicated list of mailbox names.
 * The field holds a comma-separated list (e.g. "INBOX, Faktury, Dodavatelé") so
 * several Gmail labels / IMAP folders can be polled. Empty → ["INBOX"].
 */
function parseFolders(raw: string | null | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? Array.from(new Set(list)) : ["INBOX"];
}

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
      folders: parseFolders(row.folder),
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
    folders: parseFolders(process.env.IMAP_FOLDER),
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
    // We poll explicitly and never rely on server-pushed updates, so there is no
    // reason to let ImapFlow auto-enter IDLE in the gaps between our commands.
    // With IDLE running, the per-message slow work below (S3 upload + DB
    // transaction in `ingestFile`) can outlast the server's IDLE window; the
    // next command then has to break a connection the server already dropped and
    // fails with "Connection not available". Disabling auto-idle keeps the
    // connection quietly usable across that slow work (socketTimeout still
    // guards a truly dead socket).
    disableAutoIdle: true,
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
  } catch (err) {
    await client.logout().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Připojení k poštovní schránce selhalo: ${detail}`);
  }

  try {
    logger.info(
      { folders: cfg.folders },
      "Test IMAP: otevírám nakonfigurované složky/štítky",
    );
    let total = 0;
    const failedFolders: string[] = [];
    for (const folder of cfg.folders) {
      try {
        const mailbox = await client.mailboxOpen(folder);
        total += mailbox.exists;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(
          { folder, detail },
          "Test IMAP: složku/štítek nelze otevřít",
        );
        failedFolders.push(folder);
      }
    }
    if (failedFolders.length > 0) {
      const names = failedFolders.map((f) => `„${f}“`).join(", ");
      const plural = failedFolders.length > 1;
      throw new Error(
        `Nelze otevřít ${plural ? "tyto IMAP složky/štítky" : "IMAP složku/štítek"}: ${names}. ` +
          `Zkontrolujte přesný název v Gmailu vlevo v seznamu štítků — názvy rozlišují velká a malá písmena ` +
          `(např. „Faktury DEK“, ne „Faktury dek“). Štítky se NEpíší s předponou „INBOX/“ — INBOX je samostatná ` +
          `složka. Předponu „Rodič/Dítě“ použijte jen u skutečně vnořených štítků. ` +
          `V Gmailu musí být navíc u štítku zapnuté zobrazení přes IMAP (Nastavení → Štítky → „Zobrazit v IMAP“).`,
      );
    }
    return { folder: cfg.folders.join(", "), messages: total };
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

// Outcomes that are permanent: once a message reaches one of these it is never
// reprocessed. A `failed` row is deliberately NOT terminal — it represents a
// (often transient, e.g. "Connection not available") error and must be retried
// on the next poll until it succeeds.
const TERMINAL_STATUSES = new Set(["imported", "skipped", "no_attachments"]);

type ExistingLog = { id: number; status: string };

/**
 * Look up the existing log row for a message, if any. Returns its id and status
 * so the caller can (a) skip terminal outcomes and (b) update the row in place
 * on a retry instead of inserting a second row (message_id is unique-indexed).
 */
async function findExistingLog(messageId: string): Promise<ExistingLog | null> {
  const [row] = await db
    .select({ id: emailImportLogTable.id, status: emailImportLogTable.status })
    .from(emailImportLogTable)
    .where(eq(emailImportLogTable.messageId, messageId))
    .limit(1);
  return row ?? null;
}

/**
 * Persist a message's outcome. On a first attempt (`existingId === null`) this
 * inserts a new row; on a retry of a previously `failed` message it UPDATES the
 * existing row in place so history shows exactly one row per message reflecting
 * the latest attempt — and so the unique index on `message_id` is never hit.
 */
async function writeLog(
  existingId: number | null,
  values: typeof emailImportLogTable.$inferInsert,
): Promise<void> {
  if (existingId != null) {
    await db
      .update(emailImportLogTable)
      .set(values)
      .where(eq(emailImportLogTable.id, existingId));
    return;
  }
  await db.insert(emailImportLogTable).values(values);
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

  try {
    // Read every configured folder/label in turn. A message carrying the same
    // Message-ID across several Gmail labels is imported once thanks to the
    // email_import_log dedupe. Each mailbox is locked independently.
    logger.info(
      { folders: cfg.folders },
      "Import e-mailů: čtu nakonfigurované složky/štítky",
    );
    const failedFolders: string[] = [];
    for (const folder of cfg.folders) {
      try {
        await pollFolder(client, folder, cfg, result);
      } catch (err) {
        // One missing/unopenable folder (e.g. a mistyped Gmail label) must not
        // abort the whole import — log it, remember it, and keep going so the
        // other configured folders are still processed.
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(
          { folder, detail },
          "Import e-mailů: složku/štítek nelze zpracovat (přeskakuji)",
        );
        failedFolders.push(folder);
      }
    }
    // If every configured folder failed to open, surface a clear, named error so
    // the manual-import action doesn't silently report "0 imported".
    if (failedFolders.length === cfg.folders.length) {
      const names = failedFolders.map((f) => `„${f}“`).join(", ");
      throw new Error(
        `Nelze otevřít IMAP složku/štítek ${names}. Zkontrolujte přesný název štítku v Gmailu.`,
      );
    }
    return result;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Process one folder/label within an already-connected client: lock the mailbox,
 * search unseen messages, and import supported attachments. Per-message failures
 * are caught and logged so one bad message never aborts the folder or the batch.
 */
async function pollFolder(
  client: ImapFlow,
  folder: string,
  cfg: ResolvedImapConfig,
  result: PollResult,
): Promise<void> {
  const lock = await client.getMailboxLock(folder);
  try {
    // Only look at messages not yet marked \Seen. The email_import_log table is
    // the authoritative dedupe; \Seen just narrows the working set.
    const uids = await client.search({ seen: false }, { uid: true });
    if (!uids || !uids.length) return;

    // Drain the streaming fetch FULLY into memory before issuing any other IMAP
    // command. ImapFlow keeps the connection busy for the whole duration of a
    // streaming `fetch`; calling `client.download()` / `messageFlagsAdd()` while
    // the iterator is still open interleaves a second command on that busy
    // connection and drops the socket ("Connection not available"). The
    // per-message body below does slow work (S3 upload + DB transaction in
    // `ingestFile`), which keeps the stream open long enough to reliably trip
    // this — so we buffer the lightweight metadata first, then process.
    const messages: FetchMessageObject[] = [];
    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true },
    )) {
      messages.push(msg);
    }

    // UIDs to mark \Seen once every message in this folder is fully processed.
    // We defer all \Seen writes to a single batch after the loop so the slow
    // per-message ingest (S3 upload + DB transaction) never sits between two
    // IMAP commands on this connection — issuing a flag write right after that
    // slow work is exactly what dropped the socket ("Connection not available").
    // Only terminal outcomes are collected here; a failed message stays unseen
    // so the next poll's `seen:false` search re-attempts it.
    const seenUids: string[] = [];

    for (const msg of messages) {
      const messageId = messageIdOf(msg, folder);
      const existing = await findExistingLog(messageId);
      // Terminal outcomes (imported/skipped/no_attachments) are deduped forever.
      // A prior `failed` row is retried: we fall through and update it in place.
      if (existing && TERMINAL_STATUSES.has(existing.status)) continue;
      const existingId = existing?.id ?? null;

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
          await writeLog(existingId, {
            messageId,
            sender,
            subject,
            receivedAt,
            status: "no_attachments",
            attachmentsTotal: 0,
            attachmentsImported: 0,
            documentIds: null,
            error: null,
          });
          result.noAttachments += 1;
          if (cfg.markSeen) seenUids.push(String(msg.uid));
          continue;
        }

        // Phase 1 (IMAP, back-to-back): download every attachment's bytes up
        // front, before any slow work. Keeping all IMAP commands together — and
        // separate from the ingest below — stops the slow S3/DB work from
        // sitting between two commands on the busy connection.
        const downloaded: { fileName: string; contentType: string; buffer: Buffer }[] = [];
        for (const att of attachments) {
          const contentType = resolveAttachmentType(att.contentType, att.fileName)!;
          const { content } = await client.download(String(msg.uid), att.part, {
            uid: true,
          });
          const buffer = await streamToBuffer(content);
          if (!buffer.length) continue;
          downloaded.push({ fileName: att.fileName, contentType, buffer });
        }

        // Phase 2 (slow, no IMAP commands): ingest the buffered attachments.
        const createdIds: number[] = [];
        let importedCount = 0;
        for (const d of downloaded) {
          const ingest = await ingestFile(
            d.buffer,
            {
              fileName: d.fileName,
              contentType: d.contentType,
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
        await writeLog(existingId, {
          messageId,
          sender,
          subject,
          receivedAt,
          status,
          attachmentsTotal: attachments.length,
          attachmentsImported: importedCount,
          documentIds: createdIds.length ? createdIds.join(",") : null,
          // Clear any error left over from a prior failed attempt of this message.
          error: null,
        });
        if (importedCount > 0) result.imported += 1;
        else result.skipped += 1;

        if (cfg.markSeen) seenUids.push(String(msg.uid));
      } catch (err) {
        const message = err instanceof Error ? err.message : "neznámá chyba";
        result.failed += 1;
        // Record/refresh the failure so it is visible; do NOT mark \Seen so a
        // later poll retries it. On a repeated failure this updates the existing
        // row in place (no duplicate history, no unique-index violation).
        await writeLog(existingId, {
          messageId,
          sender,
          subject,
          receivedAt,
          status: "failed",
          error: message,
        }).catch((logErr) =>
          logger.error(
            { err: logErr, messageId },
            "Failed to write email_import_log failure row",
          ),
        );
        logger.error({ err, messageId }, "Email import: message failed");
      }
    }

    // Flush all \Seen flags in one batch now that every slow ingest is done.
    if (seenUids.length) {
      await client
        .messageFlagsAdd({ uid: seenUids.join(",") }, ["\\Seen"], { uid: true })
        .catch((err) =>
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Nepodařilo se označit zprávy jako přečtené (\\Seen)",
          ),
        );
    }
  } finally {
    lock.release();
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
