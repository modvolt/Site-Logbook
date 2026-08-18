import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  quotesTable,
  quoteItemsTable,
  customersTable,
  billingSettingsTable,
  publicAccessTokensTable,
  quoteDecisionEventsTable,
  quoteVersionsTable,
  usersTable,
} from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { hashPublicAccessToken } from "../src/lib/public-access-token";

/**
 * Quote send flow — create → send (DB-backed).
 *
 * Locks in the happy-path guarantees for POST /quotes/:id/send:
 *  - A draft quote with items can be created via createQuote.
 *  - sendQuote generates a non-empty PDF buffer (font embedding works),
 *    persists it to object storage, sends the email, and transitions the
 *    quote row to status "sent" with pdfObjectPath set.
 *
 * ObjectStorageService (S3/GCS) and SMTP (nodemailer) are mocked so the
 * tests run in CI without real credentials. The vitest ttfBase64 plugin
 * (vitest.config.ts) mirrors the esbuild ".ttf": "base64" loader so
 * jsPDF's Roboto font embedding works identically to production.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag
 * and are torn down afterwards.
 */

// ---------------------------------------------------------------------------
// Mock SMTP — must be declared before any imports resolve the module
// ---------------------------------------------------------------------------

const sendEmailWithPdfMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/lib/email", () => ({
  sendEmailWithPdf: sendEmailWithPdfMock,
  sendPlainEmail: vi.fn().mockResolvedValue(undefined),
  sendTestEmail: vi.fn().mockResolvedValue(undefined),
  resolveEmailConfig: vi.fn().mockResolvedValue({
    host: "smtp.test",
    port: 587,
    secure: false,
    from: "test@stavba.cz",
  }),
}));

// Import service AFTER vi.mock so the hoisted mock is applied when the
// module resolves its own `import { sendEmailWithPdf } from "./email"`.
const { createQuote, sendQuote, generateAndStorePdf, getQuoteByShareToken } = await import(
  "../src/lib/quote-service"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `test-quote-send-${Date.now()}`;
const originalPublicUrl = process.env.PUBLIC_APP_URL;

let customerId: number;
let quoteIssuerId: number;
const quoteIds: number[] = [];

// Spy on the prototype so the module-level `new ObjectStorageService()` inside
// quote-service.ts is intercepted (prototype methods resolve at call-time).
let putSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = "https://quotes.test";
  putSpy = vi
    .spyOn(ObjectStorageService.prototype, "putPrivateObject")
    .mockResolvedValue(undefined);

  // Quote number allocation locks the singleton row. A fresh isolated DB has
  // no settings yet, so seed the same default row production setup creates.
  await db
    .insert(billingSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing();

  const [issuer] = await db
    .insert(usersTable)
    .values({
      username: `quote-send-issuer-${TAG}`,
      passwordHash: "not-used",
      name: "Quote send test issuer",
      role: "admin",
      isActive: true,
    })
    .returning({ id: usersTable.id });
  quoteIssuerId = issuer.id;

  const [customer] = await db
    .insert(customersTable)
    .values({
      companyName: `Zákazník ${TAG}`,
      email: "nabidka@example.com",
    })
    .returning();
  customerId = customer.id;
});

