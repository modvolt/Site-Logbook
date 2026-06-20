import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { OAuth2Client } from "google-auth-library";
import type { AppError } from "../src/lib/gmail-import";
import {
  db,
  usersTable,
  emailImportAccountsTable,
  emailImportMessagesTable,
  emailImportAttachmentsTable,
  billingDocumentsTable,
} from "@workspace/db";

/**
 * Automated cover for the Gmail cost-document import (no real Google calls).
 *
 * The trickiest, highest-risk parts of the importer are the ones that recently
 * had bugs:
 *  - resolveLabelIds: a configured token may be a Gmail label *id* (what the
 *    admin UI stores) or a label *name* (what the GMAIL_LABEL env default uses),
 *    and unmatched tokens must be reported so they are never silently ignored.
 *  - syncAccount: when labels ARE configured but NONE resolve, the sync must
 *    fail loudly (409) and NOT fall back to a whole-mailbox scan that would
 *    ingest unintended e-mails; with no labels selected the whole-mailbox scan
 *    is intended.
 *  - importMessage: attachments must be de-duplicated by SHA-256 against
 *    existing billing_documents, and brand-new attachments must create
 *    source="email" cost documents.
 *
 * The Gmail OAuth client (google-auth-library) and object storage are mocked so
 * no network/storage is touched; the real DB (DATABASE_URL) is used so the
 * dedup + document-creation paths exercise the actual Drizzle queries. Requires
 * the email_import_* and billing_documents tables to exist — see
 * .agents/memory/test-db-schema-drift.md.
 */

// A single, per-test-configurable Gmail responder. Hoisted so the vi.mock
// factory below (which is hoisted above imports) can reference it safely.
const mocks = vi.hoisted(() => ({
  gmailRequest:
    vi.fn<
      (opts: { url: string; method?: string; data?: unknown }) => Promise<{
        data: unknown;
      }>
    >(),
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    setCredentials(): void {}
    generateAuthUrl(): string {
      return "";
    }
    async getToken(): Promise<{ tokens: Record<string, unknown> }> {
      return { tokens: {} };
    }
    async revokeToken(): Promise<void> {}
    request(opts: { url: string; method?: string; data?: unknown }) {
      return mocks.gmailRequest(opts);
    }
  },
}));

vi.mock("../src/lib/objectStorage", () => ({
  ObjectStorageService: class {
    async putPrivateObject(): Promise<void> {}
  },
}));

// Configure the optional feature so getGmailConfig() reports "configured".
// (Read at call time, so setting them before the first call is enough.)
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REDIRECT_URI =
  "https://example.test/api/billing/email-import/callback";
process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64); // 64 hex chars → 32 bytes

// Imported AFTER env + mocks so the module picks up the mocked deps.
const { resolveLabelIds, syncAccount, importMessage } = await import(
  "../src/lib/gmail-import"
);
const { encryptToken } = await import("../src/lib/token-crypto");
const { sha256Of } = await import("../src/lib/cost-document-service");

