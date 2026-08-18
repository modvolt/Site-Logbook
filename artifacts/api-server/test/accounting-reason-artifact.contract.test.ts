import { describe, expect, it } from "vitest";
import { createAccountingLifecycleEvent } from "../src/lib/accounting-lifecycle-event-contract";
import {
  canonicalAccountingReasonArtifactJson,
  createAccountingReasonArtifact,
  verifyAccountingReasonArtifact,
  verifyAccountingReasonArtifactBinding,
  verifyCanonicalAccountingReasonArtifactJsonBytes,
} from "../src/lib/accounting-reason-artifact-contract";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";

function reopen() {
  const reasonText = "Chybně přiřazená zakázka";
  const reasonDetailSha256 = sha256Hex(
    `site-logbook.cost-document-review-reopen-reason/v1\0${canonicalEvidenceJson({ reason: reasonText })}`,
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
  const reasonArtifact = createAccountingReasonArtifact({
    artifactId: "33333333-3333-4333-8333-333333333333",
    lifecycleEvent: event,
    reasonText: `  ${reasonText}  `,
    digestDomain: "site-logbook.cost-document-review-reopen-reason/v1",
  });
  return { event, reasonArtifact };
}

describe("restricted accounting reason artifact", () => {
  it("binds normalized readable text to the lifecycle digest and restricted policy", () => {
    const evidence = reopen();
    expect(evidence.reasonArtifact).toMatchObject({
      aggregate: evidence.event.aggregate,
      lifecycleEvent: {
        eventId: evidence.event.eventId,
        eventSha256: evidence.event.integrity.entrySha256,
      },
      reason: {
        code: "review_reopened",
        text: "Chybně přiřazená zakázka",
        textSha256: evidence.event.reasonDetailSha256,
        digestDomain: "site-logbook.cost-document-review-reopen-reason/v1",
      },
      retention: {
        class: "restricted-accounting-evidence",
        legalHoldAware: true,
        selectivePlaintextRewriteSupported: false,
      },
      accessPolicy: {
        mode: "restricted",
        listing: "metadata-only",
        plaintextExport: "authorized-audit-only",
      },
    });
    expect(
      verifyAccountingReasonArtifactBinding(
        evidence.reasonArtifact,
        evidence.event,
      ),
    ).toEqual(evidence.reasonArtifact);
    const canonical = canonicalAccountingReasonArtifactJson(
      evidence.reasonArtifact,
    );
    expect(verifyCanonicalAccountingReasonArtifactJsonBytes(canonical)).toEqual(
      evidence.reasonArtifact,
    );
  });

  it("rejects text, domain, secret and canonical-byte drift", () => {
    const evidence = reopen();
    expect(() =>
      createAccountingReasonArtifact({
        artifactId: evidence.reasonArtifact.artifactId,
        lifecycleEvent: evidence.event,
        reasonText: "Jiný důvod",
        digestDomain: "site-logbook.cost-document-review-reopen-reason/v1",
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      createAccountingReasonArtifact({
        artifactId: evidence.reasonArtifact.artifactId,
        lifecycleEvent: evidence.event,
        reasonText: evidence.reasonArtifact.reason.text,
        digestDomain: "site-logbook.cost-document-reviewed-rejection-reason/v1",
      }),
    ).toThrow(/domain/i);
    expect(() =>
      createAccountingReasonArtifact({
        artifactId: evidence.reasonArtifact.artifactId,
        lifecycleEvent: evidence.event,
        reasonText: `ghp_${"A".repeat(32)}`,
        digestDomain: "site-logbook.cost-document-review-reopen-reason/v1",
      }),
    ).toThrow(/secret/i);
    const changed = structuredClone(evidence.reasonArtifact);
    changed.accessPolicy.listing = "metadata-only";
    changed.reason.text = "Změněný důvod";
    expect(() => verifyAccountingReasonArtifact(changed)).toThrow(/digest/i);
    expect(() =>
      verifyCanonicalAccountingReasonArtifactJsonBytes(
        `${canonicalAccountingReasonArtifactJson(evidence.reasonArtifact)}\n`,
      ),
    ).toThrow(/canonical JSON/i);
  });
});
