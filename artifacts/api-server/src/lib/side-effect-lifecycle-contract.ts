import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const INTENT_SCHEMA = "site-logbook.side-effect-intent/v1" as const;
const PROJECTION_SCHEMA = "site-logbook.side-effect-projection/v1" as const;
const EVENT_SCHEMA = "site-logbook.side-effect-transition/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const INTENT_HASH_DOMAIN = "site-logbook.side-effect-intent/v1" as const;
const EVENT_HASH_DOMAIN = "site-logbook.side-effect-transition/v1" as const;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const timestampSchema = z.string().regex(UTC_MILLIS_PATTERN);
const counterSchema = z
  .string()
  .regex(DECIMAL_PATTERN)
  .refine((value) => BigInt(value) <= MAX_BIGINT, {
    message: "Counter exceeds PostgreSQL bigint capacity.",
  });

export const SIDE_EFFECT_INITIAL_STATES = {
  delivery: "pending",
  managedObject: { write: "planned", delete: "delete_pending" },
  inboxMessage: "discovered",
} as const;

const DELIVERY_STATES = [
  "pending",
  "delivering",
  "delivered",
  "unknown",
  "dead_letter",
  "cancelled",
] as const;
const OBJECT_STATES = [
  "planned",
  "writing",
  "stored_unbound",
  "bound",
  "delete_pending",
  "deleting",
  "deleted",
  "unknown",
  "repair_required",
  "cancelled",
] as const;
const INBOX_STATES = [
  "discovered",
  "reserved",
  "processing",
  "completed",
  "unknown",
  "dead_letter",
] as const;

export type SideEffectKind = "delivery" | "managed-object" | "inbox-message";
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type ManagedObjectState = (typeof OBJECT_STATES)[number];
export type InboxMessageState = (typeof INBOX_STATES)[number];
export type SideEffectState =
  | DeliveryState
  | ManagedObjectState
  | InboxMessageState;

const deliveryAttributesSchema = z
  .object({
    channel: z.literal("email"),
    purpose: z.enum([
      "quote",
      "invoice",
      "invoice_reminder",
      "job_sheet",
      "ppe_confirmation",
      "credential_delivery",
      "backup_alert",
      "ppe_overdue_alert",
      "health_alert",
    ]),
    messageIdSha256: sha256Schema,
    recipientSetSha256: sha256Schema,
  })
  .strict();

const managedObjectAttributesSchema = z
  .object({
    operation: z.enum(["write", "delete"]),
    objectLocationSha256: sha256Schema,
    contentSha256: sha256Schema.nullable(),
    contentSizeBytes: counterSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const write = value.operation === "write";
    const hasContent =
      value.contentSha256 !== null &&
      value.contentSizeBytes !== null &&
      value.contentSizeBytes !== "0";
    if (write !== hasContent) {
      context.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message:
          "Write intents require a non-empty content digest and size; delete intents must omit both.",
      });
    }
  });

const inboxAttributesSchema = z
  .object({
    provider: z.enum(["imap", "gmail"]),
    mailboxSha256: sha256Schema,
    providerMessageSha256: sha256Schema,
  })
  .strict();

const intentBaseSchema = z.object({
  schemaVersion: z.literal(INTENT_SCHEMA),
  operationId: uuidSchema,
  idempotencyKeySha256: sha256Schema,
  payloadProtection: z.literal("mve1"),
  payloadReferenceSha256: sha256Schema,
  createdAt: timestampSchema,
  initialState: z.string(),
  integrity: z
    .object({
      canonicalization: z.literal(CANONICALIZATION),
      hashAlgorithm: z.literal("sha256"),
      hashDomain: z.literal(INTENT_HASH_DOMAIN),
      intentSha256: sha256Schema,
    })
    .strict(),
});

const intentSchema = z.discriminatedUnion("kind", [
  intentBaseSchema
    .extend({
      kind: z.literal("delivery"),
      initialState: z.literal(SIDE_EFFECT_INITIAL_STATES.delivery),
      attributes: deliveryAttributesSchema,
    })
    .strict(),
  intentBaseSchema
    .extend({
      kind: z.literal("managed-object"),
      initialState: z.enum(["planned", "delete_pending"]),
      attributes: managedObjectAttributesSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.initialState !==
        SIDE_EFFECT_INITIAL_STATES.managedObject[value.attributes.operation]
      ) {
        context.addIssue({
          code: "custom",
          path: ["initialState"],
          message: "Managed-object initial state does not match its operation.",
        });
      }
    }),
  intentBaseSchema
    .extend({
      kind: z.literal("inbox-message"),
      initialState: z.literal(SIDE_EFFECT_INITIAL_STATES.inboxMessage),
      attributes: inboxAttributesSchema,
    })
    .strict(),
]);

