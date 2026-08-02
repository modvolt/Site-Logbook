import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  db,
  publicAccessTokensTable,
  quotesTable,
} from "@workspace/db";
import {
  consumePublicAccessToken,
  hashPublicAccessToken,
  issuePublicAccessToken,
  PublicAccessTokenError,
  resolvePublicAccessToken,
  revokePublicAccessTokens,
} from "../src/lib/public-access-token";
import {
  acceptQuoteByToken,
  rejectQuoteByToken,
} from "../src/lib/quote-service";

const RESOURCE_BASE = 910_000 + Math.floor(Math.random() * 10_000);
const resourceIds = [
  RESOURCE_BASE,
  RESOURCE_BASE + 1,
  RESOURCE_BASE + 2,
  RESOURCE_BASE + 3,
  RESOURCE_BASE + 4,
];
const quoteIds: number[] = [];

function future(minutes = 10): Date {
  return new Date(Date.now() + minutes * 60_000);
}

afterAll(async () => {
  const ids = [...resourceIds, ...quoteIds];
  await db
    .delete(publicAccessTokensTable)
    .where(inArray(publicAccessTokensTable.resourceId, ids));
  if (quoteIds.length > 0) {
    await db.delete(quotesTable).where(inArray(quotesTable.id, quoteIds));
  }
});

describe("hash-only public access token lifecycle", () => {
  it("stores only a SHA-256 hash and atomically revokes the previous issuance", async () => {
    const first = await issuePublicAccessToken({
      purpose: "job_signature",
      resourceId: resourceIds[0]!,
      expiresAt: future(),
    });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.record.tokenHash).toBe(hashPublicAccessToken(first.token));
    expect(JSON.stringify(first.record)).not.toContain(first.token);

    const resolved = await resolvePublicAccessToken(
      "job_signature",
      first.token,
    );
    expect(resolved.resourceId).toBe(resourceIds[0]);

    const second = await issuePublicAccessToken({
      purpose: "job_signature",
      resourceId: resourceIds[0]!,
      expiresAt: future(),
    });
    await expect(
      resolvePublicAccessToken("job_signature", first.token),
    ).rejects.toMatchObject({ code: "revoked" });
    await expect(
      resolvePublicAccessToken("job_signature", second.token),
    ).resolves.toMatchObject({ resourceId: resourceIds[0] });
  });

  it("fails closed for expired and explicitly revoked credentials", async () => {
    const expired = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[1]!,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      resolvePublicAccessToken("ppe_confirmation", expired.token),
    ).rejects.toMatchObject({ code: "expired" });

    const active = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[2]!,
      expiresAt: future(),
    });
    expect(await revokePublicAccessTokens({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[2]!,
      reason: "test_revoke",
    })).toBe(1);
    await expect(
      resolvePublicAccessToken("ppe_confirmation", active.token),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("allows exactly one concurrent consume and records its action", async () => {
    const issued = await issuePublicAccessToken({
      purpose: "ppe_signature",
      resourceId: resourceIds[3]!,
      expiresAt: future(),
    });
    const consume = () => consumePublicAccessToken({
      purpose: "ppe_signature" as const,
      token: issued.token,
      action: "signed",
      transition: async () => "ok",
    });
    const results = await Promise.allSettled([consume(), consume()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      PublicAccessTokenError,
    );
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "consumed",
    });

    const [row] = await db
      .select()
      .from(publicAccessTokensTable)
      .where(inArray(publicAccessTokensTable.id, [issued.record.id]));
    expect(row?.consumedAt).toBeInstanceOf(Date);
    expect(row?.consumeAction).toBe("signed");
  });

  it("imports a legacy quote token once and clears its plaintext column", async () => {
    const legacyToken = "11111111-2222-4333-8444-555555555555";
    const [quote] = await db
      .insert(quotesTable)
      .values({ title: `Legacy token ${RESOURCE_BASE}`, status: "sent", shareToken: legacyToken })
      .returning();
    quoteIds.push(quote!.id);

    const resolved = await resolvePublicAccessToken(
      "quote_decision",
      legacyToken,
    );
    expect(resolved.resourceId).toBe(quote!.id);
    expect(resolved.legacyImportedAt).toBeInstanceOf(Date);
    const [stored] = await db
      .select({ shareToken: quotesTable.shareToken })
      .from(quotesTable)
      .where(inArray(quotesTable.id, [quote!.id]));
    expect(stored?.shareToken).toBeNull();
  });

  it("makes public quote accept/reject a single atomic decision", async () => {
    const [quote] = await db
      .insert(quotesTable)
      .values({ title: `Decision race ${RESOURCE_BASE}`, status: "sent" })
      .returning();
    quoteIds.push(quote!.id);
    const issued = await issuePublicAccessToken({
      purpose: "quote_decision",
      resourceId: quote!.id,
      expiresAt: future(),
    });

    const decisions = await Promise.allSettled([
      acceptQuoteByToken(issued.token),
      rejectQuoteByToken(issued.token),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [finalQuote] = await db
      .select({ status: quotesTable.status })
      .from(quotesTable)
      .where(inArray(quotesTable.id, [quote!.id]));
    expect(["accepted", "rejected"]).toContain(finalQuote?.status);
    const [tokenRow] = await db
      .select({ consumeAction: publicAccessTokensTable.consumeAction })
      .from(publicAccessTokensTable)
      .where(inArray(publicAccessTokensTable.id, [issued.record.id]));
    expect(tokenRow?.consumeAction).toBe(finalQuote?.status);
  });
});
