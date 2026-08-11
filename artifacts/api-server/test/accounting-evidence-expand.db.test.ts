import { beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  billingDocumentsTable,
  db,
  invoicesTable,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createAccountingPersistenceDbAdapter } from "../src/lib/accounting-persistence-db-adapter";
import { accountingArchiveDbRepository } from "../src/lib/accounting-archive-db-store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_ID = "33333333-3333-4333-8333-333333333333";
const ADAPTER_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const ADAPTER_EVENT_ID = "88888888-8888-4888-8888-888888888888";
const STORE_INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPIRED_INTENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function versionEnvelope(input: { id: string; invoiceId: number }) {
  return JSON.stringify({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: input.id,
    aggregate: { kind: "outgoing-invoice", id: String(input.invoiceId) },
    version: "1",
    purpose: "issued",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    integrity: {
      snapshotSha256: HASH_A,
      artifactSetSha256: HASH_B,
      versionSha256: HASH_C,
    },
  });
}

function lifecycleEnvelope(input: {
  id: string;
  invoiceId: number;
  versionId: string;
  entrySha256?: string;
}) {
  return JSON.stringify({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: input.id,
    aggregate: {
      kind: "outgoing-invoice",
      id: String(input.invoiceId),
      versionId: input.versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "issued",
    integrity: { entrySha256: input.entrySha256 ?? HASH_B },
  });
}

function exportIntentEnvelope(intentId = INTENT_ID, intentSha256 = HASH_A) {
  return JSON.stringify({
    schemaVersion: "site-logbook.accounting-export-intent/v1",
    intentId,
    operation: "initial-version",
    initialState: "pending",
    integrity: { intentSha256 },
  });
}

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
});

