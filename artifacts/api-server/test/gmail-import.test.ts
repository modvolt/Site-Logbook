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
import type { AppError, GmailPart } from "../src/lib/gmail-import";
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
const {
  resolveLabelIds,
  syncAccount,
  importMessage,
  collectAttachments,
  updateAccountSettings,
} = await import("../src/lib/gmail-import");
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
  labelAfterImport?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(emailImportAccountsTable)
    .values({
      provider: "gmail",
      status: "connected",
      emailAddress: `${TAG}@example.test`,
      refreshTokenEncrypted: encryptToken("fake-refresh-token"),
      scope: opts.labelAfterImport
        ? "https://www.googleapis.com/auth/gmail.modify"
        : "https://www.googleapis.com/auth/gmail.readonly",
      labelFilter: opts.labelFilter ?? null,
      labelAfterImport: opts.labelAfterImport ? 1 : 0,
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

describe("syncAccount multi-label union", () => {
  function urlsHit(): string[] {
    return mocks.gmailRequest.mock.calls.map((c) => c[0].url);
  }
  function messageListCalls(): string[] {
    return urlsHit().filter((u) => /\/messages\?/.test(u));
  }
  function detailCallsFor(id: string): string[] {
    return urlsHit().filter((u) =>
      new RegExp(`/messages/${id}\\?format=full`).test(u),
    );
  }

  // A minimal message detail (no attachments) — the union test only cares about
  // which message ids get fetched, and how many times.
  function messageDetail(id: string): unknown {
    return {
      id,
      threadId: `t-${id}`,
      snippet: "ahoj",
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: "From", value: "Dodavatel <dod@example.test>" },
          { name: "Subject", value: "Faktura" },
        ],
      },
    };
  }

  it("UNIONs messages across selected labels, listing per-label and fetching each message once", async () => {
    // Two labels selected. Gmail's labelIds param ANDs labels, so the importer
    // must list each label separately and de-dupe the message ids.
    await makeAccount({ labelFilter: "Faktury,Dodavatelé" });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/labels$/.test(url)) {
        return {
          data: {
            labels: [
              { id: "Label_1", name: "Faktury" },
              { id: "Label_2", name: "Dodavatelé" },
            ],
          },
        };
      }
      if (/\/messages\?/.test(url)) {
        const labelId = new URL(url).searchParams.get("labelIds");
        // "m-shared" carries BOTH labels, so it appears in each per-label list.
        if (labelId === "Label_1") {
          return { data: { messages: [{ id: "m-1" }, { id: "m-shared" }] } };
        }
        if (labelId === "Label_2") {
          return { data: { messages: [{ id: "m-shared" }, { id: "m-2" }] } };
        }
        return { data: { messages: [] } };
      }
      const detail = url.match(/\/messages\/([^/?]+)\?format=full/);
      if (detail) {
        return { data: messageDetail(detail[1]) };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await syncAccount(actor);

    // m-1, m-2 and the shared message → 3 unique messages, all new.
    expect(result.fetched).toBe(3);
    expect(result.newMessages).toBe(3);

    // One list call per selected label, each constrained to a single labelId.
    const listCalls = messageListCalls();
    expect(listCalls).toHaveLength(2);
    expect(listCalls.some((u) => /labelIds=Label_1/.test(u))).toBe(true);
    expect(listCalls.some((u) => /labelIds=Label_2/.test(u))).toBe(true);

    // The message matching BOTH labels is fetched exactly once (de-duped).
    expect(detailCallsFor("m-shared")).toHaveLength(1);
    expect(detailCallsFor("m-1")).toHaveLength(1);
    expect(detailCallsFor("m-2")).toHaveLength(1);
  });
});

