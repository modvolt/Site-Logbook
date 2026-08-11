import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_POLICY_V1,
  auditProjectionSha256,
  canonicalAuditEventJson,
  createAuditEventEnvelope,
  verifyAuditEventEnvelope,
  verifyCanonicalAuditEventJsonBytes,
  type AuditEventInputV1,
} from "../src/lib/audit-event-envelope";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const BUILD_SHA = "1".repeat(40);

function present(projection: string, value: unknown) {
  return {
    availability: "present" as const,
    completeness: "complete" as const,
    projection,
    data: value,
    sha256: auditProjectionSha256(projection, value),
    missingFields: [],
    reason: null,
  };
}

function absent(reason: "not-created" | "deleted") {
  return {
    availability: "absent" as const,
    completeness: "not-applicable" as const,
    projection: null,
    data: null,
    sha256: null,
    missingFields: [],
    reason,
  };
}

function notCaptured(reason: "operation-not-applied" | "not-applicable") {
  return {
    availability: "not-captured" as const,
    completeness: "not-applicable" as const,
    projection: null,
    data: null,
    sha256: null,
    missingFields: [],
    reason,
  };
}

function criticalPresent(opts: {
  entityType: string;
  aggregateVersion: string;
  lifecycleState: string;
  contentSha256: string;
}) {
  return present("critical-aggregate.audit/v1", {
    entityType: opts.entityType,
    entityId: "9",
    aggregateVersion: opts.aggregateVersion,
    lifecycleState: opts.lifecycleState,
    contentSha256: opts.contentSha256,
    relationSetSha256: null,
  });
}

function baseInput(): AuditEventInputV1 {
  return {
    eventId: "018f6f8e-7c20-7a4b-8c4d-1234567890ab",
    occurredAt: "2026-08-11T10:11:12.345Z",
    actor: {
      kind: "user",
      id: "user:42",
      authentication: "session",
      delegatedById: null,
    },
    source: {
      kind: "api",
      component: "api-server",
      operation: "job.note.update",
      buildRevision: BUILD_SHA,
      requestIdSha256: SHA_A,
    },
    action: {
      code: "job.note.update",
      outcome: "succeeded",
    },
    entity: { type: "job", id: "123", version: "7" },
    reason: { code: null, detailArtifactRef: null, detailSha256: null },
    state: {
      before: present("job.audit/v1", { id: 123, notePresent: false }),
      after: present("job.audit/v1", { id: 123, notePresent: true }),
    },
    correlation: {
      correlationIdSha256: SHA_A,
      causationEventSha256: null,
      idempotencyKeySha256: SHA_B,
    },
    artifactRefs: [],
  };
}

function criticalInput(
  action:
    | "external-account.grant"
    | "invoice.payment.correct"
    | "privacy.erase.execute"
    | "vault.credential.reveal",
): AuditEventInputV1 {
  const input = baseInput();
  const detail = {
    role: "reason-detail" as const,
    ref: "reason:7",
    sha256: SHA_B,
    byteLength: 128,
    mediaType: "application/json",
  };
  input.action.code = action;
  input.source.operation = action;
  const entityType =
    action === "external-account.grant"
      ? "external-account"
      : action === "invoice.payment.correct"
        ? "invoice"
        : action === "privacy.erase.execute"
          ? "privacy-request"
          : "device-credential";
  input.entity = { type: entityType, id: "9", version: "7" };
  if (
    action === "external-account.grant" ||
    action === "invoice.payment.correct" ||
    action === "privacy.erase.execute" ||
    action === "vault.credential.reveal"
  ) {
    input.actor.authentication = "step-up";
  }
  input.reason = {
    code:
      action === "external-account.grant"
        ? "external-access-approved"
        : action === "invoice.payment.correct"
          ? "payment-correction-approved"
          : action === "privacy.erase.execute"
            ? "data-subject-request"
            : "credential-access-approved",
    detailArtifactRef:
      action === "invoice.payment.correct" || action === "privacy.erase.execute"
        ? detail.ref
        : null,
    detailSha256:
      action === "invoice.payment.correct" || action === "privacy.erase.execute"
        ? detail.sha256
        : null,
  };
  input.artifactRefs = [
    {
      role: "approval",
      ref: "approval:7",
      sha256: SHA_A,
      byteLength: 64,
      mediaType: "application/json",
    },
    ...(input.reason.detailArtifactRef ? [detail] : []),
  ];
  if (action === "external-account.grant") {
    input.state = {
      before: absent("not-created"),
      after: criticalPresent({
        entityType,
        aggregateVersion: "7",
        lifecycleState: "active",
        contentSha256: SHA_D,
      }),
    };
    input.artifactRefs.push({
      role: "after-snapshot",
      ref: "snapshot:2",
      sha256: SHA_D,
      byteLength: 256,
      mediaType: "application/json",
    });
  } else if (action === "privacy.erase.execute") {
    input.state = {
      before: criticalPresent({
        entityType,
        aggregateVersion: "7",
        lifecycleState: "approved",
        contentSha256: SHA_C,
      }),
      after: absent("deleted"),
    };
    input.artifactRefs.push({
      role: "before-snapshot",
      ref: "snapshot:1",
      sha256: SHA_C,
      byteLength: 256,
      mediaType: "application/json",
    });
  } else if (action === "vault.credential.reveal") {
    input.state = {
      before: notCaptured("not-applicable"),
      after: notCaptured("not-applicable"),
    };
    input.correlation.idempotencyKeySha256 = null;
  } else {
    input.state = {
      before: criticalPresent({
        entityType,
        aggregateVersion: "6",
        lifecycleState: "paid",
        contentSha256: SHA_C,
      }),
      after: criticalPresent({
        entityType,
        aggregateVersion: "7",
        lifecycleState: "payment-corrected",
        contentSha256: SHA_D,
      }),
    };
    input.artifactRefs.push(
      {
        role: "before-snapshot",
        ref: "snapshot:1",
        sha256: SHA_C,
        byteLength: 256,
        mediaType: "application/json",
      },
      {
        role: "after-snapshot",
        ref: "snapshot:2",
        sha256: SHA_D,
        byteLength: 256,
        mediaType: "application/json",
      },
    );
  }
  return input;
}

