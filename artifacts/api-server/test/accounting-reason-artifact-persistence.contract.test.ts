import { describe, expect, it } from "vitest";
import { createAccountingLifecycleEvent } from "../src/lib/accounting-lifecycle-event-contract";
import {
  appendAccountingReasonArtifactInTransaction,
  type AccountingReasonArtifactPersistenceTransactionV1,
} from "../src/lib/accounting-reason-artifact-persistence";
import {
  canonicalAccountingReasonArtifactJson,
  createAccountingReasonArtifact,
  type AccountingReasonArtifactV1,
} from "../src/lib/accounting-reason-artifact-contract";
import {
  canonicalAccountingExportIntentJson,
  type AccountingExportIntentV1,
} from "../src/lib/accounting-persistence-contract";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";

const REASON = "Doklad patří k jiné zakázce";
const DOMAIN = "site-logbook.cost-document-review-reopen-reason/v1" as const;

function fixture() {
  const reasonDetailSha256 = sha256Hex(
    `${DOMAIN}\0${canonicalEvidenceJson({ reason: REASON })}`,
  );
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: "11111111-1111-4111-8111-111111111111",
    aggregate: {
      kind: "incoming-cost-document",
      id: "88",
      versionId: "22222222-2222-4222-8222-222222222222",
    },
    sequence: "1",
    previousEventSha256: "a".repeat(64),
    eventType: "review_reopened",
    actor: { kind: "user", id: "7", authentication: "session" },
    reasonCode: "review_reopened",
    reasonDetailSha256,
    effectiveAt: "2042-12-01T10:00:00.000Z",
    recordedAt: "2042-12-01T10:00:00.000Z",
    evidenceSha256: "b".repeat(64),
  });
  const artifact = createAccountingReasonArtifact({
    artifactId: "33333333-3333-4333-8333-333333333333",
    lifecycleEvent: event,
    reasonText: REASON,
    digestDomain: DOMAIN,
  });
  return { event, artifact };
}

class FakeReasonTransaction implements AccountingReasonArtifactPersistenceTransactionV1 {
  artifact: AccountingReasonArtifactV1 | null = null;
  intent: AccountingExportIntentV1 | null = null;
  operations: string[] = [];

  async loadReasonArtifactById() {
    return this.artifact;
  }

  async insertReasonArtifact(artifact: AccountingReasonArtifactV1) {
    this.operations.push("insert-reason-artifact");
    this.artifact = structuredClone(artifact);
  }

  async loadExportIntentById() {
    return this.intent;
  }

  async insertExportIntent(intent: AccountingExportIntentV1) {
    this.operations.push("insert-restricted-intent");
    this.intent = structuredClone(intent);
  }
}

describe("restricted accounting reason persistence", () => {
  it("appends artifact before its dedicated restricted export intent", async () => {
    const source = fixture();
    const tx = new FakeReasonTransaction();
    const result = await appendAccountingReasonArtifactInTransaction(
      tx,
      source.artifact,
      source.event,
    );
    expect(result.replay).toBe(false);
    expect(tx.operations).toEqual([
      "insert-reason-artifact",
      "insert-restricted-intent",
    ]);
    expect(result.intent).toMatchObject({
      intentId: source.artifact.artifactId,
      operation: "reason-artifact",
      destination: { namespace: "accounting-evidence-restricted/v1" },
      entries: [
        {
          kind: "reason-artifact",
          id: source.artifact.artifactId,
          sha256: source.artifact.integrity.artifactSha256,
        },
      ],
    });
  });

  it("accepts only an exact complete replay and rejects split persistence", async () => {
    const source = fixture();
    const tx = new FakeReasonTransaction();
    const first = await appendAccountingReasonArtifactInTransaction(
      tx,
      source.artifact,
      source.event,
    );
    tx.operations.length = 0;
    const replay = await appendAccountingReasonArtifactInTransaction(
      tx,
      source.artifact,
      source.event,
    );
    expect(replay.replay).toBe(true);
    expect(tx.operations).toEqual([]);
    expect(canonicalAccountingReasonArtifactJson(replay.artifact)).toBe(
      canonicalAccountingReasonArtifactJson(first.artifact),
    );
    expect(canonicalAccountingExportIntentJson(replay.intent)).toBe(
      canonicalAccountingExportIntentJson(first.intent),
    );

    tx.intent = null;
    await expect(
      appendAccountingReasonArtifactInTransaction(
        tx,
        source.artifact,
        source.event,
      ),
    ).rejects.toThrow(/missing.*export intent/i);

    tx.artifact = null;
    tx.intent = first.intent;
    await expect(
      appendAccountingReasonArtifactInTransaction(
        tx,
        source.artifact,
        source.event,
      ),
    ).rejects.toThrow(/without its reason artifact/i);
  });
});