describe("importMessage label-after-import", () => {
  function urlsHit(): string[] {
    return mocks.gmailRequest.mock.calls.map((c) => c[0].url);
  }
  function modifyCalls() {
    return mocks.gmailRequest.mock.calls.filter((c) =>
      /\/messages\/[^/?]+\/modify$/.test(c[0].url),
    );
  }

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

  it("applies the import label after a successful import when labelAfterImport is on", async () => {
    const accountId = await makeAccount({
      labelFilter: null,
      labelAfterImport: true,
    });
    const content = Buffer.from(`label-me-${TAG}`);
    const hash = sha256Of(content);
    const { messageId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-label",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-label/.test(url)) {
        return {
          data: { data: content.toString("base64"), size: content.length },
        };
      }
      // The "Modvolt – importováno" label already exists in the mailbox.
      if (/\/labels$/.test(url)) {
        return {
          data: { labels: [{ id: "Label_imp", name: "Modvolt – importováno" }] },
        };
      }
      if (/\/messages\/[^/?]+\/modify$/.test(url)) {
        return { data: {} };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 0 });

    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    docIds.push(doc.id);

    // Exactly one modify call, adding the resolved import-label id.
    const mods = modifyCalls();
    expect(mods).toHaveLength(1);
    expect(mods[0][0].method).toBe("POST");
    expect(mods[0][0].data).toEqual({ addLabelIds: ["Label_imp"] });

    // The message is recorded as labeled.
    const [msg] = await db
      .select()
      .from(emailImportMessagesTable)
      .where(eq(emailImportMessagesTable.id, messageId));
    expect(msg.labeled).toBe(1);
  });

  it("does NOT label when labelAfterImport is off", async () => {
    const accountId = await makeAccount({
      labelFilter: null,
      labelAfterImport: false,
    });
    const content = Buffer.from(`no-label-${TAG}`);
    const hash = sha256Of(content);
    const { messageId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-nolabel",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-nolabel/.test(url)) {
        return {
          data: { data: content.toString("base64"), size: content.length },
        };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 0 });

    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    docIds.push(doc.id);

    // No labels were touched: neither the labels endpoint nor modify was called.
    expect(modifyCalls()).toHaveLength(0);
    expect(urlsHit().some((u) => /\/labels$/.test(u))).toBe(false);

    const [msg] = await db
      .select()
      .from(emailImportMessagesTable)
      .where(eq(emailImportMessagesTable.id, messageId));
    expect(msg.labeled).toBe(0);
  });

  it("does NOT label when nothing was imported (all attachments duplicate)", async () => {
    const accountId = await makeAccount({
      labelFilter: null,
      labelAfterImport: true,
    });
    const content = Buffer.from(`dup-no-label-${TAG}`);
    const hash = sha256Of(content);

    // The content already exists as a billing document → the attachment dedupes.
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

    const { messageId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-duplabel",
      fileName: "kopie.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-duplabel/.test(url)) {
        return {
          data: { data: content.toString("base64"), size: content.length },
        };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 0, skipped: 0, duplicates: 1 });

    // labelAfterImport is on, but imported === 0 → no labeling attempt.
    expect(modifyCalls()).toHaveLength(0);
    expect(urlsHit().some((u) => /\/labels$/.test(u))).toBe(false);

    const [msg] = await db
      .select()
      .from(emailImportMessagesTable)
      .where(eq(emailImportMessagesTable.id, messageId));
    expect(msg.labeled).toBe(0);
  });
});

