import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";
import {
  canonicalAuditEventJson,
  verifyAuditEventEnvelope,
  type AuditEventEnvelopeV1,
} from "./audit-event-envelope";

export const AUDIT_CHAIN_STREAM_ID = "site-logbook:audit:global:v1" as const;

const AUDIT_CHAIN_RECORD_SCHEMA = "site-logbook.audit-chain-record/v1" as const;
const AUDIT_EXPORT_INTENT_SCHEMA =
  "site-logbook.audit-export-intent/v1" as const;
const AUDIT_CANONICALIZATION = "site-logbook-cjson/v1" as const;
const AUDIT_CHAIN_HASH_DOMAIN = "site-logbook.audit-chain-record/v1" as const;
const AUDIT_EXPORT_HASH_DOMAIN = "site-logbook.audit-export-intent/v1" as const;
const AUDIT_EXPORT_FORMAT = "site-logbook.audit-jsonl/v1" as const;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const sequenceSchema = z
  .string()
  .regex(DECIMAL_PATTERN)
  .refine((value) => BigInt(value) <= MAX_POSTGRES_BIGINT, {
    message: "Audit sequence exceeds PostgreSQL bigint capacity.",
  });
const positiveSequenceSchema = sequenceSchema.refine(
  (value) => BigInt(value) > 0n,
  { message: "Audit sequence must be positive." },
);

const chainHeadSchema = z
  .object({
    streamId: z.literal(AUDIT_CHAIN_STREAM_ID),
    sequence: sequenceSchema,
    ledgerSha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((head, context) => {
    const genesis = head.sequence === "0";
    if (genesis !== (head.ledgerSha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["ledgerSha256"],
        message: "Only an empty audit chain may have a null ledger digest.",
      });
    }
  });

const ledgerRecordSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_CHAIN_RECORD_SCHEMA),
    streamId: z.literal(AUDIT_CHAIN_STREAM_ID),
    sequence: positiveSequenceSchema,
    eventId: z.string().regex(UUID_PATTERN),
    eventSha256: sha256Schema,
    recordedAt: z.string().regex(UTC_MILLIS_PATTERN),
    previousLedgerSha256: sha256Schema.nullable(),
    integrity: z
      .object({
        canonicalization: z.literal(AUDIT_CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(AUDIT_CHAIN_HASH_DOMAIN),
        ledgerSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const first = record.sequence === "1";
    if (first !== (record.previousLedgerSha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousLedgerSha256"],
        message:
          "Only the first audit chain record may omit the previous digest.",
      });
    }
  });

const exportIntentSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_EXPORT_INTENT_SCHEMA),
    intentId: z.string().regex(UUID_PATTERN),
    kind: z.literal("audit-chain-export"),
    createdAt: z.string().regex(UTC_MILLIS_PATTERN),
    streamId: z.literal(AUDIT_CHAIN_STREAM_ID),
    throughSequence: positiveSequenceSchema,
    throughLedgerSha256: sha256Schema,
    eventId: z.string().regex(UUID_PATTERN),
    eventSha256: sha256Schema,
    destination: z
      .object({
        kind: z.literal("versioned-object-storage"),
        namespace: z.literal("audit-evidence/v1"),
        format: z.literal(AUDIT_EXPORT_FORMAT),
      })
      .strict(),
    initialState: z.literal("pending"),
    integrity: z
      .object({
        canonicalization: z.literal(AUDIT_CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(AUDIT_EXPORT_HASH_DOMAIN),
        intentSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type AuditChainHeadV1 = z.infer<typeof chainHeadSchema>;
export type AuditChainRecordV1 = z.infer<typeof ledgerRecordSchema>;
export type AuditExportIntentV1 = z.infer<typeof exportIntentSchema>;

export type AuditChainHeadTransitionV1 = {
  expected: AuditChainHeadV1;
  next: AuditChainHeadV1;
};

export interface AuditChainTransactionV1 {
  lockHeadForUpdate(
    streamId: typeof AUDIT_CHAIN_STREAM_ID,
  ): Promise<AuditChainHeadV1 | null>;
  insertEventEnvelope(event: AuditEventEnvelopeV1): Promise<void>;
  insertLedgerRecord(record: AuditChainRecordV1): Promise<void>;
  insertExportIntent(intent: AuditExportIntentV1): Promise<void>;
  compareAndAdvanceHead(
    transition: AuditChainHeadTransitionV1,
  ): Promise<boolean>;
}

export type AuditChainAppendResultV1 = {
  event: AuditEventEnvelopeV1;
  ledgerRecord: AuditChainRecordV1;
  exportIntent: AuditExportIntentV1;
  headTransition: AuditChainHeadTransitionV1;
};

function equalSha256(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unsignedLedgerRecord(record: AuditChainRecordV1): unknown {
  return {
    ...record,
    integrity: { ...record.integrity, ledgerSha256: null },
  };
}

function ledgerSha256(record: AuditChainRecordV1): string {
  return sha256Hex(
    `${AUDIT_CHAIN_HASH_DOMAIN}\0${canonicalEvidenceJson(unsignedLedgerRecord(record))}`,
  );
}

function unsignedExportIntent(intent: AuditExportIntentV1): unknown {
  return {
    ...intent,
    integrity: { ...intent.integrity, intentSha256: null },
  };
}

function exportIntentSha256(intent: AuditExportIntentV1): string {
  return sha256Hex(
    `${AUDIT_EXPORT_HASH_DOMAIN}\0${canonicalEvidenceJson(unsignedExportIntent(intent))}`,
  );
}

export function verifyAuditChainHead(value: unknown): AuditChainHeadV1 {
  return chainHeadSchema.parse(value);
}

export function verifyAuditChainRecord(value: unknown): AuditChainRecordV1 {
  const record = ledgerRecordSchema.parse(value);
  const expected = ledgerSha256(record);
  if (!equalSha256(record.integrity.ledgerSha256, expected)) {
    throw new Error("Audit ledger digest does not match its canonical record.");
  }
  return record;
}

export function canonicalAuditChainRecordJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAuditChainRecord(value));
}

export function verifyAuditExportIntent(value: unknown): AuditExportIntentV1 {
  const intent = exportIntentSchema.parse(value);
  const expected = exportIntentSha256(intent);
  if (!equalSha256(intent.integrity.intentSha256, expected)) {
    throw new Error(
      "Audit export intent digest does not match its canonical record.",
    );
  }
  return intent;
}

export function canonicalAuditExportIntentJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAuditExportIntent(value));
}

