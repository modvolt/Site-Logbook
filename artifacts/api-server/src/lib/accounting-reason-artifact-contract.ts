import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  verifyAccountingLifecycleEvent,
  type AccountingLifecycleEventV1,
} from "./accounting-lifecycle-event-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const SCHEMA = "site-logbook.accounting-reason-artifact/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_PATTERN =
  /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk(?:-|_live_|_test_)[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bxox[baprs]_[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;

const reasonDigestDomainSchema = z.enum([
  "site-logbook.cost-document-review-reopen-reason/v1",
  "site-logbook.cost-document-reviewed-rejection-reason/v1",
]);
const reasonCodeSchema = z.enum([
  "review_reopened",
  "duplicate_document",
  "invalid_document",
]);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const reasonTextSchema = z
  .string()
  .min(3)
  .max(1_000)
  .refine(
    (value) => value === value.normalize("NFC").trim(),
    "Reason text must be trimmed NFC.",
  )
  .refine(
    (value) => !CONTROL_CHARACTER_PATTERN.test(value),
    "Reason text contains unsupported control characters.",
  )
  .refine(
    (value) => !SECRET_PATTERN.test(value),
    "Reason text contains a recognized secret pattern.",
  );

const bodyShape = {
  schemaVersion: z.literal(SCHEMA),
  artifactId: z.string().uuid(),
  aggregate: z
    .object({
      kind: z.literal("incoming-cost-document"),
      id: z.string().regex(POSITIVE_DECIMAL_PATTERN),
      versionId: z.string().uuid(),
    })
    .strict(),
  lifecycleEvent: z
    .object({
      eventId: z.string().uuid(),
      eventSha256: z.string().regex(SHA256_PATTERN),
    })
    .strict(),
  reason: z
    .object({
      code: reasonCodeSchema,
      text: reasonTextSchema,
      textSha256: z.string().regex(SHA256_PATTERN),
      digestDomain: reasonDigestDomainSchema,
    })
    .strict(),
  retention: z
    .object({
      class: z.literal("restricted-accounting-evidence"),
      legalHoldAware: z.literal(true),
      selectivePlaintextRewriteSupported: z.literal(false),
    })
    .strict(),
  accessPolicy: z
    .object({
      mode: z.literal("restricted"),
      listing: z.literal("metadata-only"),
      plaintextExport: z.literal("authorized-audit-only"),
    })
    .strict(),
  recordedAt: timestampSchema,
};

const artifactSchema = z
  .object({
    ...bodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(SCHEMA),
        artifactSha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
  })
  .strict();

export type AccountingReasonArtifactV1 = z.infer<typeof artifactSchema>;
export type AccountingReasonDigestDomainV1 = z.infer<
  typeof reasonDigestDomainSchema
>;

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export function normalizeAccountingReasonText(value: string): string {
  return reasonTextSchema.parse(value.normalize("NFC").trim());
}

export function accountingReasonTextSha256(
  domain: AccountingReasonDigestDomainV1,
  value: string,
): string {
  const text = normalizeAccountingReasonText(value);
  return sha256Hex(`${domain}\0${canonicalEvidenceJson({ reason: text })}`);
}

function artifactSha256(value: AccountingReasonArtifactV1): string {
  return sha256Hex(
    `${SCHEMA}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...value.integrity, artifactSha256: null },
    })}`,
  );
}

function assertDomainPolicy(
  event: AccountingLifecycleEventV1,
  domain: AccountingReasonDigestDomainV1,
): void {
  const expected =
    event.eventType === "review_reopened"
      ? "site-logbook.cost-document-review-reopen-reason/v1"
      : event.eventType === "ignored"
        ? "site-logbook.cost-document-reviewed-rejection-reason/v1"
        : null;
  if (domain !== expected) {
    throw new Error(
      "Accounting reason digest domain does not match the lifecycle event.",
    );
  }
}

export function createAccountingReasonArtifact(input: {
  artifactId: string;
  lifecycleEvent: unknown;
  reasonText: string;
  digestDomain: AccountingReasonDigestDomainV1;
}): AccountingReasonArtifactV1 {
  const event = verifyAccountingLifecycleEvent(input.lifecycleEvent);
  if (
    event.aggregate.kind !== "incoming-cost-document" ||
    (event.eventType !== "review_reopened" && event.eventType !== "ignored") ||
    event.reasonDetailSha256 === null
  ) {
    throw new Error(
      "Readable accounting reason requires a supported incoming lifecycle event with a detail digest.",
    );
  }
  assertDomainPolicy(event, input.digestDomain);
  const text = normalizeAccountingReasonText(input.reasonText);
  const textSha256 = accountingReasonTextSha256(input.digestDomain, text);
  if (!safeEqualHex(textSha256, event.reasonDetailSha256)) {
    throw new Error(
      "Readable accounting reason does not match the lifecycle-event digest.",
    );
  }
  const candidate = artifactSchema.parse({
    schemaVersion: SCHEMA,
    artifactId: input.artifactId,
    aggregate: event.aggregate,
    lifecycleEvent: {
      eventId: event.eventId,
      eventSha256: event.integrity.entrySha256,
    },
    reason: {
      code: event.reasonCode,
      text,
      textSha256,
      digestDomain: input.digestDomain,
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
    recordedAt: event.recordedAt,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: SCHEMA,
      artifactSha256: "0".repeat(64),
    },
  });
  return artifactSchema.parse({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      artifactSha256: artifactSha256(candidate),
    },
  });
}

export function verifyAccountingReasonArtifact(
  value: unknown,
): AccountingReasonArtifactV1 {
  const artifact = artifactSchema.parse(value);
  if (
    !safeEqualHex(
      artifact.reason.textSha256,
      accountingReasonTextSha256(
        artifact.reason.digestDomain,
        artifact.reason.text,
      ),
    ) ||
    !safeEqualHex(artifact.integrity.artifactSha256, artifactSha256(artifact))
  ) {
    throw new Error("Accounting reason-artifact digest does not match.");
  }
  return artifact;
}

export function verifyAccountingReasonArtifactBinding(
  value: unknown,
  lifecycleEventValue: unknown,
): AccountingReasonArtifactV1 {
  const artifact = verifyAccountingReasonArtifact(value);
  const expected = createAccountingReasonArtifact({
    artifactId: artifact.artifactId,
    lifecycleEvent: lifecycleEventValue,
    reasonText: artifact.reason.text,
    digestDomain: artifact.reason.digestDomain,
  });
  if (canonicalEvidenceJson(artifact) !== canonicalEvidenceJson(expected)) {
    throw new Error(
      "Accounting reason artifact does not match its lifecycle event.",
    );
  }
  return artifact;
}

export function canonicalAccountingReasonArtifactJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAccountingReasonArtifact(value));
}

export function verifyCanonicalAccountingReasonArtifactJsonBytes(
  value: string | Buffer,
): AccountingReasonArtifactV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const artifact = verifyAccountingReasonArtifact(JSON.parse(text));
  if (canonicalEvidenceJson(artifact) !== text) {
    throw new Error("Accounting reason-artifact bytes are not canonical JSON.");
  }
  return artifact;
}