describe("collectAttachments inline + unsupported skipping", () => {
  function byName(
    list: ReturnType<typeof collectAttachments>,
    name: string,
  ) {
    return list.find((a) => a.fileName === name);
  }

  it("keeps supported attachments, skips inline parts and unsupported types", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      // The root part has no attachmentId/filename → not itself an attachment.
      parts: [
        // A normal supported PDF attachment.
        {
          mimeType: "application/pdf",
          filename: "faktura.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="faktura.pdf"' }],
          body: { attachmentId: "a-pdf", size: 2048 },
        },
        // A supported image attachment (not inline).
        {
          mimeType: "image/png",
          filename: "foto.png",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="foto.png"' }],
          body: { attachmentId: "a-img", size: 1024 },
        },
        // An inline signature logo referenced via Content-ID (cid:).
        {
          mimeType: "image/png",
          filename: "logo.png",
          headers: [{ name: "Content-ID", value: "<logo-123>" }],
          body: { attachmentId: "a-logo", size: 256 },
        },
        // An inline part declared via Content-Disposition: inline.
        {
          mimeType: "image/jpeg",
          filename: "podpis.jpg",
          headers: [{ name: "Content-Disposition", value: "inline" }],
          body: { attachmentId: "a-inline", size: 300 },
        },
        // An unsupported content type (and unsupported extension).
        {
          mimeType: "application/x-rar-compressed",
          filename: "archiv.rar",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="archiv.rar"' }],
          body: { attachmentId: "a-rar", size: 4096 },
        },
        // A part with no attachmentId → not a downloadable attachment at all.
        {
          mimeType: "text/plain",
          filename: "telo.txt",
          body: { size: 10 },
        },
      ],
    };

    const result = collectAttachments(payload);

    // The part without an attachmentId is not collected.
    expect(byName(result, "telo.txt")).toBeUndefined();
    expect(result).toHaveLength(5);

    const pdf = byName(result, "faktura.pdf");
    expect(pdf?.supported).toBe(true);
    expect(pdf?.skipReason).toBeNull();

    const img = byName(result, "foto.png");
    expect(img?.supported).toBe(true);
    expect(img?.skipReason).toBeNull();

    // Inline logo: supported type, but skipped because it is inline (cid:).
    const logo = byName(result, "logo.png");
    expect(logo?.supported).toBe(false);
    expect(logo?.skipReason).toMatch(/[Vv]ložená/);

    // Inline via Content-Disposition: inline.
    const podpis = byName(result, "podpis.jpg");
    expect(podpis?.supported).toBe(false);
    expect(podpis?.skipReason).toMatch(/[Vv]ložená/);

    // Unsupported type: kept in the list but flagged with the right reason.
    const rar = byName(result, "archiv.rar");
    expect(rar?.supported).toBe(false);
    expect(rar?.skipReason).toMatch(/[Nn]epodporovaný/);
    expect(rar?.skipReason).toContain("application/x-rar-compressed");
  });
});

describe("updateAccountSettings labelAfterImport scope guard", () => {
  it("rejects enabling labelAfterImport on a read-only connection (409)", async () => {
    // makeAccount with labelAfterImport:false grants only the gmail.readonly scope.
    await makeAccount({ labelFilter: null, labelAfterImport: false });

    let caught: AppError | undefined;
    await updateAccountSettings({ labelAfterImport: true }, actor).catch((e) => {
      caught = e as AppError;
    });
    expect(caught).toBeDefined();
    expect(caught?.statusCode).toBe(409);
    // The guard must fire before any Gmail call.
    expect(mocks.gmailRequest).not.toHaveBeenCalled();

    // The flag stays off in the DB — the silent-fail toggle was rejected.
    const [row] = await db
      .select()
      .from(emailImportAccountsTable)
      .where(eq(emailImportAccountsTable.id, accountIds[accountIds.length - 1]));
    expect(row.labelAfterImport).toBe(0);
  });

  it("allows enabling labelAfterImport when the gmail.modify scope is present", async () => {
    // makeAccount with labelAfterImport:true grants the gmail.modify scope.
    const accountId = await makeAccount({
      labelFilter: null,
      labelAfterImport: true,
    });

    const updated = await updateAccountSettings(
      { labelAfterImport: true },
      actor,
    );
    expect(updated.labelAfterImport).toBe(1);
    expect(mocks.gmailRequest).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(emailImportAccountsTable)
      .where(eq(emailImportAccountsTable.id, accountId));
    expect(row.labelAfterImport).toBe(1);
  });
});