const leaseSchema = z
  .object({
    tokenSha256: sha256Schema,
    expiresAt: timestampSchema,
  })
  .strict();

const projectionSchema = z
  .object({
    schemaVersion: z.literal(PROJECTION_SCHEMA),
    kind: z.enum(["delivery", "managed-object", "inbox-message"]),
    operationId: uuidSchema,
    managedObjectOperation: z.enum(["write", "delete"]).nullable(),
    state: z.string(),
    revision: counterSchema,
    attemptCount: counterSchema,
    lease: leaseSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const states = statesForKind(value.kind, value.managedObjectOperation);
    if (!states.has(value.state)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: `State is not valid for ${value.kind}.`,
      });
    }
    if (
      (value.kind === "managed-object") !==
      (value.managedObjectOperation !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["managedObjectOperation"],
        message: "Only a managed-object projection may carry its operation.",
      });
    }
    const needsLease = activeStates.has(value.state);
    if (needsLease !== (value.lease !== null)) {
      context.addIssue({
        code: "custom",
        path: ["lease"],
        message: "Only an actively executing projection may carry a lease.",
      });
    }
    if (
      value.revision === "0" &&
      (value.state !==
        initialStateForKind(value.kind, value.managedObjectOperation) ||
        value.attemptCount !== "0")
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Revision zero must be the untouched initial projection.",
      });
    }
    if (needsLease && value.attemptCount === "0") {
      context.addIssue({
        code: "custom",
        path: ["attemptCount"],
        message: "An active execution must have a positive attempt ordinal.",
      });
    }
  });

const transitionEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA),
    transitionId: uuidSchema,
    operationId: uuidSchema,
    kind: z.enum(["delivery", "managed-object", "inbox-message"]),
    managedObjectOperation: z.enum(["write", "delete"]).nullable(),
    fromState: z.string(),
    toState: z.string(),
    expectedRevision: counterSchema,
    nextRevision: counterSchema,
    attemptOrdinal: counterSchema,
    trigger: z.enum(["worker", "operator", "system"]),
    reasonCode: z.string().regex(REASON_PATTERN),
    outcomeEvidenceSha256: sha256Schema.nullable(),
    resolutionEvidenceSha256: sha256Schema.nullable(),
    recordedAt: timestampSchema,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(EVENT_HASH_DOMAIN),
        eventSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const states = statesForKind(value.kind, value.managedObjectOperation);
    if (!states.has(value.fromState) || !states.has(value.toState)) {
      context.addIssue({
        code: "custom",
        path: ["toState"],
        message: "Transition event contains a state from another lifecycle.",
      });
    }
    if (
      (value.kind === "managed-object") !==
      (value.managedObjectOperation !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["managedObjectOperation"],
        message: "Only a managed-object event may carry its operation.",
      });
    }
    const allowed = transitionTargets(
      value.kind,
      value.managedObjectOperation,
      value.fromState,
    );
    if (!allowed.includes(value.toState)) {
      context.addIssue({
        code: "custom",
        path: ["toState"],
        message: "Transition event contains a forbidden state edge.",
      });
    }
    if (BigInt(value.nextRevision) !== BigInt(value.expectedRevision) + 1n) {
      context.addIssue({
        code: "custom",
        path: ["nextRevision"],
        message: "Transition revision must advance by exactly one.",
      });
    }
    const needsResolution =
      value.fromState === "unknown" ||
      value.fromState === "dead_letter" ||
      value.fromState === "repair_required";
    if (
      needsResolution !==
      (value.trigger === "operator" && value.resolutionEvidenceSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolutionEvidenceSha256"],
        message:
          "Recovery events require an operator and evidence; ordinary events forbid it.",
      });
    }
    if (
      activeStates.has(value.toState) !==
      (value.outcomeEvidenceSha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomeEvidenceSha256"],
        message:
          "Starting work forbids outcome evidence; every completed state transition requires it.",
      });
    }
  });

export type SideEffectIntentV1 = z.infer<typeof intentSchema>;
export type SideEffectProjectionV1 = z.infer<typeof projectionSchema>;
export type SideEffectTransitionEventV1 = z.infer<typeof transitionEventSchema>;

type IntentInput<T> = T extends SideEffectIntentV1
  ? Omit<
      T,
      "schemaVersion" | "initialState" | "payloadProtection" | "integrity"
    >
  : never;

export type CreateSideEffectIntentInputV1 = IntentInput<SideEffectIntentV1>;

export type TransitionSideEffectInputV1 = {
  transitionId: string;
  toState: SideEffectState;
  trigger: "worker" | "operator" | "system";
  reasonCode: string;
  outcomeEvidenceSha256?: string | null;
  resolutionEvidenceSha256?: string | null;
  recordedAt: string;
  nextLease?: { tokenSha256: string; expiresAt: string } | null;
};

