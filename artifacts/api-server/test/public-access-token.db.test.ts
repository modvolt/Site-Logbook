import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  peopleTable,
  pool,
  ppeAssignmentsTable,
  ppeItemsTable,
  ppePublicEvidenceVersionsTable,
  publicAccessTokensTable,
  quoteDecisionEventsTable,
  quotesTable,
  quoteVersionsTable,
  usersTable,
  type PpePublicEvidencePurpose,
  type PpePublicEvidenceSnapshot,
  type QuoteVersionSnapshot,
} from "@workspace/db";
import { evidenceSha256 } from "../src/lib/evidence-hash";
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
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "../src/lib/auth-session";

const RESOURCE_BASE = 910_000 + Math.floor(Math.random() * 10_000);
const resourceIds = Array.from(
  { length: 9 },
  (_, index) => RESOURCE_BASE + index,
);
const quoteIds: number[] = [];
let issuerId: number;
let inactiveIssuerId: number;
let permissionRaceIssuerId: number;
const ppeEvidenceVersionIds = new Map<string, number>();

function ppeEvidenceVersionId(
  resourceIndex: number,
  purpose: PpePublicEvidencePurpose,
): number {
  const id = ppeEvidenceVersionIds.get(`${resourceIndex}:${purpose}`);
  if (!id) throw new Error("PPE evidence fixture was not initialized.");
  return id;
}

function future(minutes = 10): Date {
  return new Date(Date.now() + minutes * 60_000);
}

beforeAll(async () => {
  const users = await db
    .insert(usersTable)
    .values([
      {
        username: `r16b-issuer-${RESOURCE_BASE}`,
        passwordHash: "not-used",
        name: "R16-B issuer",
        role: "admin",
        isActive: true,
      },
      {
        username: `r16b-inactive-${RESOURCE_BASE}`,
        passwordHash: "not-used",
        name: "R16-B inactive issuer",
        role: "admin",
        isActive: false,
      },
      {
        username: `r16b-permission-race-${RESOURCE_BASE}`,
        passwordHash: "not-used",
        name: "R16-B permission race issuer",
        role: "admin",
        isActive: true,
      },
    ])
    .returning({ id: usersTable.id, isActive: usersTable.isActive });
  issuerId = users.find((user) => user.isActive)!.id;
  inactiveIssuerId = users.find((user) => !user.isActive)!.id;
  permissionRaceIssuerId = users.find(
    (user) => user.id !== issuerId && user.isActive,
  )!.id;

  const [person] = await db
    .insert(peopleTable)
    .values({
      name: `R16-B recipient ${RESOURCE_BASE}`,
    })
    .returning();
  const [item] = await db
    .insert(ppeItemsTable)
    .values({
      name: `R16-B helmet ${RESOURCE_BASE}`,
      category: "hlava",
      active: true,
    })
    .returning();
  const fixtureIndexes = [0, 1, 2, 3, 5, 6, 7, 8] as const;
  for (const resourceIndex of fixtureIndexes) {
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        id: resourceIds[resourceIndex]!,
        ppeItemId: item!.id,
        personId: person!.id,
        ppeNameSnapshot: item!.name,
        personNameSnapshot: person!.name,
        quantity: 1,
        issuedAt: "2026-08-05",
        status: "issued",
      })
      .returning();
    const purposes: PpePublicEvidencePurpose[] =
      resourceIndex === 6
        ? ["ppe_signature", "ppe_confirmation"]
        : [resourceIndex === 3 ? "ppe_signature" : "ppe_confirmation"];
    for (const [purposeIndex, purpose] of purposes.entries()) {
      const confirmationText = `R16-B ${purpose} confirmation`;
      const snapshot: PpePublicEvidenceSnapshot = {
        schemaVersion: 1,
        purpose,
        assignment: {
          id: assignment!.id,
          ppeNameSnapshot: assignment!.ppeNameSnapshot,
          personNameSnapshot: assignment!.personNameSnapshot,
          ppeCategorySnapshot: assignment!.ppeCategorySnapshot,
          ppeStandardSnapshot: assignment!.ppeStandardSnapshot,
          ppeProtectionClassSnapshot: assignment!.ppeProtectionClassSnapshot,
          ppeRiskDescriptionSnapshot: assignment!.ppeRiskDescriptionSnapshot,
          quantity: assignment!.quantity,
          size: assignment!.size,
          serialNumber: assignment!.serialNumber,
          issuedAt: assignment!.issuedAt,
          replaceBy: assignment!.replaceBy,
          nextInspectionAt: assignment!.nextInspectionAt,
        },
        confirmationText,
      };
      const [version] = await db
        .insert(ppePublicEvidenceVersionsTable)
        .values({
          assignmentId: assignment!.id,
          purpose,
          version: purposeIndex + 1,
          dataSnapshot: snapshot,
          snapshotSha256: evidenceSha256(snapshot),
          confirmationText,
          createdByUserId: issuerId,
        })
        .returning();
      ppeEvidenceVersionIds.set(`${resourceIndex}:${purpose}`, version!.id);
    }
  }
});

