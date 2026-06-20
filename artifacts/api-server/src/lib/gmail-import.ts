/**
 * OPTIONAL Gmail / Google Workspace import of supplier cost documents.
 *
 * This whole module is modular and OFF by default. It only works when the
 * operator has configured their own Google OAuth app and a token-encryption key:
 *
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
 *   TOKEN_ENCRYPTION_KEY
 *
 * The rest of the application runs unchanged when these are absent. Nothing here
 * throws at import time; callers must check getGmailConfig().configured first.
 *
 * Flow:
 *  - connect: OAuth (offline access) → store the ENCRYPTED refresh token.
 *  - sync: list messages (optionally scoped to a label), fetch each new one,
 *    record lightweight metadata, and enumerate attachments. Inline parts (e.g.
 *    signature logos) and unsupported types are recorded as skipped.
 *  - import (per message): download supported attachments, de-duplicate by
 *    SHA-256, store to private object storage and create billing_documents
 *    (source "email") which enqueues extraction. Optionally label the message.
 *
 * Access tokens are short-lived and refreshed on demand from the encrypted
 * refresh token; they are never stored. Refresh tokens are never logged.
 */
import { OAuth2Client } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import {
  db,
  emailImportAccountsTable,
  emailImportMessagesTable,
  emailImportAttachmentsTable,
  billingDocumentsTable,
  auditLogTable,
  type EmailImportAccount,
} from "@workspace/db";
import { logger } from "./logger";
import {
  isTokenEncryptionConfigured,
  encryptToken,
  decryptToken,
} from "./token-crypto";
import {
  createDocument,
  sha256Of,
  type Actor,
} from "./cost-document-service";
import { ObjectStorageService } from "./objectStorage";
import { randomUUID } from "node:crypto";

const objectStorage = new ObjectStorageService();

// ---------------------------------------------------------------------------
// Configuration (environment only; never throws)
// ---------------------------------------------------------------------------

const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const PROFILE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const DEFAULT_MAX_MESSAGES = 25;
const IMPORT_LABEL_NAME = "Modvolt – importováno";

export interface GmailConfig {
  /** True when OAuth + encryption are fully configured (the feature *can* run). */
  configured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Optional Gmail label name to scope the sync to. */
  labelFilter: string | null;
  /** Optional extra Gmail search query (e.g. "has:attachment newer_than:30d"). */
  query: string | null;
  /** Whether to label imported messages (needs the gmail.modify scope). */
  labelAfterImport: boolean;
  /** Max messages fetched per sync. */
  maxMessages: number;
  /** Reasons the feature is not configured (for the status UI). */
  missing: string[];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Resolve config from the environment. Safe to call on any request. */
export function getGmailConfig(): GmailConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() ?? "";
  const hasKey = isTokenEncryptionConfigured();

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!redirectUri) missing.push("GOOGLE_REDIRECT_URI");
  if (!hasKey) missing.push("TOKEN_ENCRYPTION_KEY");

  const configured = missing.length === 0;
  const labelAfterImport = process.env.GMAIL_LABEL_AFTER_IMPORT === "true";

  return {
    configured,
    clientId,
    clientSecret,
    redirectUri,
    labelFilter: process.env.GMAIL_LABEL?.trim() || null,
    query: process.env.GMAIL_QUERY?.trim() || null,
    labelAfterImport,
    maxMessages: parsePositiveInt(process.env.GMAIL_MAX_MESSAGES, DEFAULT_MAX_MESSAGES),
    missing,
  };
}

function requiredScopes(cfg: GmailConfig): string[] {
  const gmailScope = cfg.labelAfterImport ? MODIFY_SCOPE : READONLY_SCOPE;
  return [gmailScope, ...PROFILE_SCOPES];
}

function newOAuthClient(cfg: GmailConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
}

export type AppError = Error & { statusCode: number };
function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

/**
 * Extract ONLY non-sensitive fields from an error before logging. Google /
 * Gaxios errors carry the full request `config` (including
 * `headers.authorization` and, for revoke calls, the refresh token in
 * `config.data`). Logging the raw error object would leak those tokens, so we
 * deliberately keep just the message + status/code and drop everything else.
 */