const activeStates = new Set([
  "delivering",
  "writing",
  "deleting",
  "processing",
]);
const terminalStates = new Set([
  "delivered",
  "deleted",
  "completed",
  "cancelled",
]);

const transitions = {
  delivery: {
    pending: ["delivering", "cancelled"],
    delivering: ["pending", "delivered", "unknown", "dead_letter"],
    unknown: ["pending", "delivered", "dead_letter"],
    dead_letter: ["pending"],
  },
  managedObjectWrite: {
    planned: ["writing", "cancelled"],
    writing: ["stored_unbound", "unknown", "repair_required"],
    stored_unbound: ["bound", "repair_required"],
    unknown: ["writing", "repair_required"],
    repair_required: ["writing"],
  },
  managedObjectDelete: {
    delete_pending: ["deleting"],
    deleting: ["deleted", "unknown", "repair_required"],
    unknown: ["deleting", "repair_required"],
    repair_required: ["deleting"],
  },
  inboxMessage: {
    discovered: ["reserved"],
    reserved: ["processing", "unknown"],
    processing: ["completed", "unknown", "dead_letter"],
    unknown: ["processing", "dead_letter"],
    dead_letter: ["processing"],
  },
} as const;

function initialStateForKind(
  kind: SideEffectKind,
  managedObjectOperation: "write" | "delete" | null,
): string {
  if (kind === "delivery") return SIDE_EFFECT_INITIAL_STATES.delivery;
  if (kind === "inbox-message") return SIDE_EFFECT_INITIAL_STATES.inboxMessage;
  return SIDE_EFFECT_INITIAL_STATES.managedObject[
    managedObjectOperation ?? "write"
  ];
}

function statesForKind(
  kind: SideEffectKind,
  managedObjectOperation: "write" | "delete" | null,
): Set<string> {
  if (kind === "delivery") return new Set(DELIVERY_STATES);
  if (kind === "managed-object") {
    const common = ["unknown", "repair_required", "cancelled"];
    return managedObjectOperation === "delete"
      ? new Set(["delete_pending", "deleting", "deleted", ...common])
      : new Set(["planned", "writing", "stored_unbound", "bound", ...common]);
  }
  return new Set(INBOX_STATES);
}

function transitionTargets(
  kind: SideEffectKind,
  managedObjectOperation: "write" | "delete" | null,
  state: string,
): readonly string[] {
  if (kind === "delivery") {
    return (
      transitions.delivery[state as keyof typeof transitions.delivery] ?? []
    );
  }
  if (kind === "inbox-message") {
    return (
      transitions.inboxMessage[
        state as keyof typeof transitions.inboxMessage
      ] ?? []
    );
  }
  const lifecycle =
    managedObjectOperation === "delete"
      ? transitions.managedObjectDelete
      : transitions.managedObjectWrite;
  return lifecycle[state as keyof typeof lifecycle] ?? [];
}