afterAll(async () => {
  const ids = [...resourceIds, ...quoteIds];
  await db
    .delete(publicAccessTokensTable)
    .where(inArray(publicAccessTokensTable.resourceId, ids));
  await db
    .delete(usersTable)
    .where(
      inArray(usersTable.id, [
        issuerId,
        inactiveIssuerId,
        permissionRaceIssuerId,
      ]),
    );
});

async function waitForTransactionBlockedBy(
  blocker: Awaited<ReturnType<typeof pool.connect>>,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await blocker.query<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where pid <> pg_backend_pid()
            and datname = current_database()
            and pg_backend_pid() = any(pg_blocking_pids(pid))
       ) as blocked`,
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Timed out waiting for a transaction blocked by the fixture.",
  );
}

describe("hash-only public access token lifecycle", () => {
  it("stores only a SHA-256 hash and atomically revokes the previous issuance", async () => {
    const first = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[0]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(0, "ppe_confirmation"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.record.tokenHash).toBe(hashPublicAccessToken(first.token));
    expect(JSON.stringify(first.record)).not.toContain(first.token);
    expect(first.record).toMatchObject({
      createdByUserId: issuerId,
      ownerKind: "organization",
      ownerUserId: null,
      ownerAssignmentSource: "resource_organization",
    });

    const resolved = await resolvePublicAccessToken(
      "ppe_confirmation",
      first.token,
    );
    expect(resolved.resourceId).toBe(resourceIds[0]);

    const second = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[0]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(0, "ppe_confirmation"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    await expect(
      resolvePublicAccessToken("ppe_confirmation", first.token),
    ).rejects.toMatchObject({ code: "revoked" });
    await expect(
      resolvePublicAccessToken("ppe_confirmation", second.token),
    ).resolves.toMatchObject({ resourceId: resourceIds[0] });
  });

  it("fails closed for expired and explicitly revoked credentials", async () => {
    const expired = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[1]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(1, "ppe_confirmation"),
      expiresAt: new Date(Date.now() - 1_000),
      createdByUserId: issuerId,
      allowExpiredForTesting: true,
    });
    await expect(
      resolvePublicAccessToken("ppe_confirmation", expired.token),
    ).rejects.toMatchObject({ code: "expired" });

    const active = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[2]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(2, "ppe_confirmation"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    expect(
      await revokePublicAccessTokens({
        purpose: "ppe_confirmation",
        resourceId: resourceIds[2]!,
        reason: "test_revoke",
      }),
    ).toBe(1);
    await expect(
      resolvePublicAccessToken("ppe_confirmation", active.token),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("allows exactly one concurrent consume and records its action", async () => {
    const issued = await issuePublicAccessToken({
      purpose: "ppe_signature",
      resourceId: resourceIds[3]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(3, "ppe_signature"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    const consume = () =>
      consumePublicAccessToken({
        purpose: "ppe_signature" as const,
        token: issued.token,
        action: "signed",
        transition: async () => "ok",
      });
    const results = await Promise.allSettled([consume(), consume()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
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
      .values({
        title: `Legacy token ${RESOURCE_BASE}`,
        status: "sent",
        shareToken: legacyToken,
      })
      .returning();
    quoteIds.push(quote!.id);

    await expect(
      resolvePublicAccessToken("quote_decision", legacyToken),
    ).rejects.toMatchObject({ code: "revoked" });
    const [stored] = await db
      .select({ shareToken: quotesTable.shareToken })
      .from(quotesTable)
      .where(inArray(quotesTable.id, [quote!.id]));
    expect(stored?.shareToken).toBeNull();
    const [imported] = await db
      .select()
      .from(publicAccessTokensTable)
      .where(inArray(publicAccessTokensTable.resourceId, [quote!.id]));
    expect(imported?.artifactBindingStatus).toBe("legacy_unbound");
    expect(imported?.legacyImportedAt).toBeInstanceOf(Date);
  });

  it("makes public quote accept/reject a single atomic decision", async () => {
    const [quote] = await db
      .insert(quotesTable)
      .values({ title: `Decision race ${RESOURCE_BASE}`, status: "sent" })
      .returning();
    quoteIds.push(quote!.id);
    const snapshot: QuoteVersionSnapshot = {
      schemaVersion: 2,
      quote: {
        id: quote!.id,
        quoteNumber: null,
        title: quote!.title,
        validUntil: null,
        notes: null,
        createdAt: quote!.createdAt.toISOString(),
      },
      customer: {
        companyName: null,
        ic: null,
        dic: null,
        address: null,
        email: null,
      },
      supplier: {
        name: "Modvolt s.r.o.",
        ic: null,
        dic: null,
        address: null,
        email: null,
        phone: null,
        footerNote: null,
        vatPayer: true,
      },
      items: [],
      totals: {
        subtotalWithoutVat: 0,
        totalVat: 0,
        totalWithVat: 0,
        currency: "Kč",
      },
      confirmationText: "Testovací potvrzení konkrétní verze nabídky.",
    };
    const [version] = await db
      .insert(quoteVersionsTable)
      .values({
        quoteId: quote!.id,
        version: 1,
        dataSnapshot: snapshot,
        snapshotSha256: "a".repeat(64),
        pdfObjectPath: `/objects/quotes/test-${quote!.id}.pdf`,
        pdfSha256: "b".repeat(64),
        rendererVersion: "test-v1",
      })
      .returning();
    const issued = await issuePublicAccessToken({
      purpose: "quote_decision",
      resourceId: quote!.id,
      quoteVersionId: version!.id,
      expiresAt: future(),
      createdByUserId: issuerId,
    });

    const decisions = await Promise.allSettled([
      acceptQuoteByToken(issued.token, { respondentName: "Test Accept" }),
      rejectQuoteByToken(issued.token, { respondentName: "Test Reject" }),
    ]);
    expect(
      decisions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      decisions.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
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
    const events = await db
      .select()
      .from(quoteDecisionEventsTable)
      .where(inArray(quoteDecisionEventsTable.quoteId, [quote!.id]));
    expect(events).toHaveLength(1);
    expect(events[0]?.quoteVersionId).toBe(version!.id);
  });

  it("locks the domain resource before entering the consume transition", async () => {
    const issued = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[8]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(8, "ppe_confirmation"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    const holder = await pool.connect();
    let transitionEntered = false;
    try {
      await holder.query("begin");
      await holder.query(
        "select id from ppe_assignments where id = $1 for update",
        [resourceIds[8]],
      );
      const pendingConsume = consumePublicAccessToken({
        purpose: "ppe_confirmation",
        token: issued.token,
        action: "confirmed",
        transition: async () => {
          transitionEntered = true;
          return "ok";
        },
      });
      await waitForTransactionBlockedBy(holder);
      expect(transitionEntered).toBe(false);
      await holder.query("commit");
      await expect(pendingConsume).resolves.toBe("ok");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("observes a role revocation that wins the shared issuance lock", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1, $2)", [
        SESSION_ISSUANCE_LOCK_NAMESPACE,
        permissionRaceIssuerId,
      ]);
      await holder.query("update users set role = 'guest' where id = $1", [
        permissionRaceIssuerId,
      ]);
      const pendingIssue = issuePublicAccessToken({
        purpose: "ppe_confirmation",
        resourceId: resourceIds[7]!,
        ppeEvidenceVersionId: ppeEvidenceVersionId(7, "ppe_confirmation"),
        expiresAt: future(),
        createdByUserId: permissionRaceIssuerId,
      });
      await waitForTransactionBlockedBy(holder);
      await holder.query("commit");
      await expect(pendingIssue).rejects.toMatchObject({
        code: "issuer_permission_revoked",
      });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("rejects inactive issuers and makes PPE grant modes mutually exclusive", async () => {
    await expect(
      issuePublicAccessToken({
        purpose: "ppe_confirmation",
        resourceId: resourceIds[5]!,
        ppeEvidenceVersionId: ppeEvidenceVersionId(5, "ppe_confirmation"),
        expiresAt: future(),
        createdByUserId: inactiveIssuerId,
      }),
    ).rejects.toMatchObject({ code: "issuer_inactive" });

    const signature = await issuePublicAccessToken({
      purpose: "ppe_signature",
      resourceId: resourceIds[6]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(6, "ppe_signature"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });
    const confirmation = await issuePublicAccessToken({
      purpose: "ppe_confirmation",
      resourceId: resourceIds[6]!,
      ppeEvidenceVersionId: ppeEvidenceVersionId(6, "ppe_confirmation"),
      expiresAt: future(),
      createdByUserId: issuerId,
    });

    await expect(
      resolvePublicAccessToken("ppe_signature", signature.token),
    ).rejects.toMatchObject({ code: "revoked" });
    await expect(
      resolvePublicAccessToken("ppe_confirmation", confirmation.token),
    ).resolves.toMatchObject({ resourceId: resourceIds[6] });

    const [activeIssuer] = await db
      .select({ isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, issuerId));
    expect(activeIssuer?.isActive).toBe(true);
  });
});