const TAG = `test-gmail-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let userId: number;
const accountIds: number[] = [];
const docIds: number[] = [];

// Build a fake Gmail labels list-response client for resolveLabelIds unit tests.
function fakeLabelClient(labels: { id: string; name: string }[]): OAuth2Client {
  return {
    request: async () => ({ data: { labels } }),
  } as unknown as OAuth2Client;
}

async function makeAccount(opts: {
  labelFilter?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(emailImportAccountsTable)
    .values({
      provider: "gmail",
      status: "connected",
      emailAddress: `${TAG}@example.test`,
      refreshTokenEncrypted: encryptToken("fake-refresh-token"),
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      labelFilter: opts.labelFilter ?? null,
      labelAfterImport: 0,
      connectedByUserId: userId,
      connectedAt: new Date(),
    })
    .returning();
  accountIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: "x",
      name: "Test Runner",
      role: "admin",
    })
    .returning();
  userId = user.id;
  actor.userId = user.id;
});

afterEach(async () => {
  mocks.gmailRequest.mockReset();
  // Each test creates its own account(s); messages/attachments cascade away.
  if (accountIds.length) {
    await db
      .delete(emailImportAccountsTable)
      .where(inArray(emailImportAccountsTable.id, accountIds));
    accountIds.length = 0;
  }
  if (docIds.length) {
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
});

afterAll(async () => {
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("resolveLabelIds", () => {
  const client = () =>
    fakeLabelClient([
      { id: "Label_1", name: "Faktury" },
      { id: "Label_2", name: "Dodavatelé" },
      { id: "INBOX", name: "INBOX" },
    ]);

  it("matches by label id first", async () => {
    const { ids, unresolved } = await resolveLabelIds(client(), ["Label_1"]);
    expect(ids).toEqual(["Label_1"]);
    expect(unresolved).toEqual([]);
  });

  it("matches by name case-insensitively when not an id", async () => {
    const { ids, unresolved } = await resolveLabelIds(client(), ["faktury"]);
    expect(ids).toEqual(["Label_1"]);
    expect(unresolved).toEqual([]);
  });

  it("reports tokens that match neither id nor name as unresolved", async () => {
    const { ids, unresolved } = await resolveLabelIds(client(), [
      "Label_2",
      "Neexistuje",
    ]);
    expect(ids).toEqual(["Label_2"]);
    expect(unresolved).toEqual(["Neexistuje"]);
  });

  it("returns empty for an empty token list without calling Gmail", async () => {
    const c = fakeLabelClient([]);
    const spy = vi.spyOn(c, "request" as never);
    const { ids, unresolved } = await resolveLabelIds(c, []);
    expect(ids).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("syncAccount label-filter safety", () => {
  function urlsHit(): string[] {
    return mocks.gmailRequest.mock.calls.map((c) => c[0].url);
  }
  function messageListCalls(): string[] {
    return urlsHit().filter((u) => /\/messages\?/.test(u));
  }

  it("throws 409 and does NOT scan the whole mailbox when configured labels do not resolve", async () => {
    await makeAccount({ labelFilter: "Neexistujici stitek" });
    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/labels$/.test(url)) {
        return { data: { labels: [{ id: "Label_1", name: "Faktury" }] } };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    let caught: AppError | undefined;
    await syncAccount(actor).catch((e) => {
      caught = e as AppError;
    });
    expect(caught).toBeDefined();
    expect(caught?.statusCode).toBe(409);
    // The safety guard must fire BEFORE any message listing.
    expect(messageListCalls()).toHaveLength(0);
  });

  it("scans the whole mailbox (no labelIds) when no labels are selected", async () => {
    await makeAccount({ labelFilter: null });
    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/messages\?/.test(url)) {
        return { data: { messages: [{ id: "m-1" }] } };
      }
      if (/\/messages\/m-1/.test(url)) {
        return {
          data: {
            id: "m-1",
            threadId: "t-1",
            snippet: "ahoj",
            internalDate: String(Date.now()),
            payload: {
              headers: [
                { name: "From", value: "Dodavatel <dod@example.test>" },
                { name: "Subject", value: "Faktura" },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await syncAccount(actor);
    expect(result.fetched).toBe(1);
    expect(result.newMessages).toBe(1);

    const listCalls = messageListCalls();
    expect(listCalls).toHaveLength(1);
    // A whole-mailbox scan must NOT constrain by labelIds.
    expect(listCalls[0]).not.toMatch(/labelIds/);
    // No labels are configured, so the labels endpoint is never queried.
    expect(urlsHit().some((u) => /\/labels$/.test(u))).toBe(false);
  });
});

describe("importMessage SHA-256 de-duplication and document creation", () => {
  async function seedMessageWithAttachment(opts: {
    accountId: number;
    providerAttachmentId: string;
    fileName: string;
    contentType: string;
  }): Promise<{ messageId: number; attachmentId: number }> {
    const [msg] = await db
      .insert(emailImportMessagesTable)
      .values({
        accountId: opts.accountId,
        providerMessageId: `pm-${opts.providerAttachmentId}`,
        fromAddress: "dod@example.test",
        subject: "Faktura",
        status: "new",
        attachmentCount: 1,
      })
      .returning();
    const [att] = await db
      .insert(emailImportAttachmentsTable)
      .values({
        messageId: msg.id,
        providerAttachmentId: opts.providerAttachmentId,
        fileName: opts.fileName,
        contentType: opts.contentType,
        size: 1234,
        skipped: 0,
      })
      .returning();
    return { messageId: msg.id, attachmentId: att.id };
  }

  it("creates a source=\"email\" billing document for a new attachment", async () => {
    const accountId = await makeAccount({ labelFilter: null });
    const content = Buffer.from(`brand-new-invoice-${TAG}`);
    const hash = sha256Of(content);
    const { messageId, attachmentId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-new",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-new/.test(url)) {
        return { data: { data: content.toString("base64"), size: content.length } };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 0 });

    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    expect(doc).toBeDefined();
    expect(doc.source).toBe("email");
    docIds.push(doc.id);

    const [att] = await db
      .select()
      .from(emailImportAttachmentsTable)
      .where(eq(emailImportAttachmentsTable.id, attachmentId));
    expect(att.billingDocumentId).toBe(doc.id);
    expect(att.sha256).toBe(hash);
  });

  it("de-dupes against an existing billing_document with the same SHA-256", async () => {
    const accountId = await makeAccount({ labelFilter: null });
    const content = Buffer.from(`already-imported-${TAG}`);
    const hash = sha256Of(content);

    // An existing document already carries this content hash.
    const [existing] = await db
      .insert(billingDocumentsTable)
      .values({
        status: "approved",
        docType: "invoice",
        source: "manual",
        fileName: "puvodni.pdf",
        sha256: hash,
      })
      .returning();
    docIds.push(existing.id);

    const { messageId, attachmentId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-dup",
      fileName: "kopie.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-dup/.test(url)) {
        return { data: { data: content.toString("base64"), size: content.length } };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 0, skipped: 0, duplicates: 1 });

    // No new document was created for the duplicate content.
    const docs = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(existing.id);

    // The attachment is marked as a duplicate and linked to the existing doc.
    const [att] = await db
      .select()
      .from(emailImportAttachmentsTable)
      .where(eq(emailImportAttachmentsTable.id, attachmentId));
    expect(att.skipped).toBe(1);
    expect(att.billingDocumentId).toBe(existing.id);
    expect(att.skipReason).toMatch(/[Dd]uplicit/);
  });
});
