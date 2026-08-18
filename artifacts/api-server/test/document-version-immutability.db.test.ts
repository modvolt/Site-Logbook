import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  jobDocumentVersionsTable,
  jobSignatureEventsTable,
  jobsTable,
  publicAccessTokensTable,
  quoteDecisionEventsTable,
  quotesTable,
  quoteVersionsTable,
  type JobDocumentSnapshot,
  type QuoteVersionSnapshot,
} from "@workspace/db";

const TAG = `immutable-evidence-${Date.now()}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function jobSnapshot(jobId: number): JobDocumentSnapshot {
  return {
    schemaVersion: 1,
    job: {
      id: jobId,
      title: TAG,
      date: "2026-08-20",
      customerCompanyName: null,
      notes: "Přesný testovací obsah",
    },
    confirmationText: "Potvrzuji konkrétní testovací verzi.",
  };
}

function quoteSnapshot(quoteId: number): QuoteVersionSnapshot {
  return {
    schemaVersion: 2,
    quote: {
      id: quoteId,
      quoteNumber: `TEST-${quoteId}`,
      title: TAG,
      validUntil: "2026-09-30",
      notes: null,
      createdAt: new Date().toISOString(),
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
    confirmationText: "Potvrzuji konkrétní testovací nabídku.",
  };
}

describe("immutable job and quote evidence at the database boundary", () => {
  it("allows the one job signing transition and then rejects tamper/delete", async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        title: TAG,
        type: "planned_work",
        date: "2026-08-20",
        status: "done",
      })
      .returning();
    const [version] = await db
      .insert(jobDocumentVersionsTable)
      .values({
        jobId: job!.id,
        version: 1,
        dataSnapshot: jobSnapshot(job!.id),
        snapshotSha256: HASH_A,
        rendererVersion: "test-v1",
        confirmationText: "Potvrzuji konkrétní testovací verzi.",
      })
      .returning();
    const signedAt = new Date();
    await expect(
      db
        .update(jobDocumentVersionsTable)
        .set({
          status: "signed",
          signatoryName: "Jan Testovací",
          identityAssurance: "self_declared_name",
          signatureObjectPath: `/objects/job-signatures/${job!.id}-test.png`,
          signatureSha256: HASH_B,
          pdfObjectPath: `/objects/job-signed-documents/${job!.id}-test.pdf`,
          pdfSha256: HASH_B,
          signedAt,
        })
        .where(eq(jobDocumentVersionsTable.id, version!.id)),
    ).resolves.toBeDefined();

    await expect(
      db
        .update(jobDocumentVersionsTable)
        .set({ snapshotSha256: HASH_B })
        .where(eq(jobDocumentVersionsTable.id, version!.id)),
    ).rejects.toBeDefined();
    const [unchangedJobVersion] = await db
      .select({ snapshotSha256: jobDocumentVersionsTable.snapshotSha256 })
      .from(jobDocumentVersionsTable)
      .where(eq(jobDocumentVersionsTable.id, version!.id));
    expect(unchangedJobVersion?.snapshotSha256).toBe(HASH_A);
    await expect(
      db
        .delete(jobDocumentVersionsTable)
        .where(eq(jobDocumentVersionsTable.id, version!.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .select({ id: jobDocumentVersionsTable.id })
        .from(jobDocumentVersionsTable)
        .where(eq(jobDocumentVersionsTable.id, version!.id)),
    ).resolves.toHaveLength(1);

    const [event] = await db
      .insert(jobSignatureEventsTable)
      .values({
        jobId: job!.id,
        documentVersionId: version!.id,
        eventType: "signed",
        actorType: "public_signer",
        actorName: "Jan Testovací",
      })
      .returning();
    await expect(
      db
        .update(jobSignatureEventsTable)
        .set({ actorName: "Přepsané jméno" })
        .where(eq(jobSignatureEventsTable.id, event!.id)),
    ).rejects.toBeDefined();
    const [unchangedJobEvent] = await db
      .select({ actorName: jobSignatureEventsTable.actorName })
      .from(jobSignatureEventsTable)
      .where(eq(jobSignatureEventsTable.id, event!.id));
    expect(unchangedJobEvent?.actorName).toBe(event!.actorName);
  });

  it("rejects quote version/event mutation and invalid bound tokens", async () => {
    const [quote] = await db
      .insert(quotesTable)
      .values({ title: TAG, status: "sent" })
      .returning();
    const [version] = await db
      .insert(quoteVersionsTable)
      .values({
        quoteId: quote!.id,
        version: 1,
        dataSnapshot: quoteSnapshot(quote!.id),
        snapshotSha256: HASH_A,
        pdfObjectPath: `/objects/quotes/${quote!.id}-test.pdf`,
        pdfSha256: HASH_B,
        rendererVersion: "test-v1",
      })
      .returning();
    await expect(
      db
        .update(quoteVersionsTable)
        .set({ pdfSha256: HASH_A })
        .where(eq(quoteVersionsTable.id, version!.id)),
    ).rejects.toBeDefined();
    const [unchangedQuoteVersion] = await db
      .select({ pdfSha256: quoteVersionsTable.pdfSha256 })
      .from(quoteVersionsTable)
      .where(eq(quoteVersionsTable.id, version!.id));
    expect(unchangedQuoteVersion?.pdfSha256).toBe(HASH_B);
    await expect(
      db
        .delete(quoteVersionsTable)
        .where(eq(quoteVersionsTable.id, version!.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .select({ id: quoteVersionsTable.id })
        .from(quoteVersionsTable)
        .where(eq(quoteVersionsTable.id, version!.id)),
    ).resolves.toHaveLength(1);

    const [event] = await db
      .insert(quoteDecisionEventsTable)
      .values({
        quoteId: quote!.id,
        quoteVersionId: version!.id,
        action: "accepted",
        actorType: "public_recipient",
        actorName: "Eva Testovací",
      })
      .returning();
    await expect(
      db
        .delete(quoteDecisionEventsTable)
        .where(eq(quoteDecisionEventsTable.id, event!.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .select({ id: quoteDecisionEventsTable.id })
        .from(quoteDecisionEventsTable)
        .where(eq(quoteDecisionEventsTable.id, event!.id)),
    ).resolves.toHaveLength(1);

    await expect(
      db.insert(publicAccessTokensTable).values({
        purpose: "quote_decision",
        resourceType: "quote",
        resourceId: quote!.id,
        artifactBindingStatus: "bound",
        quoteVersionId: null,
        tokenHash: HASH_A,
        tokenPrefix: "abcdefgh",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeDefined();
    await expect(
      db
        .select({ id: publicAccessTokensTable.id })
        .from(publicAccessTokensTable)
        .where(eq(publicAccessTokensTable.tokenHash, HASH_A)),
    ).resolves.toHaveLength(0);
  });
});