describe("audit event envelope v1", () => {
  it("creates and verifies a deterministic standard event", () => {
    const first = createAuditEventEnvelope(baseInput());
    const reordered = createAuditEventEnvelope({
      ...baseInput(),
      state: {
        before: present("job.audit/v1", { notePresent: false, id: 123 }),
        after: present("job.audit/v1", { notePresent: true, id: 123 }),
      },
    });
    expect(first.integrity.eventSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.integrity.eventSha256).toBe(
      "122c9126ba3f40ec5f6a90096d2c3cb2091890838b7af47784a5aefd04dd918d",
    );
    expect(reordered.integrity.eventSha256).toBe(first.integrity.eventSha256);
    expect(verifyAuditEventEnvelope(first)).toEqual(first);
  });

  it.each([
    ["create", "external-account.grant" as const],
    ["update with reason detail", "invoice.payment.correct" as const],
    ["delete with reason detail", "privacy.erase.execute" as const],
    ["access without state payload", "vault.credential.reveal" as const],
  ])("accepts a critical %s envelope", (_label, action) => {
    const envelope = createAuditEventEnvelope(criticalInput(action));
    expect(envelope.action.critical).toBe(true);
    expect(verifyAuditEventEnvelope(envelope)).toEqual(envelope);
  });

  it("accepts a failed critical mutation only as operation-not-applied", () => {
    const input = criticalInput("external-account.grant");
    input.action.outcome = "failed";
    input.reason.code = "execution-failed";
    input.state = {
      before: notCaptured("operation-not-applied"),
      after: notCaptured("operation-not-applied"),
    };
    expect(createAuditEventEnvelope(input).action.outcome).toBe("failed");
  });

  it("sorts artifact refs canonically and binds the reason detail digest", () => {
    const input = criticalInput("invoice.payment.correct");
    input.artifactRefs.reverse();
    const envelope = createAuditEventEnvelope(input);
    expect(envelope.artifactRefs.map((artifact) => artifact.role)).toEqual([
      "after-snapshot",
      "approval",
      "before-snapshot",
      "reason-detail",
    ]);
    expect(envelope.reason.detailSha256).toBe(
      envelope.artifactRefs.find(
        (artifact) => artifact.role === "reason-detail",
      )?.sha256,
    );
  });

  it("changes the event digest when an authoritative field changes", () => {
    const original = createAuditEventEnvelope(baseInput());
    const changedInput = baseInput();
    changedInput.entity.version = "8";
    const changed = createAuditEventEnvelope(changedInput);
    expect(changed.integrity.eventSha256).not.toBe(
      original.integrity.eventSha256,
    );
  });

  it("uses projection domain separation", () => {
    expect(
      auditProjectionSha256("job-summary.audit/v1", {
        id: 1,
        notePresent: true,
      }),
    ).not.toBe(
      auditProjectionSha256("job.audit/v1", { id: 1, notePresent: true }),
    );
  });

  it("verifies exact canonical JSON bytes and freezes the verified envelope", () => {
    const envelope = createAuditEventEnvelope(baseInput());
    const canonical = canonicalAuditEventJson(envelope);
    expect(verifyCanonicalAuditEventJsonBytes(Buffer.from(canonical))).toEqual(
      envelope,
    );
    expect(() => verifyCanonicalAuditEventJsonBytes(`${canonical}\n`)).toThrow(
      /canonical/i,
    );
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.state.before)).toBe(true);
  });

  it("rejects unknown keys, unregistered actions and caller-controlled policy metadata", () => {
    expect(() =>
      createAuditEventEnvelope({
        ...baseInput(),
        payload: {},
      } as AuditEventInputV1),
    ).toThrow();
    const unknown = baseInput();
    unknown.action.code = "unknown.action";
    expect(() => createAuditEventEnvelope(unknown)).toThrow(/not registered/i);

    const envelope = createAuditEventEnvelope(baseInput());
    expect(() =>
      verifyAuditEventEnvelope({
        ...envelope,
        action: { ...envelope.action, critical: true },
      }),
    ).toThrow(/policy/i);
  });

  it("rejects a noncanonical timestamp and an anonymous successful critical actor", () => {
    const invalidTime = baseInput();
    invalidTime.occurredAt = "2026-08-11T12:11:12.345+02:00";
    expect(() => createAuditEventEnvelope(invalidTime)).toThrow();

    const anonymous = criticalInput("external-account.grant");
    anonymous.actor = {
      kind: "anonymous",
      id: "anonymous:unknown",
      authentication: "none",
      delegatedById: null,
    };
    expect(() => createAuditEventEnvelope(anonymous)).toThrow(
      /provenance|anonymous/i,
    );
  });

  it("rejects missing critical evidence, idempotency and exact build revision", () => {
    const noEvidence = criticalInput("external-account.grant");
    noEvidence.artifactRefs = noEvidence.artifactRefs.filter(
      (artifact) => artifact.role !== "after-snapshot",
    );
    expect(() => createAuditEventEnvelope(noEvidence)).toThrow(/artifact/i);

    const noIdempotency = criticalInput("external-account.grant");
    noIdempotency.correlation.idempotencyKeySha256 = null;
    expect(() => createAuditEventEnvelope(noIdempotency)).toThrow(
      /idempotency/i,
    );

    const unknownBuild = criticalInput("external-account.grant");
    unknownBuild.source.buildRevision = "unknown";
    expect(() => createAuditEventEnvelope(unknownBuild)).toThrow(
      /build revision/i,
    );
  });

  it("rejects malformed reason binding, raw references and secret patterns", () => {
    const missingDetail = criticalInput("invoice.payment.correct");
    missingDetail.artifactRefs = missingDetail.artifactRefs.filter(
      (artifact) => artifact.role !== "reason-detail",
    );
    expect(() => createAuditEventEnvelope(missingDetail)).toThrow(
      /reason detail/i,
    );

    const rawReference = baseInput();
    rawReference.actor.id = "https://example.test/user/42";
    expect(() => createAuditEventEnvelope(rawReference)).toThrow();

    const envelope = createAuditEventEnvelope(baseInput());
    expect(() =>
      verifyAuditEventEnvelope({
        ...envelope,
        entity: { ...envelope.entity, id: "ghp_abcdefghijklmnopqrstuvwxyz" },
      }),
    ).toThrow();
  });

  it("rejects spoofed actor provenance, incomplete projections and wrong artifact roles", () => {
    const spoofed = criticalInput("external-account.grant");
    spoofed.actor = {
      kind: "user",
      id: "system:worker",
      authentication: "session",
      delegatedById: null,
    } as AuditEventInputV1["actor"];
    expect(() => createAuditEventEnvelope(spoofed)).toThrow();

    expect(() =>
      auditProjectionSha256("critical-aggregate.audit/v1", {}),
    ).toThrow();
    expect(() => auditProjectionSha256("unknown.audit/v1", {})).toThrow(
      /not registered/i,
    );

    const unrelated = criticalInput("vault.credential.reveal");
    unrelated.artifactRefs = [
      {
        role: "recovery-evidence",
        ref: "recovery:7",
        sha256: SHA_A,
        byteLength: 1,
        mediaType: "application/json",
      },
    ];
    expect(() => createAuditEventEnvelope(unrelated)).toThrow(/approval/i);
  });

  it("binds every critical action to an exact entity, operation and actor/source policy", () => {
    const wrongEntity = criticalInput("external-account.grant");
    wrongEntity.entity.type = "invoice";
    expect(() => createAuditEventEnvelope(wrongEntity)).toThrow(
      /entity type.*policy/i,
    );

    const wrongOperation = criticalInput("external-account.grant");
    wrongOperation.source.operation = "key.rotate";
    expect(() => createAuditEventEnvelope(wrongOperation)).toThrow(
      /source operation.*policy/i,
    );

    const externalAdministrator = criticalInput("external-account.grant");
    externalAdministrator.actor = {
      kind: "external",
      id: `external:${SHA_A}`,
      authentication: "public-token",
      delegatedById: null,
    };
    expect(() => createAuditEventEnvelope(externalAdministrator)).toThrow(
      /not allowed by the action policy/i,
    );

    const unregisteredComponent = criticalInput("external-account.grant");
    unregisteredComponent.source.component = "billing-api";
    expect(() => createAuditEventEnvelope(unregisteredComponent)).toThrow(
      /source component.*registered/i,
    );
  });

  it("keeps the action registry closed and domain-evidentiary", () => {
    for (const [action, policy] of Object.entries(AUDIT_ACTION_POLICY_V1)) {
      expect(action).toMatch(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
      expect(policy.entityType).toMatch(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
      expect(policy.allowedProvenance.length).toBeGreaterThan(0);
      expect(new Set(policy.allowedProvenance).size).toBe(
        policy.allowedProvenance.length,
      );
      expect(new Set(policy.reasonCodes).size).toBe(policy.reasonCodes.length);
      if (policy.critical) {
        expect(policy.reasonCodes.length).toBeGreaterThan(0);
        expect(policy.requiredArtifactRoles?.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses action and lifecycle allowlists instead of treating token regexes as the boundary", () => {
    const syntheticStripeLikeToken = [
      "sk",
      "live",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("_");

    for (const token of [
      syntheticStripeLikeToken,
      "xoxb_abcdefghijklmnopqrstuvwxyz",
    ]) {
      const input = criticalInput("external-account.grant");
      input.reason.code = token;
      expect(() => createAuditEventEnvelope(input)).toThrow(
        /reason code.*registered/i,
      );
    }

    expect(() =>
      auditProjectionSha256("critical-aggregate.audit/v1", {
        entityType: "external-account",
        entityId: "9",
        aggregateVersion: "7",
        lifecycleState: syntheticStripeLikeToken,
        contentSha256: SHA_A,
        relationSetSha256: null,
      }),
    ).toThrow(/lifecycle state.*registered/i);
  });

  it("requires critical provenance even for failed or denied outcomes", () => {
    const failed = criticalInput("external-account.grant");
    failed.action.outcome = "failed";
    failed.state = {
      before: notCaptured("operation-not-applied"),
      after: notCaptured("operation-not-applied"),
    };
    failed.reason.code = null;
    expect(() => createAuditEventEnvelope(failed)).toThrow(/reason code/i);
  });

  it("does not flag ordinary sk-prefixed words but rejects a token-shaped projection value", () => {
    const ordinary = baseInput();
    ordinary.artifactRefs = [
      {
        role: "generated-output",
        ref: "artifact:9",
        sha256: SHA_A,
        byteLength: 1,
        mediaType: "application/task-runner",
      },
    ];
    expect(createAuditEventEnvelope(ordinary).artifactRefs[0]?.mediaType).toBe(
      "application/task-runner",
    );

    expect(() =>
      auditProjectionSha256("critical-aggregate.audit/v1", {
        entityType: "job",
        entityId: "9",
        aggregateVersion: "7",
        lifecycleState: "sk-abcdefghijklmnopqrstuvwxyz",
        contentSha256: SHA_A,
        relationSetSha256: null,
      }),
    ).toThrow(/registered|secret/i);
  });

  it("rejects a one-byte mutation even when the stored digest is unchanged", () => {
    const envelope = createAuditEventEnvelope(baseInput());
    expect(() =>
      verifyAuditEventEnvelope({
        ...envelope,
        entity: { ...envelope.entity, version: "9" },
      }),
    ).toThrow(/digest/i);
  });

  it("rejects denied events that claim a changed after-state", () => {
    const input = criticalInput("external-account.grant");
    input.action.outcome = "denied";
    input.reason.code = "authorization-denied";
    expect(() => createAuditEventEnvelope(input)).toThrow(/cannot claim/i);
  });
});