describe("importMessage attachment download failures", () => {
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

  it("marks the attachment skipped (no document) when the download returns no data", async () => {
    const accountId = await makeAccount({ labelFilter: null });
    const { messageId, attachmentId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-empty",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-empty/.test(url)) {
        // Gmail returns a body with no `data` payload.
        return { data: { size: 0 } };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const before = await db.select().from(billingDocumentsTable);

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 0, skipped: 1, duplicates: 0 });

    // No billing document was created.
    const after = await db.select().from(billingDocumentsTable);
    expect(after).toHaveLength(before.length);

    // The attachment is recorded as skipped with the download reason.
    const [att] = await db
      .select()
      .from(emailImportAttachmentsTable)
      .where(eq(emailImportAttachmentsTable.id, attachmentId));
    expect(att.skipped).toBe(1);
    expect(att.billingDocumentId).toBeNull();
    expect(att.skipReason).toMatch(/stáhnout/);
  });

  it("marks the attachment skipped (no document) when the download throws", async () => {
    const accountId = await makeAccount({ labelFilter: null });
    const { messageId, attachmentId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-boom",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url }) => {
      if (/\/attachments\/att-boom/.test(url)) {
        throw new Error("network down");
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const before = await db.select().from(billingDocumentsTable);

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 0, skipped: 1, duplicates: 0 });

    const after = await db.select().from(billingDocumentsTable);
    expect(after).toHaveLength(before.length);

    const [att] = await db
      .select()
      .from(emailImportAttachmentsTable)
      .where(eq(emailImportAttachmentsTable.id, attachmentId));
    expect(att.skipped).toBe(1);
    expect(att.billingDocumentId).toBeNull();
    expect(att.skipReason).toMatch(/[Cc]hyba při stahování/);
  });
});

describe("ensureImportLabel create-on-missing", () => {
  function modifyCalls() {
    return mocks.gmailRequest.mock.calls.filter((c) =>
      /\/messages\/[^/?]+\/modify$/.test(c[0].url),
    );
  }
  function labelCreateCalls() {
    return mocks.gmailRequest.mock.calls.filter(
      (c) => /\/labels$/.test(c[0].url) && c[0].method === "POST",
    );
  }

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

  it("creates the import label (POST /labels) when it does not exist, then labels the message", async () => {
    const accountId = await makeAccount({
      labelFilter: null,
      labelAfterImport: true,
    });
    const content = Buffer.from(`make-label-${TAG}`);
    const hash = sha256Of(content);
    const { messageId } = await seedMessageWithAttachment({
      accountId,
      providerAttachmentId: "att-mklabel",
      fileName: "faktura.pdf",
      contentType: "application/pdf",
    });

    mocks.gmailRequest.mockImplementation(async ({ url, method }) => {
      if (/\/attachments\/att-mklabel/.test(url)) {
        return {
          data: { data: content.toString("base64"), size: content.length },
        };
      }
      // Creating the label: POST /labels returns the new label id.
      if (/\/labels$/.test(url) && method === "POST") {
        return { data: { id: "Label_created" } };
      }
      // Listing labels: the "Modvolt – importováno" label is NOT present yet.
      if (/\/labels$/.test(url)) {
        return { data: { labels: [{ id: "Label_1", name: "Faktury" }] } };
      }
      if (/\/messages\/[^/?]+\/modify$/.test(url)) {
        return { data: {} };
      }
      throw new Error(`unexpected Gmail call: ${url}`);
    });

    const result = await importMessage(messageId, actor);
    expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 0 });

    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    docIds.push(doc.id);

    // The label did not exist, so it was created exactly once.
    const creates = labelCreateCalls();
    expect(creates).toHaveLength(1);
    expect(creates[0][0].data).toMatchObject({ name: "Modvolt – importováno" });

    // The message is labeled with the NEWLY-created label id.
    const mods = modifyCalls();
    expect(mods).toHaveLength(1);
    expect(mods[0][0].method).toBe("POST");
    expect(mods[0][0].data).toEqual({ addLabelIds: ["Label_created"] });

    const [msg] = await db
      .select()
      .from(emailImportMessagesTable)
      .where(eq(emailImportMessagesTable.id, messageId));
    expect(msg.labeled).toBe(1);
  });
});