function equalSha256(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashRecord(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\0${canonicalEvidenceJson(value)}`);
}

function unsignedIntent(intent: SideEffectIntentV1): unknown {
  return {
    ...intent,
    integrity: { ...intent.integrity, intentSha256: null },
  };
}

function unsignedEvent(event: SideEffectTransitionEventV1): unknown {
  return {
    ...event,
    integrity: { ...event.integrity, eventSha256: null },
  };
}

export function verifySideEffectIntent(value: unknown): SideEffectIntentV1 {
  const intent = intentSchema.parse(value);
  const expected = hashRecord(INTENT_HASH_DOMAIN, unsignedIntent(intent));
  if (!equalSha256(intent.integrity.intentSha256, expected)) {
    throw new Error(
      "Side-effect intent digest does not match canonical bytes.",
    );
  }
  return intent;
}

export function canonicalSideEffectIntentJson(value: unknown): string {
  return canonicalEvidenceJson(verifySideEffectIntent(value));
}

export function createSideEffectIntent(
  input: CreateSideEffectIntentInputV1,
): SideEffectIntentV1 {
  const candidate = intentSchema.parse({
    ...input,
    schemaVersion: INTENT_SCHEMA,
    payloadProtection: "mve1",
    initialState: initialStateForKind(
      input.kind,
      input.kind === "managed-object" ? input.attributes.operation : null,
    ),
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: INTENT_HASH_DOMAIN,
      intentSha256: "0".repeat(64),
    },
  });
  return verifySideEffectIntent({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      intentSha256: hashRecord(INTENT_HASH_DOMAIN, unsignedIntent(candidate)),
    },
  });
}

export function createInitialSideEffectProjection(
  intentValue: unknown,
): SideEffectProjectionV1 {
  const intent = verifySideEffectIntent(intentValue);
  return projectionSchema.parse({
    schemaVersion: PROJECTION_SCHEMA,
    kind: intent.kind,
    operationId: intent.operationId,
    managedObjectOperation:
      intent.kind === "managed-object" ? intent.attributes.operation : null,
    state: intent.initialState,
    revision: "0",
    attemptCount: "0",
    lease: null,
    updatedAt: intent.createdAt,
  });
}

export function verifySideEffectProjection(
  value: unknown,
): SideEffectProjectionV1 {
  return projectionSchema.parse(value);
}

export function verifySideEffectTransitionEvent(
  value: unknown,
): SideEffectTransitionEventV1 {
  const event = transitionEventSchema.parse(value);
  const expected = hashRecord(EVENT_HASH_DOMAIN, unsignedEvent(event));
  if (!equalSha256(event.integrity.eventSha256, expected)) {
    throw new Error(
      "Side-effect transition digest does not match canonical bytes.",
    );
  }
  return event;
}

export function transitionSideEffectProjection(
  projectionValue: unknown,
  input: TransitionSideEffectInputV1,
): { projection: SideEffectProjectionV1; event: SideEffectTransitionEventV1 } {
  const current = verifySideEffectProjection(projectionValue);
  if (terminalStates.has(current.state)) {
    throw new Error(
      `Terminal side-effect state ${current.state} cannot transition.`,
    );
  }
  const allowed = transitionTargets(
    current.kind,
    current.managedObjectOperation,
    current.state,
  );
  if (!allowed.includes(input.toState)) {
    throw new Error(
      `Transition ${current.kind}:${current.state}->${input.toState} is not allowed.`,
    );
  }

  const operatorResolution =
    current.state === "unknown" ||
    current.state === "dead_letter" ||
    current.state === "repair_required";
  if (
    operatorResolution &&
    (input.trigger !== "operator" || !input.resolutionEvidenceSha256)
  ) {
    throw new Error(
      "Unknown, dead-letter, and repair-required states need operator evidence before retry or resolution.",
    );
  }
  if (!operatorResolution && input.resolutionEvidenceSha256) {
    throw new Error(
      "Resolution evidence is only valid for an operator recovery transition.",
    );
  }

  const toActive = activeStates.has(input.toState);
  if (toActive === Boolean(input.outcomeEvidenceSha256)) {
    throw new Error(
      "Starting work forbids outcome evidence; every completed state transition requires it.",
    );
  }
  if (toActive !== Boolean(input.nextLease)) {
    throw new Error(
      "An active target state requires exactly one bounded lease.",
    );
  }
  if (input.nextLease && input.nextLease.expiresAt <= input.recordedAt) {
    throw new Error(
      "A new execution lease must expire after the transition time.",
    );
  }
  const nextRevision = BigInt(current.revision) + 1n;
  if (nextRevision > MAX_BIGINT) {
    throw new Error(
      "Side-effect revision exhausted PostgreSQL bigint capacity.",
    );
  }
  const startsAttempt = toActive && !activeStates.has(current.state);
  const nextAttempt = BigInt(current.attemptCount) + (startsAttempt ? 1n : 0n);
  if (nextAttempt > MAX_BIGINT) {
    throw new Error(
      "Side-effect attempt counter exhausted PostgreSQL bigint capacity.",
    );
  }

  const eventCandidate = transitionEventSchema.parse({
    schemaVersion: EVENT_SCHEMA,
    transitionId: input.transitionId,
    operationId: current.operationId,
    kind: current.kind,
    managedObjectOperation: current.managedObjectOperation,
    fromState: current.state,
    toState: input.toState,
    expectedRevision: current.revision,
    nextRevision: nextRevision.toString(),
    attemptOrdinal: nextAttempt.toString(),
    trigger: input.trigger,
    reasonCode: input.reasonCode,
    outcomeEvidenceSha256: input.outcomeEvidenceSha256 ?? null,
    resolutionEvidenceSha256: input.resolutionEvidenceSha256 ?? null,
    recordedAt: input.recordedAt,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: EVENT_HASH_DOMAIN,
      eventSha256: "0".repeat(64),
    },
  });
  const event = verifySideEffectTransitionEvent({
    ...eventCandidate,
    integrity: {
      ...eventCandidate.integrity,
      eventSha256: hashRecord(EVENT_HASH_DOMAIN, unsignedEvent(eventCandidate)),
    },
  });
  const projection = projectionSchema.parse({
    ...current,
    state: input.toState,
    revision: event.nextRevision,
    attemptCount: event.attemptOrdinal,
    lease: input.nextLease ?? null,
    updatedAt: input.recordedAt,
  });
  return { projection, event };
}