function sanitizeErr(err: unknown): {
  message: string;
  code?: string | number;
  status?: number;
} {
  if (err instanceof Error) {
    const anyErr = err as { code?: string | number; status?: number; response?: { status?: number } };
    const out: { message: string; code?: string | number; status?: number } = {
      message: err.message,
    };
    if (anyErr.code != null) out.code = anyErr.code;
    const status = anyErr.response?.status ?? anyErr.status;
    if (status != null) out.status = status;
    return out;
  }
  return { message: String(err) };
}

const MODIFY_SCOPE_KEY = "gmail.modify";
/** Whether a connected account's granted scope allows modifying labels. */
function scopeAllowsLabeling(scope: string | null | undefined): boolean {
  return !!scope && scope.includes(MODIFY_SCOPE_KEY);
}

function assertConfigured(cfg: GmailConfig): void {
  if (!cfg.configured) {
    throw appError(
      400,
      `Import z e-mailu není nakonfigurován. Chybí: ${cfg.missing.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// OAuth connect
// ---------------------------------------------------------------------------

/** Build the Google consent URL (offline access → refresh token). */
export function buildAuthUrl(state: string): string {
  const cfg = getGmailConfig();
  assertConfigured(cfg);
  const client = newOAuthClient(cfg);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: requiredScopes(cfg),
    state,
    include_granted_scopes: true,
  });
}

/**
 * Exchange an authorization code for tokens, persist the encrypted refresh token
 * and connection metadata. Returns the connected account row.
 */
export async function completeConnect(
  code: string,
  actor: Actor,
): Promise<EmailImportAccount> {
  const cfg = getGmailConfig();
  assertConfigured(cfg);
  const client = newOAuthClient(cfg);

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw appError(
      400,
      "Google nevrátil obnovovací token. Odpojte aplikaci v nastavení Google účtu a zkuste to znovu.",
    );
  }

  // Resolve the connected e-mail address (best-effort).
  let email: string | null = null;
  try {
    client.setCredentials({ access_token: tokens.access_token ?? undefined });
    const res = await client.request<{ email?: string }>({
      url: "https://www.googleapis.com/oauth2/v3/userinfo",
    });
    email = res.data.email ?? null;
  } catch (err) {
    logger.warn({ err: sanitizeErr(err) }, "Gmail userinfo lookup failed");
  }

  const encrypted = encryptToken(tokens.refresh_token);
  const now = new Date();

  const account = await db.transaction(async (tx) => {
    // Single active account: disconnect any previous ones.
    await tx
      .update(emailImportAccountsTable)
      .set({ status: "disconnected", disconnectedAt: now, updatedAt: now })
      .where(eq(emailImportAccountsTable.status, "connected"));

    const [row] = await tx
      .insert(emailImportAccountsTable)
      .values({
        provider: "gmail",
        status: "connected",
        emailAddress: email,
        refreshTokenEncrypted: encrypted,
        scope: (tokens.scope ?? requiredScopes(cfg).join(" ")) || null,
        labelFilter: cfg.labelFilter,
        labelAfterImport: cfg.labelAfterImport ? 1 : 0,
        connectedByUserId: actor.userId,
        connectedAt: now,
      })
      .returning();

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "connect",
      entityType: "email_import_accounts",
      entityId: row.id,
      summary: `Připojena e-mailová schránka pro import dokladů${email ? `: ${email}` : ""}`,
      method: "GET",
      path: "/billing/email-import/callback",
    });

    return row;
  });

  return account;
}

/** Disconnect the active account (revokes our stored token; audited). */
export async function disconnect(actor: Actor): Promise<void> {
  const account = await getActiveAccount();
  if (!account) return;

  // Best-effort token revocation at Google.
  if (account.refreshTokenEncrypted) {
    try {
      const cfg = getGmailConfig();
      if (cfg.configured) {
        const client = newOAuthClient(cfg);
        await client.revokeToken(decryptToken(account.refreshTokenEncrypted));
      }
    } catch (err) {
      logger.warn({ err: sanitizeErr(err) }, "Gmail token revoke failed (continuing)");
    }
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(emailImportAccountsTable)
      .set({
        status: "disconnected",
        refreshTokenEncrypted: null,
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(eq(emailImportAccountsTable.id, account.id));

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "disconnect",
      entityType: "email_import_accounts",
      entityId: account.id,
      summary: `Odpojena e-mailová schránka${account.emailAddress ? `: ${account.emailAddress}` : ""}`,
      method: "POST",
      path: "/billing/email-import/disconnect",
    });
  });
}

export async function getActiveAccount(): Promise<EmailImportAccount | null> {
  const [row] = await db
    .select()
    .from(emailImportAccountsTable)
    .where(eq(emailImportAccountsTable.status, "connected"))
    .orderBy(emailImportAccountsTable.id);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Authorized Gmail client
// ---------------------------------------------------------------------------

async function authorizedClient(account: EmailImportAccount): Promise<OAuth2Client> {
  const cfg = getGmailConfig();
  assertConfigured(cfg);
  if (!account.refreshTokenEncrypted) {
    throw appError(409, "Schránka není připojena.");
  }
  const client = newOAuthClient(cfg);
  client.setCredentials({
    refresh_token: decryptToken(account.refreshTokenEncrypted),
  });
  return client;
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

async function gmailGet<T>(
  client: OAuth2Client,
  url: string,
): Promise<T> {
  const res = await client.request<T>({ url });
  return res.data;
}

// ---------------------------------------------------------------------------
// Attachment discovery
// ---------------------------------------------------------------------------

// Content types we will download & turn into cost documents. Mirrors the
// uploader's allowlist (cost documents accept these).
const SUPPORTED_TYPES = new Set<string>([
  "image/jpeg",
  "image/jpg",
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
]);

const SUPPORTED_EXT = /\.(pdf|jpe?g|png|webp|gif|heic|heif|doc|docx|xls|xlsx|xml|isdoc|isdocx|zip)$/i;

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

export interface DiscoveredAttachment {
  providerAttachmentId: string;
  fileName: string;
  contentType: string;
  size: number;
  supported: boolean;
  skipReason: string | null;
}

/** Walk the MIME tree and collect downloadable attachments (skip inline parts). */
function collectAttachments(payload: GmailPart | undefined): DiscoveredAttachment[] {
  const out: DiscoveredAttachment[] = [];

  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
    const attachmentId = part.body?.attachmentId;
    const filename = (part.filename ?? "").trim();
    if (!attachmentId || !filename) return;

    const disposition = headerValue(part.headers, "Content-Disposition") ?? "";
    const contentId = headerValue(part.headers, "Content-ID");
    const mime = (part.mimeType ?? "").toLowerCase();

    // Skip inline parts (signature logos, embedded images referenced via cid:).
    const isInline =
      /inline/i.test(disposition) || (contentId != null && mime.startsWith("image/"));

    const supported =
      SUPPORTED_TYPES.has(mime) || SUPPORTED_EXT.test(filename);

    let skipReason: string | null = null;
    if (isInline) skipReason = "Vložená příloha (např. logo v podpisu)";
    else if (!supported) skipReason = `Nepodporovaný typ (${part.mimeType ?? "neznámý"})`;

    out.push({
      providerAttachmentId: attachmentId,
      fileName: filename,
      contentType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      supported: supported && !isInline,
      skipReason,
    });
  };

  walk(payload);
  return out;
}

// ---------------------------------------------------------------------------
// Sync — fetch message list + metadata + attachment rows (no download yet)
// ---------------------------------------------------------------------------

export interface GmailLabel {
  id: string;
  name: string;
  /** "system" (INBOX, IMPORTANT, …) or "user" (custom labels). */
  type: string;
}

/** Parse the stored comma-separated label filter into a clean list of names. */
export function parseLabelFilter(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Serialize a list of label names back into the stored comma-separated form. */
export function serializeLabelFilter(names: string[]): string | null {
  const clean = names.map((s) => s.trim()).filter((s) => s.length > 0);
  // De-duplicate (case-insensitive) while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of clean) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out.length ? out.join(",") : null;
}

async function fetchAllLabels(client: OAuth2Client): Promise<GmailLabel[]> {
  const data = await gmailGet<{ labels?: GmailLabel[] }>(
    client,
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
  );
  return data.labels ?? [];
}

/** List the connected mailbox's labels (for the admin to choose from). */
export async function listLabels(): Promise<GmailLabel[]> {
  const account = await getActiveAccount();
  if (!account) throw appError(409, "Schránka není připojena.");
  const client = await authorizedClient(account);
  const labels = await fetchAllLabels(client);
  // User labels first (alphabetical), then system labels.
  return labels
    .map((l) => ({ id: l.id, name: l.name, type: l.type ?? "user" }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "user" ? -1 : 1;
      return a.name.localeCompare(b.name, "cs");
    });
}

/**
 * Resolve a list of label tokens to their Gmail label IDs. A token may be either
 * a Gmail label **id** (what the admin UI stores/sends, e.g. "Label_12" or
 * "INBOX") or a label **name** (what an operator types in the `GMAIL_LABEL` env
 * default, e.g. "Faktury"). We match by id first, then case-insensitively by
 * name. Tokens that match nothing are returned as `unresolved` (surfaced to the
 * admin). Resolving both forms keeps the UI (ids) and env default (names) working.
 */
async function resolveLabelIds(
  client: OAuth2Client,
  tokens: string[],
): Promise<{ ids: string[]; unresolved: string[] }> {
  if (!tokens.length) return { ids: [], unresolved: [] };
  let labels: GmailLabel[];
  try {
    labels = await fetchAllLabels(client);
  } catch (err) {
    logger.warn({ err: sanitizeErr(err) }, "Gmail label lookup failed");
    return { ids: [], unresolved: tokens };
  }
  const byId = new Set(labels.map((l) => l.id));
  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const token of tokens) {
    if (byId.has(token)) {
      ids.push(token);
      continue;
    }
    const id = byName.get(token.toLowerCase());
    if (id) ids.push(id);
    else unresolved.push(token);
  }
  return { ids, unresolved };
}

/** Update the active account's label filter + label-after-import flag (audited). */
export async function updateAccountSettings(
  input: { labels?: string[]; labelAfterImport?: boolean },
  actor: Actor,
): Promise<EmailImportAccount> {
  const account = await getActiveAccount();
  if (!account) throw appError(409, "Schránka není připojena.");

  const patch: Partial<typeof emailImportAccountsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.labels !== undefined) {
    patch.labelFilter = serializeLabelFilter(input.labels);
  }
  if (input.labelAfterImport !== undefined) {
    // Labeling requires the gmail.modify scope, which is only granted at connect
    // time when GMAIL_LABEL_AFTER_IMPORT=true. Reject enabling it on a read-only
    // connection so the toggle never silently fails — the admin is told to set
    // the env flag and reconnect.
    if (input.labelAfterImport && !scopeAllowsLabeling(account.scope)) {
      throw appError(
        409,
        "Označování zpráv vyžaduje oprávnění upravovat e-maily. Nastavte GMAIL_LABEL_AFTER_IMPORT=true a připojte schránku znovu.",
      );
    }
    patch.labelAfterImport = input.labelAfterImport ? 1 : 0;
  }

  const [row] = await db
    .update(emailImportAccountsTable)
    .set(patch)
    .where(eq(emailImportAccountsTable.id, account.id))
    .returning();
  return row;
}

export interface SyncResult {
  fetched: number;
  newMessages: number;
}

export async function syncAccount(actor: Actor): Promise<SyncResult> {
  const account = await getActiveAccount();
  if (!account) throw appError(409, "Schránka není připojena.");
  const cfg = getGmailConfig();
  assertConfigured(cfg);

  const now = new Date();
  try {
    const client = await authorizedClient(account);

    // Base search query (always restrict to messages that carry attachments).
    const queryParts: string[] = ["has:attachment"];
    if (cfg.query) queryParts.push(cfg.query);
    const baseQuery = queryParts.join(" ");

    // Resolve the configured label filter to Gmail label IDs. When one or more
    // labels are selected we list per-label and UNION the results so a message
    // matching ANY of the chosen labels is imported (Gmail's labelIds param ANDs
    // multiple labels, which is not what we want). With no labels selected we do
    // a single account-wide query.
    const selectedLabels = parseLabelFilter(account.labelFilter);
    const { ids: labelIds } = await resolveLabelIds(client, selectedLabels);

    // Safety: if the admin configured labels but NONE of them resolve (e.g. they
    // were renamed/deleted in Gmail), fail loudly instead of silently falling
    // back to an account-wide scan that would ingest unintended e-mails.
    if (selectedLabels.length > 0 && labelIds.length === 0) {
      throw appError(
        409,
        "Žádný z nastavených štítků se ve schránce nenašel. Upravte výběr štítků v nastavení.",
      );
    }

    const queries: { labelId?: string }[] =
      labelIds.length > 0 ? labelIds.map((id) => ({ labelId: id })) : [{}];

    const seenIds = new Set<string>();
    const ids: string[] = [];
    for (const q of queries) {
      const params = new URLSearchParams();
      params.set("maxResults", String(cfg.maxMessages));
      params.set("q", baseQuery);
      if (q.labelId) params.set("labelIds", q.labelId);
      const list = await gmailGet<{ messages?: { id: string }[] }>(
        client,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      );
      for (const m of list.messages ?? []) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        ids.push(m.id);
      }
    }

    let newMessages = 0;
    for (const id of ids) {
      // Skip messages we already recorded.
      const [existing] = await db
        .select({ id: emailImportMessagesTable.id })
        .from(emailImportMessagesTable)
        .where(
          and(
            eq(emailImportMessagesTable.accountId, account.id),
            eq(emailImportMessagesTable.providerMessageId, id),
          ),
        );
      if (existing) continue;

      const msg = await gmailGet<GmailMessage>(
        client,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      );

      const headers = msg.payload?.headers;
      const fromRaw = headerValue(headers, "From") ?? "";
      const subject = headerValue(headers, "Subject");
      const sentAt = msg.internalDate
        ? new Date(Number(msg.internalDate))
        : null;
      const { name: fromName, address: fromAddress } = parseFrom(fromRaw);

      const attachments = collectAttachments(msg.payload);

      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(emailImportMessagesTable)
          .values({
            accountId: account.id,
            providerMessageId: id,
            threadId: msg.threadId ?? null,
            fromAddress,
            fromName,
            subject,
            snippet: msg.snippet ?? null,
            sentAt,
            status: "new",
            attachmentCount: attachments.filter((a) => a.supported).length,
          })
          .returning();

        if (attachments.length) {
          await tx.insert(emailImportAttachmentsTable).values(
            attachments.map((a) => ({
              messageId: row.id,
              providerAttachmentId: a.providerAttachmentId,
              fileName: a.fileName,
              contentType: a.contentType,
              size: a.size,
              skipped: a.supported ? 0 : 1,
              skipReason: a.skipReason,
            })),
          );
        }
      });
      newMessages += 1;
    }

    await db
      .update(emailImportAccountsTable)
      .set({
        lastSyncAt: now,
        lastSyncStatus: "ok",
        lastSyncError: null,
        updatedAt: now,
      })
      .where(eq(emailImportAccountsTable.id, account.id));

    await db.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "sync",
      entityType: "email_import_accounts",
      entityId: account.id,
      summary: `Synchronizace e-mailu: ${ids.length} zpráv, ${newMessages} nových`,
      method: "POST",
      path: "/billing/email-import/sync",
    });

    return { fetched: ids.length, newMessages };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznámá chyba.";
    await db
      .update(emailImportAccountsTable)
      .set({
        lastSyncAt: now,
        lastSyncStatus: "error",
        lastSyncError: message,
        updatedAt: now,
      })
      .where(eq(emailImportAccountsTable.id, account.id));
    if ((err as Partial<AppError>).statusCode) throw err;
    throw appError(502, `Synchronizace selhala: ${message}`);
  }
}

function parseFrom(raw: string): { name: string | null; address: string | null } {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) {
    return { name: m[1].trim() || null, address: m[2].trim() || null };
  }
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return { name: null, address: trimmed };
  return { name: trimmed || null, address: null };
}

// ---------------------------------------------------------------------------
// Import a message's attachments → billing_documents
// ---------------------------------------------------------------------------

function base64UrlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface ImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
}

export async function importMessage(
  messageId: number,
  actor: Actor,
): Promise<ImportResult> {
  const account = await getActiveAccount();
  if (!account) throw appError(409, "Schránka není připojena.");

  const [message] = await db
    .select()
    .from(emailImportMessagesTable)
    .where(
      and(
        eq(emailImportMessagesTable.id, messageId),
        eq(emailImportMessagesTable.accountId, account.id),
      ),
    );
  if (!message) throw appError(404, "Zpráva nenalezena.");
  if (message.status === "ignored") {
    throw appError(409, "Zpráva je označena jako ignorovaná. Nejprve ji znovu zařaďte.");
  }

  const attachments = await db
    .select()
    .from(emailImportAttachmentsTable)
    .where(eq(emailImportAttachmentsTable.messageId, message.id));

  const client = await authorizedClient(account);

  let imported = 0;
  let skipped = 0;
  let duplicates = 0;

  for (const att of attachments) {
    if (att.skipped) {
      skipped += 1;
      continue;
    }
    if (att.billingDocumentId) {
      // Already imported in a previous run.
      continue;
    }
    if (!att.providerAttachmentId) {
      skipped += 1;
      continue;
    }

    let buffer: Buffer;
    try {
      const data = await gmailGet<{ data?: string; size?: number }>(
        client,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.providerMessageId}/attachments/${att.providerAttachmentId}`,
      );
      if (!data.data) {
        skipped += 1;
        await markAttachmentSkipped(att.id, "Přílohu se nepodařilo stáhnout");
        continue;
      }
      buffer = base64UrlToBuffer(data.data);
    } catch (err) {
      logger.warn({ err: sanitizeErr(err), attachmentId: att.id }, "Gmail attachment download failed");
      skipped += 1;
      await markAttachmentSkipped(att.id, "Chyba při stahování přílohy");
      continue;
    }

    const hash = sha256Of(buffer);

    // Dedup against previously-imported attachments + existing billing documents.
    const [dupDoc] = await db
      .select({ id: billingDocumentsTable.id })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    if (dupDoc) {
      duplicates += 1;
      await db
        .update(emailImportAttachmentsTable)
        .set({
          sha256: hash,
          skipped: 1,
          skipReason: "Duplicitní obsah (doklad již existuje)",
          billingDocumentId: dupDoc.id,
          updatedAt: new Date(),
        })
        .where(eq(emailImportAttachmentsTable.id, att.id));
      continue;
    }

    const objectPath = `/objects/cost-documents/${randomUUID()}`;
    const contentType = att.contentType ?? "application/octet-stream";
    await objectStorage.putPrivateObject(objectPath, buffer, contentType);

    const doc = await createDocument(
      {
        objectPath,
        fileName: att.fileName ?? "priloha",
        contentType,
        fileSize: buffer.length,
        sha256: hash,
        source: "email",
      },
      buffer,
      actor,
    );

    await db
      .update(emailImportAttachmentsTable)
      .set({
        sha256: hash,
        objectPath,
        billingDocumentId: doc.id,
        updatedAt: new Date(),
      })
      .where(eq(emailImportAttachmentsTable.id, att.id));
    imported += 1;
  }

  // Optionally label the message in Gmail so it is not re-fetched.
  let labeled = message.labeled;
  if (account.labelAfterImport && imported > 0) {
    try {
      const labelId = await ensureImportLabel(client);
      if (labelId) {
        await client.request({
          url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.providerMessageId}/modify`,
          method: "POST",
          data: { addLabelIds: [labelId] },
        });
        labeled = 1;
      }
    } catch (err) {
      logger.warn({ err: sanitizeErr(err), messageId: message.id }, "Gmail label-after-import failed");
    }
  }

  await db
    .update(emailImportMessagesTable)
    .set({
      status: "imported",
      importedCount: message.importedCount + imported,
      labeled,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emailImportMessagesTable.id, message.id));

  return { imported, skipped, duplicates };
}

async function markAttachmentSkipped(id: number, reason: string): Promise<void> {
  await db
    .update(emailImportAttachmentsTable)
    .set({ skipped: 1, skipReason: reason, updatedAt: new Date() })
    .where(eq(emailImportAttachmentsTable.id, id));
}

async function ensureImportLabel(client: OAuth2Client): Promise<string | null> {
  const { ids } = await resolveLabelIds(client, [IMPORT_LABEL_NAME]);
  if (ids.length) return ids[0];
  try {
    const res = await client.request<{ id: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      method: "POST",
      data: {
        name: IMPORT_LABEL_NAME,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    return res.data.id ?? null;
  } catch (err) {
    logger.warn({ err: sanitizeErr(err) }, "Gmail label create failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ignore / reprocess
// ---------------------------------------------------------------------------

export async function setMessageStatus(
  messageId: number,
  status: "ignored" | "new",
): Promise<void> {
  const account = await getActiveAccount();
  if (!account) throw appError(409, "Schránka není připojena.");
  const [message] = await db
    .select()
    .from(emailImportMessagesTable)
    .where(
      and(
        eq(emailImportMessagesTable.id, messageId),
        eq(emailImportMessagesTable.accountId, account.id),
      ),
    );
  if (!message) throw appError(404, "Zpráva nenalezena.");
  await db
    .update(emailImportMessagesTable)
    .set({ status, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(emailImportMessagesTable.id, message.id));
}