export function createAuditChainRecord(
  eventValue: unknown,
  headValue: AuditChainHeadV1 | null,
): AuditChainRecordV1 {
  const event = verifyAuditEventEnvelope(eventValue);
  const head = headValue
    ? verifyAuditChainHead(headValue)
    : ({
        streamId: AUDIT_CHAIN_STREAM_ID,
        sequence: "0",
        ledgerSha256: null,
      } satisfies AuditChainHeadV1);
  const nextSequence = BigInt(head.sequence) + 1n;
  if (nextSequence > MAX_POSTGRES_BIGINT) {
    throw new Error(
      "Audit chain sequence exhausted PostgreSQL bigint capacity.",
    );
  }
  const candidate = ledgerRecordSchema.parse({
    schemaVersion: AUDIT_CHAIN_RECORD_SCHEMA,
    streamId: AUDIT_CHAIN_STREAM_ID,
    sequence: nextSequence.toString(),
    eventId: event.eventId,
    eventSha256: event.integrity.eventSha256,
    recordedAt: event.occurredAt,
    previousLedgerSha256: head.ledgerSha256,
    integrity: {
      canonicalization: AUDIT_CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: AUDIT_CHAIN_HASH_DOMAIN,
      ledgerSha256: "0".repeat(64),
    },
  });
  return verifyAuditChainRecord({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      ledgerSha256: ledgerSha256(candidate),
    },
  });
}

export function createAuditExportIntent(
  recordValue: unknown,
): AuditExportIntentV1 {
  const record = verifyAuditChainRecord(recordValue);
  const candidate = exportIntentSchema.parse({
    schemaVersion: AUDIT_EXPORT_INTENT_SCHEMA,
    intentId: record.eventId,
    kind: "audit-chain-export",
    createdAt: record.recordedAt,
    streamId: record.streamId,
    throughSequence: record.sequence,
    throughLedgerSha256: record.integrity.ledgerSha256,
    eventId: record.eventId,
    eventSha256: record.eventSha256,
    destination: {
      kind: "versioned-object-storage",
      namespace: "audit-evidence/v1",
      format: AUDIT_EXPORT_FORMAT,
    },
    initialState: "pending",
    integrity: {
      canonicalization: AUDIT_CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: AUDIT_EXPORT_HASH_DOMAIN,
      intentSha256: "0".repeat(64),
    },
  });
  return verifyAuditExportIntent({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      intentSha256: exportIntentSha256(candidate),
    },
  });
}

export async function appendAuditEventInTransaction(
  transaction: AuditChainTransactionV1,
  eventValue: unknown,
): Promise<AuditChainAppendResultV1> {
  const event = verifyAuditEventEnvelope(eventValue);
  canonicalAuditEventJson(event);
  const observedHead = await transaction.lockHeadForUpdate(
    AUDIT_CHAIN_STREAM_ID,
  );
  const expectedHead = observedHead
    ? verifyAuditChainHead(observedHead)
    : ({
        streamId: AUDIT_CHAIN_STREAM_ID,
        sequence: "0",
        ledgerSha256: null,
      } satisfies AuditChainHeadV1);
  const ledgerRecord = createAuditChainRecord(event, expectedHead);
  const exportIntent = createAuditExportIntent(ledgerRecord);
  const nextHead = verifyAuditChainHead({
    streamId: AUDIT_CHAIN_STREAM_ID,
    sequence: ledgerRecord.sequence,
    ledgerSha256: ledgerRecord.integrity.ledgerSha256,
  });
  const headTransition = { expected: expectedHead, next: nextHead };

  await transaction.insertEventEnvelope(event);
  await transaction.insertLedgerRecord(ledgerRecord);
  await transaction.insertExportIntent(exportIntent);
  if (!(await transaction.compareAndAdvanceHead(headTransition))) {
    throw new Error(
      "Audit chain head changed while appending; the transaction must roll back.",
    );
  }

  return { event, ledgerRecord, exportIntent, headTransition };
}