describe("R13 accounting evidence expand migration", () => {
  it("accepts one exact persisted head successor and rejects revision drift", async () => {
    const [invoice] = await db
      .insert(invoicesTable)
      .values({ status: "draft" })
      .returning({ id: invoicesTable.id });
    expect(invoice).toBeDefined();
    await db
      .insert(accountingAggregateHeadsTable)
      .values({ invoiceId: invoice!.id });
    await db.insert(accountingDocumentVersionsTable).values({
      id: VERSION_ID,
      invoiceId: invoice!.id,
      version: 1n,
      purpose: "issued",
      historicalCompleteness: "complete",
      recordedAt: new Date("2042-03-04T10:00:00.000Z"),
      canonicalJson: versionEnvelope({
        id: VERSION_ID,
        invoiceId: invoice!.id,
      }),
      snapshotSha256: HASH_A,
      artifactSetSha256: HASH_B,
      versionSha256: HASH_C,
    });
    await pool.query(
      `INSERT INTO accounting_lifecycle_events
       (id, invoice_id, document_version_id, sequence, previous_event_sha256,
        event_type, effective_at, recorded_at, canonical_json, entry_sha256)
       VALUES ($1, $2, $3, 0, NULL, 'issued', $4, $4, $5, $6)`,
      [
        EVENT_ID,
        invoice!.id,
        VERSION_ID,
        "2042-03-04T10:00:00.000Z",
        lifecycleEnvelope({
          id: EVENT_ID,
          invoiceId: invoice!.id,
          versionId: VERSION_ID,
        }),
        HASH_B,
      ],
    );

    const advanced = await pool.query(
      `UPDATE accounting_aggregate_heads
       SET revision = 1,
           version_head_version = 1,
           version_head_id = $1,
           version_head_sha256 = $2,
           lifecycle_head_sequence = 0,
           lifecycle_head_id = $3,
           lifecycle_head_sha256 = $4,
           updated_at = now()
       WHERE invoice_id = $5
       RETURNING revision`,
      [VERSION_ID, HASH_C, EVENT_ID, HASH_B, invoice!.id],
    );
    expect(advanced.rows[0]?.revision).toBe("1");

    await expect(
      pool.query(
        `UPDATE accounting_aggregate_heads
         SET revision = 3, updated_at = now()
         WHERE invoice_id = $1`,
        [invoice!.id],
      ),
    ).rejects.toThrow(/exactly one revision/i);
    const [unchanged] = await db
      .select({ revision: accountingAggregateHeadsTable.revision })
      .from(accountingAggregateHeadsTable)
      .where(eq(accountingAggregateHeadsTable.invoiceId, invoice!.id));
    expect(unchanged?.revision).toBe(1n);
  });

  it("executes exact caller-owned adapter CAS and rejects a stale expected state", async () => {
    const [invoice] = await db
      .insert(invoicesTable)
      .values({ status: "draft" })
      .returning({ id: invoicesTable.id });
    await db.insert(accountingDocumentVersionsTable).values({
      id: ADAPTER_VERSION_ID,
      invoiceId: invoice!.id,
      version: 1n,
      purpose: "issued",
      historicalCompleteness: "complete",
      recordedAt: new Date("2042-03-04T11:00:00.000Z"),
      canonicalJson: versionEnvelope({
        id: ADAPTER_VERSION_ID,
        invoiceId: invoice!.id,
      }),
      snapshotSha256: HASH_A,
      artifactSetSha256: HASH_B,
      versionSha256: HASH_C,
    });
    await pool.query(
      `INSERT INTO accounting_lifecycle_events
       (id, invoice_id, document_version_id, sequence, previous_event_sha256,
        event_type, effective_at, recorded_at, canonical_json, entry_sha256)
       VALUES ($1, $2, $3, 0, NULL, 'issued', $4, $4, $5, $6)`,
      [
        ADAPTER_EVENT_ID,
        invoice!.id,
        ADAPTER_VERSION_ID,
        "2042-03-04T11:00:00.000Z",
        lifecycleEnvelope({
          id: ADAPTER_EVENT_ID,
          invoiceId: invoice!.id,
          versionId: ADAPTER_VERSION_ID,
        }),
        HASH_B,
      ],
    );

    await db.transaction(async (tx) => {
      const adapter = createAccountingPersistenceDbAdapter(tx);
      const expected = await adapter.lockAggregateForUpdate({
        kind: "outgoing-invoice",
        id: String(invoice!.id),
      });
      expect(expected?.revision).toBe("0");
      const next = {
        ...expected!,
        revision: "1",
        versionHead: {
          version: "1",
          versionId: ADAPTER_VERSION_ID,
          versionSha256: HASH_C,
        },
        lifecycleHead: {
          sequence: "0",
          eventId: ADAPTER_EVENT_ID,
          eventSha256: HASH_B,
        },
      };
      await expect(
        adapter.compareAndAdvanceAggregateState({ expected: expected!, next }),
      ).resolves.toBe(true);
      await expect(
        adapter.compareAndAdvanceAggregateState({ expected: expected!, next }),
      ).resolves.toBe(false);
      await expect(adapter.loadVersionById(ADAPTER_VERSION_ID)).rejects.toThrow(
        /document version/i,
      );
    });
  });

  it("rejects evidence tamper, root deletion, and cross-root event binding", async () => {
    const [version] = await db
      .select()
      .from(accountingDocumentVersionsTable)
      .where(eq(accountingDocumentVersionsTable.id, VERSION_ID));
    expect(version).toBeDefined();

    await expect(
      db
        .update(accountingDocumentVersionsTable)
        .set({ canonicalJson: '{"tampered":true}' })
        .where(eq(accountingDocumentVersionsTable.id, VERSION_ID)),
    ).rejects.toBeDefined();
    const [unchangedVersion] = await db
      .select({ canonicalJson: accountingDocumentVersionsTable.canonicalJson })
      .from(accountingDocumentVersionsTable)
      .where(eq(accountingDocumentVersionsTable.id, VERSION_ID));
    expect(unchangedVersion?.canonicalJson).toBe(version!.canonicalJson);
    await expect(
      db.delete(invoicesTable).where(eq(invoicesTable.id, version!.invoiceId!)),
    ).rejects.toThrow();

    const [otherInvoice] = await db
      .insert(invoicesTable)
      .values({ status: "draft" })
      .returning({ id: invoicesTable.id });
    await expect(
      db.insert(accountingDocumentVersionsTable).values({
        id: "99999999-9999-4999-8999-999999999999",
        invoiceId: otherInvoice!.id,
        version: 1n,
        purpose: "issued",
        historicalCompleteness: "complete",
        recordedAt: new Date("2042-03-04T12:00:00.000Z"),
        canonicalJson: versionEnvelope({
          id: "99999999-9999-4999-8999-999999999999",
          invoiceId: version!.invoiceId!,
        }),
        snapshotSha256: HASH_A,
        artifactSetSha256: HASH_B,
        versionSha256: HASH_C,
      }),
    ).rejects.toBeDefined();
    await expect(
      pool.query(
        `INSERT INTO accounting_lifecycle_events
         (id, invoice_id, document_version_id, sequence, previous_event_sha256,
          event_type, effective_at, recorded_at, canonical_json, entry_sha256)
         VALUES ('44444444-4444-4444-8444-444444444444', $1, $2, 0, NULL,
                  'issued', now(), now(), $3, $4)`,
        [
          otherInvoice!.id,
          VERSION_ID,
          lifecycleEnvelope({
            id: "44444444-4444-4444-8444-444444444444",
            invoiceId: otherInvoice!.id,
            versionId: VERSION_ID,
            entrySha256: HASH_A,
          }),
          HASH_A,
        ],
      ),
    ).rejects.toThrow(/root does not match/i);
  });

  it("keeps export intent bytes immutable while allowing a valid lease transition", async () => {
    const [insertedIntent] = await db
      .insert(accountingExportOutboxTable)
      .values({
        intentId: INTENT_ID,
        operation: "initial-version",
        canonicalJson: exportIntentEnvelope(),
        intentSha256: HASH_A,
      })
      .returning({ updatedAt: accountingExportOutboxTable.updatedAt });
    const leaseToken = "55555555-5555-4555-8555-555555555555";
    const leaseUpdatedAt = new Date(insertedIntent!.updatedAt.getTime() + 1);
    await expect(
      db
        .update(accountingExportOutboxTable)
        .set({
          state: "exporting",
          attemptCount: 1,
          leaseToken,
          leaseExpiresAt: new Date(leaseUpdatedAt.getTime() + 60_000),
          updatedAt: leaseUpdatedAt,
        })
        .where(eq(accountingExportOutboxTable.intentId, INTENT_ID)),
    ).resolves.toBeDefined();
    await expect(
      db
        .update(accountingExportOutboxTable)
        .set({ canonicalJson: '{"tampered":true}' })
        .where(eq(accountingExportOutboxTable.intentId, INTENT_ID)),
    ).rejects.toBeDefined();
    const [unchangedIntent] = await db
      .select({ canonicalJson: accountingExportOutboxTable.canonicalJson })
      .from(accountingExportOutboxTable)
      .where(eq(accountingExportOutboxTable.intentId, INTENT_ID));
    expect(unchangedIntent?.canonicalJson).toBe(exportIntentEnvelope());
    await expect(
      db
        .delete(accountingExportOutboxTable)
        .where(eq(accountingExportOutboxTable.intentId, INTENT_ID)),
    ).rejects.toBeDefined();
    await db
      .update(accountingExportOutboxTable)
      .set({
        state: "dead_letter",
        leaseToken: null,
        leaseExpiresAt: null,
        deadLetteredAt: new Date(leaseUpdatedAt.getTime() + 1),
        lastFailureCategory: "test_cleanup",
        updatedAt: new Date(leaseUpdatedAt.getTime() + 1),
      })
      .where(eq(accountingExportOutboxTable.intentId, INTENT_ID));
  });

  it("claims expired leases and CAS-persists the exact immutable archive receipt", async () => {
    const firstNow = new Date("2042-03-04T12:00:00.000Z");
    await db.insert(accountingExportOutboxTable).values({
      intentId: STORE_INTENT_ID,
      operation: "initial-version",
      availableAt: firstNow,
      canonicalJson: exportIntentEnvelope(STORE_INTENT_ID, HASH_B),
      intentSha256: HASH_B,
    });
    const first = await accountingArchiveDbRepository.claimNext({
      now: firstNow,
      leaseExpiresAt: new Date("2042-03-04T12:05:00.000Z"),
    });
    expect(first).toMatchObject({
      intentId: STORE_INTENT_ID,
      attemptCount: 1,
    });
    await expect(
      accountingArchiveDbRepository.loadEntry({
        kind: "lifecycle-event",
        id: EVENT_ID,
      }),
    ).resolves.toMatchObject({
      kind: "lifecycle-event",
      id: EVENT_ID,
    });
    await expect(
      accountingArchiveDbRepository.markFailed({
        claim: first!,
        failure: {
          category: "storage_timeout",
          retryable: true,
          occurredAt: firstNow,
        },
      }),
    ).resolves.toBe("pending");
    await expect(
      accountingArchiveDbRepository.claimNext({
        now: new Date("2042-03-04T12:00:04.999Z"),
        leaseExpiresAt: new Date("2042-03-04T12:05:04.999Z"),
      }),
    ).resolves.toBeNull();
    const secondNow = new Date("2042-03-04T12:00:05.000Z");
    const second = await accountingArchiveDbRepository.claimNext({
      now: secondNow,
      leaseExpiresAt: new Date("2042-03-04T12:05:05.000Z"),
    });
    expect(second).toMatchObject({
      intentId: STORE_INTENT_ID,
      attemptCount: 2,
    });
    await expect(
      accountingArchiveDbRepository.markExported({
        claim: first!,
        receipt: {
          manifestObjectKey: `accounting-evidence/v1/${STORE_INTENT_ID}/${HASH_B}/manifest.json`,
          manifestVersionId: "stale-version",
          manifestSha256: HASH_A,
          bundleSha256: HASH_B,
          checksumSha256: HASH_C,
        },
        exportedAt: secondNow,
      }),
    ).resolves.toBe(false);
    await expect(
      accountingArchiveDbRepository.markExported({
        claim: second!,
        receipt: {
          manifestObjectKey: `accounting-evidence/v1/${STORE_INTENT_ID}/${HASH_B}/manifest.json`,
          manifestVersionId: "manifest-version-2",
          manifestSha256: HASH_A,
          bundleSha256: HASH_B,
          checksumSha256: HASH_C,
        },
        exportedAt: secondNow,
      }),
    ).resolves.toBe(true);
    const [stored] = await db
      .select()
      .from(accountingExportOutboxTable)
      .where(eq(accountingExportOutboxTable.intentId, STORE_INTENT_ID));
    expect(stored).toMatchObject({
      state: "exported",
      attemptCount: 2,
      manifestVersionId: "manifest-version-2",
      manifestSha256: HASH_A,
      bundleSha256: HASH_B,
      checksumSha256: HASH_C,
    });
    await expect(
      pool.query(
        `UPDATE accounting_export_outbox
         SET manifest_version_id = 'rewritten-version'
         WHERE intent_id = $1`,
        [STORE_INTENT_ID],
      ),
    ).rejects.toThrow(/terminal accounting export/i);
  });

  it("refuses failure completion at lease expiry and allows only the reclaimer", async () => {
    const claimedAt = new Date("2042-03-04T13:00:00.000Z");
    const expiresAt = new Date("2042-03-04T13:01:00.000Z");
    await db.insert(accountingExportOutboxTable).values({
      intentId: EXPIRED_INTENT_ID,
      operation: "initial-version",
      availableAt: claimedAt,
      canonicalJson: exportIntentEnvelope(EXPIRED_INTENT_ID, HASH_C),
      intentSha256: HASH_C,
    });
    const expired = await accountingArchiveDbRepository.claimNext({
      now: claimedAt,
      leaseExpiresAt: expiresAt,
    });
    expect(expired?.intentId).toBe(EXPIRED_INTENT_ID);
    await expect(
      accountingArchiveDbRepository.markFailed({
        claim: expired!,
        failure: {
          category: "storage_timeout",
          retryable: true,
          occurredAt: expiresAt,
        },
      }),
    ).resolves.toBe("lost_lease");
    const reclaimed = await accountingArchiveDbRepository.claimNext({
      now: expiresAt,
      leaseExpiresAt: new Date("2042-03-04T13:06:00.000Z"),
    });
    expect(reclaimed).toMatchObject({
      intentId: EXPIRED_INTENT_ID,
      attemptCount: 2,
    });
    await expect(
      accountingArchiveDbRepository.markFailed({
        claim: reclaimed!,
        failure: {
          category: "invalid_evidence",
          retryable: false,
          occurredAt: expiresAt,
        },
      }),
    ).resolves.toBe("dead_letter");
  });

  it("creates the incoming-document root path without permitting payment heads", async () => {
    const [document] = await db
      .insert(billingDocumentsTable)
      .values({ status: "uploaded" })
      .returning({ id: billingDocumentsTable.id });
    await db
      .insert(accountingAggregateHeadsTable)
      .values({ billingDocumentId: document!.id });
    await expect(
      pool.query(
        `UPDATE accounting_aggregate_heads
         SET revision = 1,
             payment_head_sequence = 0,
             payment_head_id = '66666666-6666-4666-8666-666666666666',
             payment_head_sha256 = $1
         WHERE billing_document_id = $2`,
        [HASH_A, document!.id],
      ),
    ).rejects.toThrow();
  });
});
