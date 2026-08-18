import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const AUDIT_EVENT_SCHEMA = "site-logbook.audit-event/v1" as const;
const AUDIT_POLICY_VERSION = "audit-action-policy/v1" as const;
const AUDIT_CANONICALIZATION = "site-logbook-cjson/v1" as const;
const AUDIT_HASH_DOMAIN = "site-logbook.audit-event/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MACHINE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PROJECTION_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const UUID_VALUE_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SAFE_ID_PATTERN = new RegExp(
  `^(?:[1-9][0-9]*|${UUID_VALUE_PATTERN}|sha256-[0-9a-f]{64})$`,
);
const AUDIT_REF_PATTERN = new RegExp(
  `^(?:snapshot|artifact|approval|receipt|recovery|reason):(?:[1-9][0-9]*|${UUID_VALUE_PATTERN}|sha256-[0-9a-f]{64})$`,
);
const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/;
const SECRET_PATTERN =
  /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk(?:-|_live_|_test_)[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bxox[baprs]_[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;

const ARTIFACT_ROLES = [
  "before-snapshot",
  "after-snapshot",
  "source-input",
  "generated-output",
  "signed-document",
  "approval",
  "delivery-receipt",
  "recovery-evidence",
  "reason-detail",
] as const;
type AuditArtifactRole = (typeof ARTIFACT_ROLES)[number];

type AuditActionClass =
  | "create"
  | "update"
  | "delete"
  | "access"
  | "execute"
  | "decision";

type AuditActionPolicy = {
  class: AuditActionClass;
  critical: boolean;
  entityType: string;
  allowedProvenance: readonly AuditProvenanceSignature[];
  reasonCodes: readonly string[];
  requiresReasonDetail?: boolean;
  requiredArtifactRoles?: readonly AuditArtifactRole[];
};

type AuditProvenanceSignature =
  | "api:user:session"
  | "api:user:step-up"
  | "api:external:public-token"
  | "worker:system:service"
  | "scheduler:system:scheduler"
  | "import:system:service"
  | "ai:system:service"
  | "migration:system:migration"
  | "repair:system:service"
  | "repair:user:step-up";

const USER_API = ["api:user:session", "api:user:step-up"] as const;
const STEP_UP_API = ["api:user:step-up"] as const;
const USER_OR_WORKER = [
  "api:user:session",
  "api:user:step-up",
  "worker:system:service",
] as const;
const OPERATOR_OR_AUTOMATION = [
  "api:user:step-up",
  "worker:system:service",
  "scheduler:system:scheduler",
] as const;
const DENIED_REASON_CODES = ["authorization-denied"] as const;
const FAILED_REASON_CODES = ["validation-failed", "execution-failed"] as const;

function registeredReasons(
  ...successReasons: readonly string[]
): readonly string[] {
  return successReasons;
}

export const AUDIT_ACTION_POLICY_V1 = {
  "job.note.update": {
    class: "update",
    critical: false,
    entityType: "job",
    allowedProvenance: USER_API,
    reasonCodes: ["operator-edit"],
  },
  "vault.credential.reveal": {
    class: "access",
    critical: true,
    entityType: "device-credential",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("credential-access-approved"),
    requiredArtifactRoles: ["approval"],
  },
  "user.role.update": {
    class: "update",
    critical: true,
    entityType: "user",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("role-change-approved"),
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "user.permission.update": {
    class: "update",
    critical: true,
    entityType: "user",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("permission-change-approved"),
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "user.offboard.execute": {
    class: "execute",
    critical: true,
    entityType: "user",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("offboarding-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "invoice.payment.record": {
    class: "update",
    critical: true,
    entityType: "invoice",
    allowedProvenance: [
      ...USER_API,
      "import:system:service",
      "worker:system:service",
    ],
    reasonCodes: registeredReasons("payment-received", "payment-imported"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
    ],
  },
  "invoice.payment.correct": {
    class: "update",
    critical: true,
    entityType: "invoice",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("payment-correction-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot"],
  },
  "invoice.correction.create": {
    class: "create",
    critical: true,
    entityType: "invoice",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("billing-correction-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["after-snapshot", "generated-output", "approval"],
  },
  "invoice.void.execute": {
    class: "execute",
    critical: true,
    entityType: "invoice",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons(
      "customer-dispute",
      "wrong-job",
      "billing-error",
    ),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "invoice.issue": {
    class: "execute",
    critical: true,
    entityType: "invoice",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("document-approved"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "generated-output",
    ],
  },
  "invoice.cancel": {
    class: "execute",
    critical: true,
    entityType: "invoice",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("billing-error", "customer-dispute"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "invoice.status.change": {
    class: "update",
    critical: true,
    entityType: "invoice",
    allowedProvenance: USER_OR_WORKER,
    reasonCodes: registeredReasons("lifecycle-transition"),
    requiredArtifactRoles: ["before-snapshot", "after-snapshot"],
  },
  "invoice.refund.record": {
    class: "update",
    critical: true,
    entityType: "invoice",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("refund-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
    ],
  },
  "billing-document.approve": {
    class: "decision",
    critical: true,
    entityType: "billing-document",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("document-approved"),
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "billing-document.correct": {
    class: "update",
    critical: true,
    entityType: "billing-document",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("document-correction-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
    ],
  },
  "billing-document.delete": {
    class: "delete",
    critical: true,
    entityType: "billing-document",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("duplicate-document", "invalid-document"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "approval"],
  },
  "billing-document.return-to-review": {
    class: "decision",
    critical: true,
    entityType: "billing-document",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("review-reopened"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot"],
  },
  "signature.create": {
    class: "create",
    critical: true,
    entityType: "signature",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("signature-requested"),
    requiredArtifactRoles: ["after-snapshot", "source-input"],
  },
  "signature.sign": {
    class: "decision",
    critical: true,
    entityType: "signature",
    allowedProvenance: [
      "api:user:session",
      "api:user:step-up",
      "api:external:public-token",
    ],
    reasonCodes: registeredReasons("signer-consent"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "signed-document",
    ],
  },
  "signature.consume": {
    class: "execute",
    critical: true,
    entityType: "signature",
    allowedProvenance: USER_OR_WORKER,
    reasonCodes: registeredReasons("signed-document-consumed"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "signed-document",
    ],
  },
  "signature.revoke": {
    class: "execute",
    critical: true,
    entityType: "signature",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("signature-revoked"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "signature.supersede": {
    class: "execute",
    critical: true,
    entityType: "signature",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("signature-superseded"),
    requiresReasonDetail: true,
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "signed-document",
    ],
  },
  "privacy.export.execute": {
    class: "execute",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: USER_OR_WORKER,
    reasonCodes: registeredReasons("data-subject-request"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "generated-output",
    ],
  },
  "privacy.access.execute": {
    class: "access",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("privacy-access-approved"),
    requiredArtifactRoles: ["approval"],
  },
  "privacy.rectify.execute": {
    class: "update",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("data-subject-request"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "privacy.restrict.execute": {
    class: "execute",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("data-subject-request", "legal-hold"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "privacy.erase.execute": {
    class: "delete",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("data-subject-request", "retention-expired"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "approval"],
  },
  "privacy.hold.update": {
    class: "update",
    critical: true,
    entityType: "privacy-request",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("legal-hold"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "time.session.approve": {
    class: "decision",
    critical: true,
    entityType: "work-session",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("work-approved"),
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "time.session.reject": {
    class: "decision",
    critical: true,
    entityType: "work-session",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("work-rejected"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot"],
  },
  "time.session.correct": {
    class: "update",
    critical: true,
    entityType: "work-session",
    allowedProvenance: USER_API,
    reasonCodes: registeredReasons("time-correction-approved"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot"],
  },
  "time.session.void": {
    class: "execute",
    critical: true,
    entityType: "work-session",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons(
      "customer-dispute",
      "wrong-job",
      "time-entry-error",
    ),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "time.session.bill": {
    class: "execute",
    critical: true,
    entityType: "work-session",
    allowedProvenance: USER_OR_WORKER,
    reasonCodes: registeredReasons("billing-approved"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "generated-output",
    ],
  },
  "external-account.grant": {
    class: "create",
    critical: true,
    entityType: "external-account",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("external-access-approved"),
    requiredArtifactRoles: ["after-snapshot", "approval"],
  },
  "external-account.revoke": {
    class: "execute",
    critical: true,
    entityType: "external-account",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("external-access-revoked"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
  "backup.create": {
    class: "execute",
    critical: true,
    entityType: "backup",
    allowedProvenance: OPERATOR_OR_AUTOMATION,
    reasonCodes: registeredReasons("scheduled-backup", "operator-backup"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "recovery-evidence",
    ],
  },
  "backup.restore": {
    class: "execute",
    critical: true,
    entityType: "backup",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("restore-approved", "disaster-recovery"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "recovery-evidence",
      "approval",
    ],
  },
  "key.rotate": {
    class: "execute",
    critical: true,
    entityType: "key",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons(
      "scheduled-rotation",
      "suspected-compromise",
    ),
    requiresReasonDetail: true,
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "recovery-evidence",
      "approval",
    ],
  },
  "migration.apply": {
    class: "execute",
    critical: true,
    entityType: "migration",
    allowedProvenance: ["migration:system:migration"],
    reasonCodes: registeredReasons("approved-release"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
      "generated-output",
    ],
  },
  "backfill.execute": {
    class: "execute",
    critical: true,
    entityType: "backfill",
    allowedProvenance: ["migration:system:migration"],
    reasonCodes: registeredReasons("approved-backfill"),
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
      "generated-output",
    ],
  },
  "repair.execute": {
    class: "execute",
    critical: true,
    entityType: "repair",
    allowedProvenance: ["repair:system:service", "repair:user:step-up"],
    reasonCodes: registeredReasons("incident-repair"),
    requiresReasonDetail: true,
    requiredArtifactRoles: [
      "before-snapshot",
      "after-snapshot",
      "source-input",
      "generated-output",
    ],
  },
  "warehouse.override": {
    class: "execute",
    critical: true,
    entityType: "warehouse-item",
    allowedProvenance: STEP_UP_API,
    reasonCodes: registeredReasons("stock-exception"),
    requiresReasonDetail: true,
    requiredArtifactRoles: ["before-snapshot", "after-snapshot", "approval"],
  },
} as const satisfies Record<string, AuditActionPolicy>;

const CRITICAL_LIFECYCLE_STATES = {
  user: ["active", "suspended", "offboarded"],
  "device-credential": ["stored", "revoked"],
  invoice: [
    "draft",
    "issued",
    "partially-paid",
    "paid",
    "payment-corrected",
    "corrected",
    "voided",
    "cancelled",
    "refunded",
  ],
  "billing-document": ["needs-review", "approved", "corrected", "deleted"],
  signature: ["created", "signed", "consumed", "revoked", "superseded"],
  "privacy-request": [
    "requested",
    "approved",
    "processing",
    "completed",
    "restricted",
    "held",
    "erased",
    "denied",
    "failed",
  ],
  "work-session": [
    "submitted",
    "approved",
    "rejected",
    "corrected",
    "voided",
    "billed",
  ],
  "external-account": ["pending", "active", "revoked", "expired"],
  backup: ["requested", "created", "verified", "restored", "failed"],
  key: ["active", "rotated", "retired", "compromised"],
  migration: ["pending", "applied", "failed"],
  backfill: ["pending", "completed", "failed"],
  repair: ["pending", "completed", "failed"],
  "warehouse-item": ["active", "overridden"],
} as const satisfies Record<string, readonly string[]>;

const SOURCE_COMPONENT_POLICY = {
  api: { component: "api-server", systemActorId: null },
  worker: { component: "api-worker", systemActorId: "system:api-worker" },
  scheduler: {
    component: "api-scheduler",
    systemActorId: "system:api-scheduler",
  },
  import: {
    component: "billing-import",
    systemActorId: "system:billing-import",
  },
  ai: { component: "ai-analyzer", systemActorId: "system:ai-analyzer" },
  migration: {
    component: "migration-runner",
    systemActorId: "system:migration-runner",
  },
  repair: {
    component: "repair-runner",
    systemActorId: "system:repair-runner",
  },
} as const;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const machineCodeSchema = z.string().min(1).max(96).regex(MACHINE_CODE_PATTERN);
const safeIdSchema = z.string().min(1).max(128).regex(SAFE_ID_PATTERN);
const auditRefSchema = z.string().min(3).max(240).regex(AUDIT_REF_PATTERN);

const jobAuditProjectionSchema = z
  .object({
    id: z.number().int().positive().safe(),
    notePresent: z.boolean(),
  })
  .strict();

const criticalAggregateProjectionSchema = z
  .object({
    entityType: machineCodeSchema,
    entityId: safeIdSchema,
    aggregateVersion: safeIdSchema,
    lifecycleState: machineCodeSchema,
    contentSha256: sha256Schema,
    relationSetSha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((projection, context) => {
    const lifecycleStates = CRITICAL_LIFECYCLE_STATES[
      projection.entityType as keyof typeof CRITICAL_LIFECYCLE_STATES
    ] as readonly string[] | undefined;
    if (!lifecycleStates) {
      context.addIssue({
        code: "custom",
        path: ["entityType"],
        message: "critical projection entity type is not registered",
      });
      return;
    }
    if (!lifecycleStates.includes(projection.lifecycleState)) {
      context.addIssue({
        code: "custom",
        path: ["lifecycleState"],
        message: "critical projection lifecycle state is not registered",
      });
    }
  });

export const AUDIT_PROJECTION_POLICY_V1 = {
  "job.audit/v1": jobAuditProjectionSchema,
  "job-summary.audit/v1": jobAuditProjectionSchema,
  "critical-aggregate.audit/v1": criticalAggregateProjectionSchema,
} as const;

function projectionSchema(projection: string): z.ZodType | null {
  return (
    AUDIT_PROJECTION_POLICY_V1[
      projection as keyof typeof AUDIT_PROJECTION_POLICY_V1
    ] ?? null
  );
}

function projectionSha256(projection: string, value: unknown): string {
  return sha256Hex(
    `site-logbook.audit-projection/v1:${projection}\0${canonicalEvidenceJson(value)}`,
  );
}

const presentStateSchema = z
  .object({
    availability: z.literal("present"),
    completeness: z.literal("complete"),
    projection: z.string().min(1).max(96).regex(PROJECTION_PATTERN),
    data: z.unknown(),
    sha256: sha256Schema,
    missingFields: z.tuple([]),
    reason: z.null(),
  })
  .strict()
  .superRefine((state, context) => {
    const policy = projectionSchema(state.projection);
    if (!policy) {
      context.addIssue({
        code: "custom",
        message: "projection is not registered",
      });
      return;
    }
    const parsed = policy.safeParse(state.data);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "projection data is incomplete or invalid",
      });
      return;
    }
    if (projectionSha256(state.projection, parsed.data) !== state.sha256) {
      context.addIssue({
        code: "custom",
        message: "projection digest mismatch",
      });
    }
  });

const absentStateSchema = z
  .object({
    availability: z.literal("absent"),
    completeness: z.literal("not-applicable"),
    projection: z.null(),
    data: z.null(),
    sha256: z.null(),
    missingFields: z.tuple([]),
    reason: z.enum(["not-created", "deleted"]),
  })
  .strict();

const notCapturedStateSchema = z
  .object({
    availability: z.literal("not-captured"),
    completeness: z.literal("not-applicable"),
    projection: z.null(),
    data: z.null(),
    sha256: z.null(),
    missingFields: z.tuple([]),
    reason: z.enum(["operation-not-applied", "not-applicable"]),
  })
  .strict();

const stateSchema = z.discriminatedUnion("availability", [
  presentStateSchema,
  absentStateSchema,
  notCapturedStateSchema,
]);

const artifactSchema = z
  .object({
    role: z.enum(ARTIFACT_ROLES),
    ref: auditRefSchema,
    sha256: sha256Schema,
    byteLength: z.number().int().nonnegative().safe().nullable(),
    mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE_PATTERN).nullable(),
  })
  .strict();

const userActorIdSchema = z
  .string()
  .regex(new RegExp(`^user:(?:[1-9][0-9]*|${UUID_VALUE_PATTERN})$`));
const systemActorIdSchema = z
  .string()
  .regex(/^system:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const actorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      id: userActorIdSchema,
      authentication: z.enum(["session", "step-up"]),
      delegatedById: userActorIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      id: systemActorIdSchema,
      authentication: z.enum(["service", "scheduler", "migration"]),
      delegatedById: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      id: z.string().regex(/^external:[0-9a-f]{64}$/),
      authentication: z.literal("public-token"),
      delegatedById: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("anonymous"),
      id: z.literal("anonymous:unknown"),
      authentication: z.literal("none"),
      delegatedById: z.null(),
    })
    .strict(),
]);

const sourceSchema = z
  .object({
    kind: z.enum([
      "api",
      "worker",
      "scheduler",
      "import",
      "ai",
      "migration",
      "repair",
    ]),
    component: machineCodeSchema,
    operation: machineCodeSchema,
    buildRevision: z.union([
      z.literal("unknown"),
      z.string().regex(/^[0-9a-f]{40}$/),
    ]),
    requestIdSha256: sha256Schema.nullable(),
  })
  .strict();

const entitySchema = z
  .object({
    type: machineCodeSchema,
    id: safeIdSchema,
    version: safeIdSchema.nullable(),
  })
  .strict();

const reasonSchema = z
  .object({
    code: machineCodeSchema.nullable(),
    detailArtifactRef: auditRefSchema.nullable(),
    detailSha256: sha256Schema.nullable(),
  })
  .strict();

const correlationSchema = z
  .object({
    correlationIdSha256: sha256Schema,
    causationEventSha256: sha256Schema.nullable(),
    idempotencyKeySha256: sha256Schema.nullable(),
  })
  .strict();

const inputSchema = z
  .object({
    eventId: z.string().regex(UUID_PATTERN),
    occurredAt: z.string().regex(UTC_MILLIS_PATTERN),
    actor: actorSchema,
    source: sourceSchema,
    action: z
      .object({
        code: machineCodeSchema,
        outcome: z.enum(["succeeded", "denied", "failed"]),
      })
      .strict(),
    entity: entitySchema,
    reason: reasonSchema,
    state: z.object({ before: stateSchema, after: stateSchema }).strict(),
    correlation: correlationSchema,
    artifactRefs: z.array(artifactSchema).max(64),
  })
  .strict();

const envelopeSchema = inputSchema
  .omit({ action: true })
  .extend({
    schemaVersion: z.literal(AUDIT_EVENT_SCHEMA),
    action: z
      .object({
        code: machineCodeSchema,
        class: z.enum([
          "create",
          "update",
          "delete",
          "access",
          "execute",
          "decision",
        ]),
        outcome: z.enum(["succeeded", "denied", "failed"]),
        policyVersion: z.literal(AUDIT_POLICY_VERSION),
        critical: z.boolean(),
      })
      .strict(),
    integrity: z
      .object({
        canonicalization: z.literal(AUDIT_CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(AUDIT_HASH_DOMAIN),
        eventSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type AuditEventInputV1 = z.infer<typeof inputSchema>;
export type AuditEventEnvelopeV1 = z.infer<typeof envelopeSchema>;

function assertCanonicalTimestamp(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error(
      "Audit event occurredAt must be a real canonical UTC timestamp.",
    );
  }
}

function artifactSortKey(artifact: z.infer<typeof artifactSchema>): string {
  return `${artifact.role}\0${artifact.ref}`;
}

function assertCanonicalArtifacts(
  artifacts: AuditEventEnvelopeV1["artifactRefs"],
): void {
  const keys = artifacts.map(artifactSortKey);
  const expected = [...new Set(keys)].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("Audit artifactRefs must be sorted and unique.");
  }
  const expectedPrefix: Record<AuditArtifactRole, string> = {
    "before-snapshot": "snapshot:",
    "after-snapshot": "snapshot:",
    "source-input": "artifact:",
    "generated-output": "artifact:",
    "signed-document": "artifact:",
    approval: "approval:",
    "delivery-receipt": "receipt:",
    "recovery-evidence": "recovery:",
    "reason-detail": "reason:",
  };
  for (const artifact of artifacts) {
    if (!artifact.ref.startsWith(expectedPrefix[artifact.role])) {
      throw new Error(
        `Audit artifact ref namespace does not match role ${artifact.role}.`,
      );
    }
  }
}

function isNotCapturedOperation(state: z.infer<typeof stateSchema>): boolean {
  return (
    state.availability === "not-captured" &&
    state.reason === "operation-not-applied"
  );
}

function assertSuccessfulCriticalState(envelope: AuditEventEnvelopeV1): void {
  const { before, after } = envelope.state;
  const complete = (state: typeof before) =>
    state.availability === "present" && state.completeness === "complete";
  const absent = (state: typeof before, reason: "not-created" | "deleted") =>
    state.availability === "absent" && state.reason === reason;
  const notApplicable = (state: typeof before) =>
    state.availability === "not-captured" && state.reason === "not-applicable";

  const valid =
    (envelope.action.class === "create" &&
      absent(before, "not-created") &&
      complete(after)) ||
    (["update", "decision", "execute"].includes(envelope.action.class) &&
      complete(before) &&
      complete(after)) ||
    (envelope.action.class === "delete" &&
      complete(before) &&
      absent(after, "deleted")) ||
    (envelope.action.class === "access" &&
      notApplicable(before) &&
      notApplicable(after));
  if (!valid)
    throw new Error(
      "Critical action state transition does not match its action class.",
    );
}

function assertActorSourceConsistency(envelope: AuditEventEnvelopeV1): void {
  const { actor, source } = envelope;
  const componentPolicy = SOURCE_COMPONENT_POLICY[source.kind];
  if (source.component !== componentPolicy.component) {
    throw new Error(
      "Audit source component is not registered for its source kind.",
    );
  }
  if (actor.kind === "system" && actor.id !== componentPolicy.systemActorId) {
    throw new Error(
      "Audit system actor identity does not match its source component.",
    );
  }
  const valid =
    (source.kind === "api" && ["user", "external"].includes(actor.kind)) ||
    (source.kind === "worker" &&
      actor.kind === "system" &&
      actor.authentication === "service") ||
    (source.kind === "scheduler" &&
      actor.kind === "system" &&
      actor.authentication === "scheduler") ||
    (source.kind === "migration" &&
      actor.kind === "system" &&
      actor.authentication === "migration") ||
    (["import", "ai", "repair"].includes(source.kind) &&
      actor.kind !== "anonymous");
  if (!valid)
    throw new Error("Audit actor and source provenance are inconsistent.");
  if (
    envelope.action.critical &&
    source.kind === "api" &&
    !source.requestIdSha256
  ) {
    throw new Error("Critical API audit event requires a hashed request ID.");
  }
  if (
    envelope.action.code === "vault.credential.reveal" &&
    (actor.kind !== "user" || actor.authentication !== "step-up")
  ) {
    throw new Error(
      "Vault disclosure audit requires the current user step-up identity.",
    );
  }
}

function provenanceSignature(
  envelope: AuditEventEnvelopeV1,
): AuditProvenanceSignature | null {
  const signature = `${envelope.source.kind}:${envelope.actor.kind}:${envelope.actor.authentication}`;
  return [
    "api:user:session",
    "api:user:step-up",
    "api:external:public-token",
    "worker:system:service",
    "scheduler:system:scheduler",
    "import:system:service",
    "ai:system:service",
    "migration:system:migration",
    "repair:system:service",
    "repair:user:step-up",
  ].includes(signature)
    ? (signature as AuditProvenanceSignature)
    : null;
}

function assertActionPolicyBinding(
  envelope: AuditEventEnvelopeV1,
  policy: AuditActionPolicy,
): void {
  if (envelope.entity.type !== policy.entityType) {
    throw new Error("Audit entity type does not match the action policy.");
  }
  if (envelope.source.operation !== envelope.action.code) {
    throw new Error("Audit source operation does not match the action policy.");
  }
  const provenance = provenanceSignature(envelope);
  if (!provenance || !policy.allowedProvenance.includes(provenance)) {
    throw new Error(
      "Audit actor/source provenance is not allowed by the action policy.",
    );
  }
  const allowedReasonCodes: readonly string[] =
    envelope.action.outcome === "succeeded"
      ? policy.reasonCodes
      : envelope.action.outcome === "denied"
        ? DENIED_REASON_CODES
        : FAILED_REASON_CODES;
  if (
    envelope.reason.code !== null &&
    !allowedReasonCodes.includes(envelope.reason.code)
  ) {
    throw new Error(
      "Audit reason code is not registered for the action policy.",
    );
  }
}

function requiredArtifactRoles(
  policy: AuditActionPolicy,
): readonly AuditArtifactRole[] {
  if (policy.requiredArtifactRoles) return policy.requiredArtifactRoles;
  if (!policy.critical) return [];
  if (policy.class === "create") return ["after-snapshot"];
  if (policy.class === "delete") return ["before-snapshot"];
  if (policy.class === "access") return ["approval"];
  return ["before-snapshot", "after-snapshot"];
}

function assertCriticalStateArtifactBinding(
  envelope: AuditEventEnvelopeV1,
): void {
  for (const [side, state] of [
    ["before", envelope.state.before],
    ["after", envelope.state.after],
  ] as const) {
    if (state.availability !== "present") continue;
    if (state.projection !== "critical-aggregate.audit/v1") {
      throw new Error(
        "Critical captured state must use the registered critical projection.",
      );
    }
    const projection = criticalAggregateProjectionSchema.parse(state.data);
    if (
      projection.entityType !== envelope.entity.type ||
      projection.entityId !== envelope.entity.id ||
      (side === "after" &&
        projection.aggregateVersion !== envelope.entity.version) ||
      (envelope.action.class === "delete" &&
        side === "before" &&
        projection.aggregateVersion !== envelope.entity.version)
    ) {
      throw new Error(
        "Critical projection identity does not match the event entity.",
      );
    }
    const role = `${side}-snapshot` as "before-snapshot" | "after-snapshot";
    if (
      !envelope.artifactRefs.some(
        (artifact) =>
          artifact.role === role &&
          artifact.sha256 === projection.contentSha256,
      )
    ) {
      throw new Error(
        `Critical ${side} state is not bound to its snapshot artifact.`,
      );
    }
  }
}

function assertEnvelopeSemantics(envelope: AuditEventEnvelopeV1): void {
  assertCanonicalTimestamp(envelope.occurredAt);
  assertCanonicalArtifacts(envelope.artifactRefs);
  const policy = AUDIT_ACTION_POLICY_V1[
    envelope.action.code as keyof typeof AUDIT_ACTION_POLICY_V1
  ] as AuditActionPolicy | undefined;
  if (!policy)
    throw new Error(`Audit action is not registered: ${envelope.action.code}.`);
  if (
    envelope.action.class !== policy.class ||
    envelope.action.critical !== policy.critical
  ) {
    throw new Error("Audit action metadata does not match the action policy.");
  }
  assertActorSourceConsistency(envelope);
  assertActionPolicyBinding(envelope, policy);

  const detailArtifact = envelope.artifactRefs.find(
    (artifact) => artifact.ref === envelope.reason.detailArtifactRef,
  );
  if (
    (envelope.reason.detailArtifactRef === null) !==
    (envelope.reason.detailSha256 === null)
  ) {
    throw new Error(
      "Audit reason detail ref and digest must be provided together.",
    );
  }
  if (
    envelope.reason.detailArtifactRef &&
    (!detailArtifact ||
      detailArtifact.role !== "reason-detail" ||
      detailArtifact.sha256 !== envelope.reason.detailSha256)
  ) {
    throw new Error(
      "Audit reason detail must bind a matching reason-detail artifact.",
    );
  }

  if (policy.critical) {
    if (!envelope.reason.code)
      throw new Error("Critical audit action requires a bounded reason code.");
    if (!/^[0-9a-f]{40}$/.test(envelope.source.buildRevision)) {
      throw new Error(
        "A critical audit event requires an exact build revision.",
      );
    }
    if (
      envelope.action.class !== "access" &&
      envelope.correlation.idempotencyKeySha256 === null
    ) {
      throw new Error("A critical mutation requires a hashed idempotency key.");
    }
  }

  if (envelope.action.outcome !== "succeeded") {
    if (
      !isNotCapturedOperation(envelope.state.before) ||
      !isNotCapturedOperation(envelope.state.after)
    ) {
      throw new Error(
        "Failed or denied audit events cannot claim a state mutation.",
      );
    }
    return;
  }
  if (!policy.critical) return;
  for (const requiredRole of requiredArtifactRoles(policy)) {
    if (
      !envelope.artifactRefs.some((artifact) => artifact.role === requiredRole)
    ) {
      throw new Error(
        `Critical audit action requires artifact role ${requiredRole}.`,
      );
    }
  }
  if (envelope.actor.kind === "anonymous") {
    throw new Error(
      "A successful critical audit event cannot have an anonymous actor.",
    );
  }
  if (policy.requiresReasonDetail && !envelope.reason.detailArtifactRef) {
    throw new Error(
      "This critical audit action requires a reason-detail artifact.",
    );
  }
  assertSuccessfulCriticalState(envelope);
  assertCriticalStateArtifactBinding(envelope);
}

function unsignedEnvelope(envelope: AuditEventEnvelopeV1): unknown {
  return {
    ...envelope,
    integrity: {
      ...envelope.integrity,
      eventSha256: null,
    },
  };
}

function computeEventSha256(envelope: AuditEventEnvelopeV1): string {
  return sha256Hex(
    `${AUDIT_HASH_DOMAIN}\0${canonicalEvidenceJson(unsignedEnvelope(envelope))}`,
  );
}

function equalSha256(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function auditProjectionSha256(
  projection: string,
  value: unknown,
): string {
  const policy = projectionSchema(projection);
  if (!policy) throw new Error("Audit projection is not registered.");
  const parsed = policy.parse(value);
  const canonical = canonicalEvidenceJson(parsed);
  if (SECRET_PATTERN.test(canonical)) {
    throw new Error("Audit projection contains a recognized secret pattern.");
  }
  return projectionSha256(projection, parsed);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createAuditEventEnvelope(
  input: AuditEventInputV1,
): AuditEventEnvelopeV1 {
  const parsed = inputSchema.parse(input);
  const policy = AUDIT_ACTION_POLICY_V1[
    parsed.action.code as keyof typeof AUDIT_ACTION_POLICY_V1
  ] as AuditActionPolicy | undefined;
  if (!policy)
    throw new Error(`Audit action is not registered: ${parsed.action.code}.`);
  const artifactRefs = [...parsed.artifactRefs].sort((left, right) => {
    const leftKey = artifactSortKey(left);
    const rightKey = artifactSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const normalizedState = {
    before: {
      ...parsed.state.before,
      missingFields: [...new Set(parsed.state.before.missingFields)].sort(),
    },
    after: {
      ...parsed.state.after,
      missingFields: [...new Set(parsed.state.after.missingFields)].sort(),
    },
  };
  const candidate = envelopeSchema.parse({
    schemaVersion: AUDIT_EVENT_SCHEMA,
    ...parsed,
    action: {
      code: parsed.action.code,
      class: policy.class,
      outcome: parsed.action.outcome,
      policyVersion: AUDIT_POLICY_VERSION,
      critical: policy.critical,
    },
    state: normalizedState,
    artifactRefs,
    integrity: {
      canonicalization: AUDIT_CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: AUDIT_HASH_DOMAIN,
      eventSha256: "0".repeat(64),
    },
  });
  assertEnvelopeSemantics(candidate);
  const envelope = {
    ...candidate,
    integrity: {
      ...candidate.integrity,
      eventSha256: computeEventSha256(candidate),
    },
  };
  return verifyAuditEventEnvelope(envelope);
}

export function verifyAuditEventEnvelope(value: unknown): AuditEventEnvelopeV1 {
  const envelope = envelopeSchema.parse(value);
  assertEnvelopeSemantics(envelope);
  const expected = computeEventSha256(envelope);
  if (!equalSha256(envelope.integrity.eventSha256, expected)) {
    throw new Error(
      "Audit event digest does not match its canonical envelope.",
    );
  }
  if (SECRET_PATTERN.test(canonicalEvidenceJson(envelope))) {
    throw new Error("Audit event contains a recognized secret pattern.");
  }
  return deepFreeze(envelope);
}

export function canonicalAuditEventJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAuditEventEnvelope(value));
}

export function verifyCanonicalAuditEventJsonBytes(
  value: Buffer | string,
): AuditEventEnvelopeV1 {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Audit event bytes are not valid canonical UTF-8.");
  }
  const parsed = JSON.parse(text) as unknown;
  const envelope = verifyAuditEventEnvelope(parsed);
  if (canonicalEvidenceJson(envelope) !== text) {
    throw new Error("Audit event JSON bytes are not canonical.");
  }
  return envelope;
}