afterAll(async () => {
  if (originalPublicUrl == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicUrl;
  vi.restoreAllMocks();
  if (quoteIds.length > 0) {
    await db
      .delete(publicAccessTokensTable)
      .where(inArray(publicAccessTokensTable.resourceId, quoteIds));
  }
  if (customerId) {
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  }
  if (quoteIssuerId) {
    await db.delete(usersTable).where(eq(usersTable.id, quoteIssuerId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createQuote", () => {
  it("creates a draft quote with the assigned number and items", async () => {
    const quote = await createQuote({
      customerId,
      title: `Nabídka ${TAG}`,
      validUntil: "2026-12-31",
      notes: "Testovací nabídka",
      items: [
        {
          description: "Práce elektrikáře",
          quantity: 8,
          unit: "hod",
          unitPrice: 650,
          vatRate: 21,
        },
        {
          description: "Materiál kabeláž",
          quantity: 50,
          unit: "m",
          unitPrice: 45,
          vatRate: 21,
        },
      ],
    });

    expect(quote).not.toBeNull();
    expect(quote!.status).toBe("draft");
    expect(quote!.quoteNumber).toMatch(/^NAB\d+$/);
    expect(quote!.items).toHaveLength(2);
    expect(quote!.pdfObjectPath).toBeNull();

    quoteIds.push(quote!.id);
  });
});

describe("generateAndStorePdf", () => {
  it("generates a non-empty PDF buffer and stores it in object storage", async () => {
    const quote = await createQuote({
      customerId,
      title: `PDF test ${TAG}`,
      items: [
        {
          description: "Montáž rozvaděče",
          quantity: 1,
          unit: "ks",
          unitPrice: 12000,
          vatRate: 21,
        },
      ],
    });
    expect(quote).not.toBeNull();
    quoteIds.push(quote!.id);

    putSpy.mockClear();

    const { buffer, objectPath } = await generateAndStorePdf(quote!.id);

    // Buffer must be a real PDF (jsPDF output, not empty, not corrupt)
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000); // a minimal PDF is several kB
    expect(buffer.slice(0, 4).toString()).toBe("%PDF"); // PDF magic bytes

    // Object path stored in DB
    expect(typeof objectPath).toBe("string");
    expect(objectPath.length).toBeGreaterThan(0);

    // putPrivateObject was called once with the correct mime type
    expect(putSpy).toHaveBeenCalledOnce();
    const [calledPath, calledBuffer, calledMime] = putSpy.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(calledPath).toBe(objectPath);
    expect(calledBuffer.equals(buffer)).toBe(true);
    expect(calledMime).toBe("application/pdf");

    // pdfObjectPath is persisted on the quote row
    const [row] = await db
      .select({ pdfObjectPath: quotesTable.pdfObjectPath })
      .from(quotesTable)
      .where(eq(quotesTable.id, quote!.id))
      .limit(1);
    expect(row?.pdfObjectPath).toBe(objectPath);
  });
});

describe("sendQuote", () => {
  it("transitions status to sent, sets pdfObjectPath, and calls sendEmailWithPdf", async () => {
    const quote = await createQuote({
      customerId,
      title: `Odeslání ${TAG}`,
      validUntil: "2026-09-30",
      items: [
        {
          description: "Revize elektroinstalace",
          quantity: 1,
          unit: "ks",
          unitPrice: 3500,
          vatRate: 21,
        },
        {
          description: "Cestovní výdaje",
          quantity: 2,
          unit: "km",
          unitPrice: 6.5,
          vatRate: 21,
        },
      ],
    });
    expect(quote).not.toBeNull();
    quoteIds.push(quote!.id);

    sendEmailWithPdfMock.mockClear();
    putSpy.mockClear();

    const result = await sendQuote(quote!.id, {
      to: "zakaznik@example.com",
      subject: null,
      message: null,
      createdByUserId: quoteIssuerId,
    });

    // Return value
    expect(result.sent).toBe(true);
    expect(result.to).toBe("zakaznik@example.com");
    expect(result.quoteVersion).toBe(1);
    expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pdfSha256).toMatch(/^[0-9a-f]{64}$/);

    // DB: status → sent, pdfObjectPath set
    const [row] = await db
      .select({
        status: quotesTable.status,
        pdfObjectPath: quotesTable.pdfObjectPath,
        shareToken: quotesTable.shareToken,
      })
      .from(quotesTable)
      .where(eq(quotesTable.id, quote!.id))
      .limit(1);

    expect(row?.status).toBe("sent");
    expect(row?.pdfObjectPath).toBeTruthy();
    expect(row?.shareToken).toBeNull();

    // Object storage: PDF was uploaded
    expect(putSpy).toHaveBeenCalledOnce();

    // Email: sendEmailWithPdf was called with a non-empty base64 PDF
    expect(sendEmailWithPdfMock).toHaveBeenCalledOnce();
    const emailCall = sendEmailWithPdfMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
      pdfBase64: string;
      filename: string;
    };
    expect(emailCall.to).toBe("zakaznik@example.com");
    expect(emailCall.subject).toContain("Cenová nabídka");
    const emailedUrl = /https:\/\/quotes\.test\/quote-share#token=[A-Za-z0-9_-]{43}/
      .exec(emailCall.text)?.[0];
    expect(emailedUrl).toBeTruthy();
    const parsedEmailUrl = new URL(emailedUrl!);
    expect(parsedEmailUrl.pathname).toBe("/quote-share");
    expect(parsedEmailUrl.search).toBe("");
    const emailedToken = new URLSearchParams(parsedEmailUrl.hash.slice(1)).get("token");
    expect(emailedToken).toBeTruthy();
    const [tokenRow] = await db
      .select({
        tokenHash: publicAccessTokensTable.tokenHash,
        binding: publicAccessTokensTable.artifactBindingStatus,
        quoteVersionId: publicAccessTokensTable.quoteVersionId,
      })
      .from(publicAccessTokensTable)
      .where(and(
        eq(publicAccessTokensTable.purpose, "quote_decision"),
        eq(publicAccessTokensTable.resourceId, quote!.id),
        isNull(publicAccessTokensTable.revokedAt),
      ));
    expect(tokenRow?.tokenHash).toBe(hashPublicAccessToken(emailedToken!));
    expect(tokenRow?.binding).toBe("bound");
    expect(tokenRow?.quoteVersionId).toEqual(expect.any(Number));
    expect(JSON.stringify(tokenRow)).not.toContain(emailedToken!);
    expect(emailCall.pdfBase64.length).toBeGreaterThan(100);
    expect(emailCall.filename).toMatch(/^nabidka-.*\.pdf$/);

    // Sanity: the base64 decodes to a real PDF
    const decoded = Buffer.from(emailCall.pdfBase64, "base64");
    expect(decoded.slice(0, 4).toString()).toBe("%PDF");

    const [version] = await db
      .select()
      .from(quoteVersionsTable)
      .where(eq(quoteVersionsTable.quoteId, quote!.id));
    expect(version).toMatchObject({
      version: 1,
      snapshotSha256: result.snapshotSha256,
      pdfSha256: result.pdfSha256,
    });

    const publicBefore = await getQuoteByShareToken(emailedToken!);
    await db.update(quotesTable).set({ title: `${TAG}-tampered-live-title` }).where(eq(quotesTable.id, quote!.id));
    await db.update(quoteItemsTable).set({ description: `${TAG}-tampered-live-item` }).where(eq(quoteItemsTable.quoteId, quote!.id));
    const publicAfter = await getQuoteByShareToken(emailedToken!);
    expect(publicAfter?.title).toBe(publicBefore?.title);
    expect(publicAfter?.items).toEqual(publicBefore?.items);
    expect(publicAfter?.snapshotSha256).toBe(publicBefore?.snapshotSha256);
  });

  it("rejects send when the recipient email is missing or invalid", async () => {
    const quote = await createQuote({
      customerId: null, // no customer → no email
      title: `No-email ${TAG}`,
      items: [],
    });
    expect(quote).not.toBeNull();
    quoteIds.push(quote!.id);

    await expect(
      sendQuote(quote!.id, {
        to: "",
        subject: null,
        message: null,
        createdByUserId: quoteIssuerId,
      }),
    ).rejects.toThrow(/platná e-mailová adresa/i);
  });

  it("resends to a sent quote (idempotent re-send)", async () => {
    const quote = await createQuote({
      customerId,
      title: `Resend ${TAG}`,
      items: [
        {
          description: "Servis",
          quantity: 1,
          unit: "ks",
          unitPrice: 1000,
          vatRate: 0,
        },
      ],
    });
    expect(quote).not.toBeNull();
    quoteIds.push(quote!.id);

    // First send
    await sendQuote(quote!.id, {
      to: "a@example.com",
      subject: null,
      message: null,
      createdByUserId: quoteIssuerId,
    });

    // Second send — quote is already "sent"; service allows re-sending
    sendEmailWithPdfMock.mockClear();
    const result = await sendQuote(quote!.id, {
      to: "b@example.com",
      subject: "Druhé zaslání",
      message: "Posíláme znovu.",
      createdByUserId: quoteIssuerId,
    });
    expect(result.sent).toBe(true);
    expect(result.to).toBe("b@example.com");
    expect(result.quoteVersion).toBe(2);
    expect(sendEmailWithPdfMock).toHaveBeenCalledOnce();
    const supersededEvents = await db
      .select()
      .from(quoteDecisionEventsTable)
      .where(eq(quoteDecisionEventsTable.quoteId, quote!.id));
    expect(supersededEvents).toEqual([
      expect.objectContaining({
        action: "superseded",
        actorType: "system",
        reason: "quote_reissued",
      }),
    ]);
    const emailCall = sendEmailWithPdfMock.mock.calls[0][0] as {
      subject: string;
    };
    expect(emailCall.subject).toBe("Druhé zaslání");
  });
});
