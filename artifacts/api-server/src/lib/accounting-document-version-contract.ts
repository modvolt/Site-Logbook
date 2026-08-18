import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const VERSION_SCHEMA = "site-logbook.accounting-document-version/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SNAPSHOT_HASH_DOMAIN = "site-logbook.accounting-snapshot/v1" as const;
const ARTIFACT_HASH_DOMAIN = "site-logbook.accounting-artifact-set/v1" as const;
const VERSION_HASH_DOMAIN =
  "site-logbook.accounting-document-version/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const MACHINE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~0|~1)+)+$/;
const CANONICAL_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const positiveDecimalSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const currencySchema = z.string().regex(CURRENCY_PATTERN);
const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), {
      message: "Text must not contain leading or trailing whitespace.",
    });
const nullableText = (maximum: number) => boundedText(maximum).nullable();

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }, "Calendar date is invalid.");

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  }, "Timestamp must be a real UTC millisecond instant.");

function canonicalDecimal(maximumScale: number) {
  return z
    .string()
    .regex(CANONICAL_DECIMAL_PATTERN)
    .superRefine((value, context) => {
      const unsigned = value.startsWith("-") ? value.slice(1) : value;
      const [integer, fraction] = unsigned.split(".");
      if (fraction && fraction.length > maximumScale) {
        context.addIssue({
          code: "custom",
          message: `Decimal scale exceeds ${maximumScale}.`,
        });
      }
      if (fraction?.endsWith("0")) {
        context.addIssue({
          code: "custom",
          message: "Decimal must not contain trailing fractional zeroes.",
        });
      }
      if (
        value.startsWith("-") &&
        /^0(?:\.0+)?$/.test(`${integer}${fraction ? `.${fraction}` : ""}`)
      ) {
        context.addIssue({
          code: "custom",
          message: "Negative zero is not canonical.",
        });
      }
    });
}

const decimal4Schema = canonicalDecimal(4);

export const ACCOUNTING_ACTOR_SCHEMA_V1 = z
  .object({
    kind: z.enum(["user", "system"]),
    id: z.string().min(1).max(128),
    authentication: z.enum(["session", "step-up", "service", "migration"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "user") {
      if (!POSITIVE_DECIMAL_PATTERN.test(value.id)) {
        context.addIssue({
          code: "custom",
          path: ["id"],
          message: "User actor ID must be a positive decimal string.",
        });
      }
      if (!new Set(["session", "step-up"]).has(value.authentication)) {
        context.addIssue({
          code: "custom",
          path: ["authentication"],
          message: "User actor requires session or step-up authentication.",
        });
      }
      return;
    }
    if (!MACHINE_CODE_PATTERN.test(value.id)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "System actor ID must be a bounded machine code.",
      });
    }
    if (!new Set(["service", "migration"]).has(value.authentication)) {
      context.addIssue({
        code: "custom",
        path: ["authentication"],
        message: "System actor requires service or migration authentication.",
      });
    }
  });

const fieldProvenanceSchema = z
  .object({
    jsonPointer: z.string().regex(JSON_POINTER_PATTERN).max(512),
    source: z.enum(["human", "isdoc", "ai", "email", "system"]),
    actorRef: z
      .string()
      .regex(/^(?:user:[1-9][0-9]*|system:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)$/)
      .nullable(),
    sourceEvidenceSha256: sha256Schema.nullable(),
    extractionRunId: positiveDecimalSchema.nullable(),
    recordedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === "human") {
      if (
        !value.actorRef?.startsWith("user:") ||
        value.extractionRunId !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Human provenance requires a user actor and no extraction run.",
        });
      }
      return;
    }
    if (value.source === "ai") {
      if (
        value.extractionRunId === null ||
        value.sourceEvidenceSha256 === null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "AI provenance requires extraction-run and source-evidence hashes.",
        });
      }
      return;
    }
    if (value.sourceEvidenceSha256 === null) {
      context.addIssue({
        code: "custom",
        message: `${value.source} provenance requires source evidence.`,
      });
    }
  });

const nativeProvenanceSchema = z
  .object({
    captureMode: z.literal("native"),
    sourceMode: z.enum(["human", "isdoc", "ai-assisted", "email", "system"]),
    recordedBy: ACCOUNTING_ACTOR_SCHEMA_V1,
    approvalEvidenceSha256: sha256Schema,
    fieldProvenance: z.array(fieldProvenanceSchema).min(1).max(500_000),
  })
  .strict();

const nativeRejectionProvenanceSchema = z
  .object({
    captureMode: z.literal("native-rejection"),
    sourceMode: z.enum(["human", "isdoc", "ai-assisted", "email", "system"]),
    recordedBy: ACCOUNTING_ACTOR_SCHEMA_V1,
    rejectionEvidenceSha256: sha256Schema,
    fieldProvenance: z.array(fieldProvenanceSchema).min(1).max(500_000),
  })
  .strict();

const legacyProvenanceSchema = z
  .object({
    captureMode: z.literal("legacy-observation"),
    sourceMode: z.literal("legacy_unknown"),
    recordedBy: ACCOUNTING_ACTOR_SCHEMA_V1,
    approvalEvidenceSha256: z.null(),
    fieldProvenance: z.tuple([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.recordedBy.kind !== "system" ||
      value.recordedBy.authentication !== "migration"
    ) {
      context.addIssue({
        code: "custom",
        path: ["recordedBy"],
        message: "Legacy observations must be recorded by the migration plane.",
      });
    }
  });

const versionProvenanceSchema = z.discriminatedUnion("captureMode", [
  nativeProvenanceSchema,
  nativeRejectionProvenanceSchema,
  legacyProvenanceSchema,
]);

const artifactSchema = z
  .object({
    artifactId: uuidSchema,
    role: z.enum([
      "original-source",
      "rendered-pdf",
      "structured-isdoc",
      "correction-support",
      "approval-evidence",
    ]),
    mediaType: z.string().regex(MEDIA_TYPE_PATTERN).max(128),
    contentSha256: sha256Schema,
    sizeBytes: positiveDecimalSchema,
    objectLocationSha256: sha256Schema,
    rendererVersion: nullableText(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "rendered-pdf") {
      if (
        value.mediaType !== "application/pdf" ||
        value.rendererVersion === null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Rendered PDF requires application/pdf and a renderer version.",
        });
      }
    } else if (value.rendererVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["rendererVersion"],
        message: "Only rendered artifacts may carry a renderer version.",
      });
    }
  });

const partySchema = z
  .object({
    name: boundedText(512),
    ic: nullableText(32),
    dic: nullableText(32),
    address: nullableText(2048),
    email: nullableText(320),
    phone: nullableText(64),
  })
  .strict();

const costPartySchema = partySchema
  .extend({ name: nullableText(512) })
  .strict();

const invoiceLineSchema = z
  .object({
    position: z.number().int().positive().max(100_000),
    sourceLineId: positiveDecimalSchema.nullable(),
    sourceType: z.enum([
      "job",
      "activity",
      "activity_work",
      "activity_material",
      "material",
      "billing_document_line",
      "work_session",
      "quote_item",
      "transport",
      "parking",
      "fine",
      "manual",
      "correction",
    ]),
    sourceId: positiveDecimalSchema.nullable(),
    jobId: positiveDecimalSchema.nullable(),
    activityId: positiveDecimalSchema.nullable(),
    description: boundedText(4096),
    quantity: decimal4Schema,
    unit: nullableText(64),
    unitPriceWithoutVat: decimal4Schema,
    discountPercent: decimal4Schema.nullable(),
    vatRate: decimal4Schema.nullable(),
    vatMode: z.enum(["standard", "reverse_charge", "zero", "non_vat"]),
    totalWithoutVat: decimal4Schema,
    totalVat: decimal4Schema,
    totalWithVat: decimal4Schema,
  })
  .strict();

const invoiceSourceLinkSchema = z
  .object({
    sourceType: z.enum([
      "job",
      "activity",
      "work_session",
      "billing_document_line",
    ]),
    sourceId: positiveDecimalSchema,
    amountWithoutVat: decimal4Schema,
  })
  .strict();

const invoiceSnapshotSchema = z
  .object({
    kind: z.literal("outgoing-invoice"),
    invoice: z
      .object({
        id: positiveDecimalSchema,
        invoiceNumber: boundedText(128),
        documentType: z.enum([
          "invoice",
          "credit_note",
          "correction_invoice",
          "cancellation_notice",
        ]),
        issueDate: dateSchema,
        taxableSupplyDate: dateSchema,
        dueDate: dateSchema,
        currency: currencySchema,
        paymentMethod: nullableText(64),
        variableSymbol: nullableText(32),
        constantSymbol: nullableText(32),
        specificSymbol: nullableText(32),
        vatModeDefault: z.enum([
          "standard",
          "reverse_charge",
          "zero",
          "non_vat",
        ]),
        materialDisplayMode: z.enum(["detailed", "summary"]),
        notes: nullableText(16_384),
      })
      .strict(),
    customer: partySchema
      .extend({ customerId: positiveDecimalSchema.nullable() })
      .strict(),
    supplier: partySchema
      .extend({
        bankAccount: nullableText(128),
        iban: nullableText(64),
        bic: nullableText(32),
        vatPayer: z.boolean(),
      })
      .strict(),
    lines: z.array(invoiceLineSchema).min(1).max(10_000),
    sourceLinks: z.array(invoiceSourceLinkSchema).max(20_000),
    totals: z
      .object({
        subtotalWithoutVat: decimal4Schema,
        totalVat: decimal4Schema,
        totalWithVat: decimal4Schema,
      })
      .strict(),
    legacyPaymentObservation: z
      .object({
        paidDate: dateSchema.nullable(),
        paidAmount: decimal4Schema.nullable(),
        historicalCompleteness: z.literal("unknown"),
      })
      .strict()
      .nullable(),
  })
  .strict();

const costLineSchema = z
  .object({
    position: z.number().int().positive().max(100_000),
    sourceLineId: positiveDecimalSchema.nullable(),
    lineType: z.enum(["material", "work", "transport", "other"]),
    description: boundedText(4096),
    quantity: decimal4Schema,
    unit: nullableText(64),
    originalUnit: nullableText(64),
    unitPriceWithoutVat: decimal4Schema,
    vatRate: decimal4Schema.nullable(),
    vatMode: z.enum(["standard", "reverse_charge", "zero", "non_vat"]),
    totalWithoutVat: decimal4Schema,
    totalVat: decimal4Schema,
    totalWithVat: decimal4Schema,
    supplierSku: nullableText(256),
    ean: nullableText(64),
    manufacturer: nullableText(256),
    discountPercent: decimal4Schema.nullable(),
    listPriceWithoutVat: decimal4Schema.nullable(),
    priceBeforeDiscount: decimal4Schema.nullable(),
    priceAfterDiscount: decimal4Schema.nullable(),
    feeType: nullableText(64),
    environmentalFee: decimal4Schema.nullable(),
    recyclingFee: decimal4Schema.nullable(),
    deliveryNoteNumber: nullableText(256),
    orderNumber: nullableText(256),
    supplierOrderNumber: nullableText(256),
    sourceLineNumber: nullableText(128),
    jobId: positiveDecimalSchema.nullable(),
    activityId: positiveDecimalSchema.nullable(),
    allocationType: z.enum(["rebill", "internal", "stock", "not_rebilled"]),
    matchConfirmed: z.boolean(),
  })
  .strict();

const costReferenceSchema = z
  .object({
    referenceType: z.enum([
      "delivery_note",
      "summary_delivery_note",
      "delivery",
      "order",
      "supplier_order",
      "project",
      "invoice",
      "credit_note",
      "other",
    ]),
    referenceNumber: boundedText(512),
    source: z.enum([
      "isdoc",
      "pdf_text",
      "ai",
      "manual",
      "supplier_profile",
      "automatic_match",
    ]),
    matchedEntityRef: nullableText(256),
    matchConfirmed: z.boolean(),
    rejected: z.boolean(),
  })
  .strict();

const costFileRefSchema = z
  .object({
    artifactId: uuidSchema,
    role: z.enum([
      "primary",
      "visual_pdf",
      "structured_isdoc",
      "attachment",
      "original_email_attachment",
    ]),
    pageIndex: z.number().int().nonnegative().nullable(),
  })
  .strict();

const costSourceTraceSchema = z
  .object({
    capturePolicy: z.enum([
      "human-approved-final-state/v1",
      "human-reviewed-rejection-state/v1",
    ]),
    originalSource: z.enum(["manual", "job_attachment", "isdoc", "email"]),
    parsedBy: nullableText(128),
    extractionVersion: z.number().int().positive(),
    documentTypeSource: z.enum(["admin", "user", "ai", "unknown"]),
    documentTypeConfirmedByUserId: positiveDecimalSchema.nullable(),
    documentTypeConfirmedAt: timestampSchema.nullable(),
    aiEvidence: z
      .object({
        extractionRunId: positiveDecimalSchema,
        rawResponseSha256: sha256Schema,
        model: boundedText(256),
        confidence: decimal4Schema.nullable(),
        extractedAt: timestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasConfirmationActor = value.documentTypeConfirmedByUserId !== null;
    const hasConfirmationTime = value.documentTypeConfirmedAt !== null;
    if (hasConfirmationActor !== hasConfirmationTime) {
      context.addIssue({
        code: "custom",
        path: ["documentTypeConfirmedAt"],
        message: "Document-type confirmation actor and time must coexist.",
      });
    }
  });

const costSnapshotSchema = z
  .object({
    kind: z.literal("incoming-cost-document"),
    document: z
      .object({
        id: positiveDecimalSchema,
        documentType: z.enum([
          "unknown",
          "receipt",
          "delivery_note",
          "invoice",
          "credit_note",
        ]),
        source: z.enum(["manual", "job_attachment", "isdoc", "email"]),
        sourceRefSha256: sha256Schema.nullable(),
        documentNumber: nullableText(256),
        issueDate: dateSchema.nullable(),
        taxableSupplyDate: dateSchema.nullable(),
        dueDate: dateSchema.nullable(),
        currency: currencySchema,
        variableSymbol: nullableText(32),
        constantSymbol: nullableText(32),
        specificSymbol: nullableText(32),
        bankAccount: nullableText(128),
        iban: nullableText(64),
        bic: nullableText(32),
        deliveryNoteResolution: z.enum([
          "unknown",
          "required",
          "not_required",
          "waived",
        ]),
        deliveryNoteResolutionReason: nullableText(2048),
        customerId: positiveDecimalSchema.nullable(),
        jobId: positiveDecimalSchema.nullable(),
        notes: nullableText(16_384),
      })
      .strict(),
    supplier: costPartySchema,
    lines: z.array(costLineSchema).max(10_000),
    totals: z
      .object({
        subtotalWithoutVat: decimal4Schema.nullable(),
        totalVat: decimal4Schema.nullable(),
        totalWithVat: decimal4Schema.nullable(),
      })
      .strict(),
    fileRefs: z.array(costFileRefSchema).min(1).max(10_000),
    references: z.array(costReferenceSchema).max(10_000),
    sourceTrace: costSourceTraceSchema,
  })
  .strict();

const snapshotSchema = z.discriminatedUnion("kind", [
  invoiceSnapshotSchema,
  costSnapshotSchema,
]);

const versionBodyShape = {
  schemaVersion: z.literal(VERSION_SCHEMA),
  versionId: uuidSchema,
  aggregate: z
    .object({
      kind: z.enum(["outgoing-invoice", "incoming-cost-document"]),
      id: positiveDecimalSchema,
    })
    .strict(),
  version: positiveDecimalSchema,
  purpose: z.enum([
    "issued",
    "approved",
    "correction",
    "credit",
    "cancellation_notice",
    "discarded_observation",
    "legacy_observation",
  ]),
  supersedesVersionId: uuidSchema.nullable(),
  historicalCompleteness: z.enum(["complete", "unknown"]),
  effectiveAt: timestampSchema.nullable(),
  recordedAt: timestampSchema,
  snapshot: snapshotSchema,
  artifacts: z.array(artifactSchema).max(10_000),
  provenance: versionProvenanceSchema,
};

type VersionBody = z.infer<ReturnType<typeof versionBodySchemaFactory>>;

function versionBodySchemaFactory() {
  return z.object(versionBodyShape).strict().superRefine(validateVersionBody);
}

const versionBodySchema = versionBodySchemaFactory();

const integritySchema = z
  .object({
    canonicalization: z.literal(CANONICALIZATION),
    hashAlgorithm: z.literal("sha256"),
    snapshotHashDomain: z.literal(SNAPSHOT_HASH_DOMAIN),
    snapshotSha256: sha256Schema,
    artifactHashDomain: z.literal(ARTIFACT_HASH_DOMAIN),
    artifactSetSha256: sha256Schema,
    versionHashDomain: z.literal(VERSION_HASH_DOMAIN),
    versionSha256: sha256Schema,
  })
  .strict();

const versionSchema = z
  .object({ ...versionBodyShape, integrity: integritySchema })
  .strict()
  .superRefine((value, context) => validateVersionBody(value, context));

export type AccountingActorV1 = z.infer<typeof ACCOUNTING_ACTOR_SCHEMA_V1>;
export type AccountingFieldProvenanceV1 = z.infer<typeof fieldProvenanceSchema>;
export type AccountingSnapshotV1 = z.infer<typeof snapshotSchema>;
export type CreateAccountingDocumentVersionInputV1 = z.infer<
  typeof versionBodySchema
>;
export type AccountingDocumentVersionV1 = z.infer<typeof versionSchema>;

function decimalToScaled(value: string, scale = 4): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const scaled = BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
  return negative ? -scaled : scaled;
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateLineTotals(
  lines: ReadonlyArray<{
    totalWithoutVat: string;
    totalVat: string;
    totalWithVat: string;
  }>,
  context: z.RefinementCtx,
): void {
  lines.forEach((line, index) => {
    if (
      decimalToScaled(line.totalWithoutVat) + decimalToScaled(line.totalVat) !==
      decimalToScaled(line.totalWithVat)
    ) {
      addIssue(
        context,
        ["snapshot", "lines", index, "totalWithVat"],
        "Line VAT totals do not add up.",
      );
    }
  });
}

function validateAggregateTotals(
  lines: ReadonlyArray<{
    totalWithoutVat: string;
    totalVat: string;
    totalWithVat: string;
  }>,
  totals: {
    subtotalWithoutVat: string;
    totalVat: string;
    totalWithVat: string;
  },
  context: z.RefinementCtx,
): void {
  const sum = (field: "totalWithoutVat" | "totalVat" | "totalWithVat") =>
    lines.reduce((total, line) => total + decimalToScaled(line[field]), 0n);
  if (sum("totalWithoutVat") !== decimalToScaled(totals.subtotalWithoutVat)) {
    addIssue(
      context,
      ["snapshot", "totals", "subtotalWithoutVat"],
      "Subtotal does not match line evidence.",
    );
  }
  if (sum("totalVat") !== decimalToScaled(totals.totalVat)) {
    addIssue(
      context,
      ["snapshot", "totals", "totalVat"],
      "VAT total does not match line evidence.",
    );
  }
  if (sum("totalWithVat") !== decimalToScaled(totals.totalWithVat)) {
    addIssue(
      context,
      ["snapshot", "totals", "totalWithVat"],
      "Grand total does not match line evidence.",
    );
  }
}

function requireSequentialPositions(
  lines: ReadonlyArray<{ position: number }>,
  context: z.RefinementCtx,
): void {
  lines.forEach((line, index) => {
    if (line.position !== index + 1) {
      addIssue(
        context,
        ["snapshot", "lines", index, "position"],
        "Line positions must be canonical and contiguous.",
      );
    }
  });
}

function canonicalOrder<T>(values: readonly T[]): boolean {
  const encoded = values.map((value) => canonicalEvidenceJson(value));
  return encoded.every(
    (value, index) => index === 0 || encoded[index - 1]! < value,
  );
}

function hasUniqueKeys<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  const keys = values.map(key);
  return new Set(keys).size === keys.length;
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectLeafPointers(
  value: unknown,
  path: string,
  output: string[],
): void {
  if (value === null || typeof value !== "object") {
    output.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectLeafPointers(entry, `${path}/${index}`, output),
    );
    return;
  }
  Object.keys(value as Record<string, unknown>)
    .sort()
    .forEach((key) =>
      collectLeafPointers(
        (value as Record<string, unknown>)[key],
        `${path}/${escapePointerToken(key)}`,
        output,
      ),
    );
}

export function accountingSnapshotLeafPointers(snapshot: unknown): string[] {
  const parsed = snapshotSchema.parse(snapshot);
  const output: string[] = [];
  collectLeafPointers(parsed, "", output);
  return output.sort();
}

export function buildUniformAccountingFieldProvenance(
  snapshot: unknown,
  input: Omit<AccountingFieldProvenanceV1, "jsonPointer">,
): AccountingFieldProvenanceV1[] {
  return accountingSnapshotLeafPointers(snapshot).map((jsonPointer) =>
    fieldProvenanceSchema.parse({ ...input, jsonPointer }),
  );
}

function validateVersionBody(value: any, context: z.RefinementCtx): void {
  if (value.aggregate.kind !== value.snapshot.kind) {
    addIssue(
      context,
      ["aggregate", "kind"],
      "Aggregate and snapshot kinds must match.",
    );
  }
  const snapshotId =
    value.snapshot.kind === "outgoing-invoice"
      ? value.snapshot.invoice.id
      : value.snapshot.document.id;
  if (value.aggregate.id !== snapshotId) {
    addIssue(
      context,
      ["aggregate", "id"],
      "Aggregate and snapshot IDs must match.",
    );
  }

  const versionNumber = BigInt(value.version);
  if ((versionNumber === 1n) !== (value.supersedesVersionId === null)) {
    addIssue(
      context,
      ["supersedesVersionId"],
      "Only version one may omit its superseded predecessor.",
    );
  }

  const legacy = value.purpose === "legacy_observation";
  const rejected = value.purpose === "discarded_observation";
  if (legacy) {
    if (
      versionNumber !== 1n ||
      value.historicalCompleteness !== "unknown" ||
      value.provenance.captureMode !== "legacy-observation"
    ) {
      addIssue(
        context,
        ["purpose"],
        "Legacy observation must be version one with unknown historical completeness.",
      );
    }
  } else if (
    value.historicalCompleteness !== "complete" ||
    value.effectiveAt === null ||
    (rejected
      ? value.provenance.captureMode !== "native-rejection"
      : value.provenance.captureMode !== "native")
  ) {
    addIssue(
      context,
      ["historicalCompleteness"],
      "Native versions require purpose-specific complete provenance and an effective instant.",
    );
  }

  if (value.effectiveAt !== null && value.effectiveAt > value.recordedAt) {
    addIssue(
      context,
      ["effectiveAt"],
      "Effective instant cannot be after the recording instant.",
    );
  }

  const artifactIds = value.artifacts.map(
    (artifact: any) => artifact.artifactId,
  );
  if (
    new Set(artifactIds).size !== artifactIds.length ||
    !canonicalOrder(value.artifacts)
  ) {
    addIssue(
      context,
      ["artifacts"],
      "Artifacts must be unique and canonically ordered.",
    );
  }

  if (
    value.provenance.captureMode === "native" ||
    value.provenance.captureMode === "native-rejection"
  ) {
    const expectedPointers = accountingSnapshotLeafPointers(value.snapshot);
    const actualPointers = value.provenance.fieldProvenance.map(
      (entry: AccountingFieldProvenanceV1) => entry.jsonPointer,
    );
    if (
      new Set(actualPointers).size !== actualPointers.length ||
      expectedPointers.length !== actualPointers.length ||
      expectedPointers.some(
        (pointer, index) => pointer !== actualPointers[index],
      )
    ) {
      addIssue(
        context,
        ["provenance", "fieldProvenance"],
        "Native provenance must cover every snapshot leaf exactly once in canonical order.",
      );
    }
    value.provenance.fieldProvenance.forEach(
      (entry: AccountingFieldProvenanceV1, index: number) => {
        if (entry.recordedAt > value.recordedAt) {
          addIssue(
            context,
            ["provenance", "fieldProvenance", index, "recordedAt"],
            "Field provenance cannot postdate its version.",
          );
        }
      },
    );
  }

  requireSequentialPositions(value.snapshot.lines, context);
  validateLineTotals(value.snapshot.lines, context);

  if (value.snapshot.kind === "outgoing-invoice") {
    if (rejected) {
      addIssue(
        context,
        ["purpose"],
        "Discarded observations are limited to incoming cost documents.",
      );
    }
    const allowedPurpose = {
      invoice: "issued",
      credit_note: "credit",
      correction_invoice: "correction",
      cancellation_notice: "cancellation_notice",
    } as const;
    const documentType = value.snapshot.invoice
      .documentType as keyof typeof allowedPurpose;
    if (!legacy && allowedPurpose[documentType] !== value.purpose) {
      addIssue(
        context,
        ["purpose"],
        "Invoice purpose does not match its document type.",
      );
    }
    if (legacy !== (value.snapshot.legacyPaymentObservation !== null)) {
      addIssue(
        context,
        ["snapshot", "legacyPaymentObservation"],
        "Only a legacy version may carry an unknown payment observation.",
      );
    }
    if (
      !canonicalOrder(value.snapshot.sourceLinks) ||
      !hasUniqueKeys(
        value.snapshot.sourceLinks,
        (link: any) => `${link.sourceType}:${link.sourceId}`,
      )
    ) {
      addIssue(
        context,
        ["snapshot", "sourceLinks"],
        "Source links must be unique and canonically ordered.",
      );
    }
    validateAggregateTotals(
      value.snapshot.lines,
      value.snapshot.totals,
      context,
    );
    const invoiceTotal = decimalToScaled(value.snapshot.totals.totalWithVat);
    if (
      (!legacy &&
        value.snapshot.invoice.documentType === "invoice" &&
        invoiceTotal < 0n) ||
      (!legacy &&
        value.snapshot.invoice.documentType === "credit_note" &&
        invoiceTotal > 0n) ||
      (!legacy &&
        value.snapshot.invoice.documentType === "cancellation_notice" &&
        invoiceTotal !== 0n)
    ) {
      addIssue(
        context,
        ["snapshot", "totals", "totalWithVat"],
        "Outgoing-document total sign does not match its document type.",
      );
    }
    if (
      value.snapshot.invoice.issueDate > value.snapshot.invoice.dueDate ||
      value.snapshot.invoice.taxableSupplyDate > value.snapshot.invoice.dueDate
    ) {
      addIssue(
        context,
        ["snapshot", "invoice", "dueDate"],
        "Invoice due date cannot precede issue or taxable-supply date.",
      );
    }
    if (
      !value.artifacts.some((artifact: any) => artifact.role === "rendered-pdf")
    ) {
      addIssue(
        context,
        ["artifacts"],
        "Native outgoing documents require a rendered PDF artifact.",
      );
    }
    return;
  }

  if (
    !legacy &&
    !new Set(["approved", "correction", "discarded_observation"]).has(
      value.purpose,
    )
  ) {
    addIssue(
      context,
      ["purpose"],
      "Incoming cost documents support approved, correction or discarded-observation native versions.",
    );
  }
  if (
    !legacy &&
    !rejected &&
    value.snapshot.document.documentType === "unknown"
  ) {
    addIssue(
      context,
      ["snapshot", "document", "documentType"],
      "A native approved cost document cannot retain an unknown type.",
    );
  }
  if (!legacy && !rejected && value.snapshot.lines.length === 0) {
    addIssue(
      context,
      ["snapshot", "lines"],
      "Native approved or correction cost documents require at least one line.",
    );
  }
  if (!legacy && !rejected && value.snapshot.supplier.name === null) {
    addIssue(
      context,
      ["snapshot", "supplier", "name"],
      "Native approved or correction cost documents require a supplier name.",
    );
  }
  const expectedCapturePolicy = rejected
    ? "human-reviewed-rejection-state/v1"
    : "human-approved-final-state/v1";
  if (
    !legacy &&
    value.snapshot.sourceTrace.capturePolicy !== expectedCapturePolicy
  ) {
    addIssue(
      context,
      ["snapshot", "sourceTrace", "capturePolicy"],
      "Cost-document capture policy does not match its version purpose.",
    );
  }
  if (
    !canonicalOrder(value.snapshot.fileRefs) ||
    !canonicalOrder(value.snapshot.references) ||
    !hasUniqueKeys(value.snapshot.fileRefs, (file: any) => file.artifactId) ||
    !hasUniqueKeys(
      value.snapshot.references,
      (reference: any) =>
        `${reference.referenceType}:${reference.referenceNumber}`,
    )
  ) {
    addIssue(
      context,
      ["snapshot"],
      "Cost-document file references and references must be unique and canonically ordered.",
    );
  }
  const knownArtifactIds = new Set(artifactIds);
  if (
    value.snapshot.fileRefs.some(
      (file: any) => !knownArtifactIds.has(file.artifactId),
    )
  ) {
    addIssue(
      context,
      ["snapshot", "fileRefs"],
      "Every cost-document file must resolve to a version artifact.",
    );
  }
  const artifactById = new Map<string, any>(
    value.artifacts.map((artifact: any) => [artifact.artifactId, artifact]),
  );
  if (
    value.snapshot.fileRefs.some((file: any) => {
      const artifact = artifactById.get(file.artifactId);
      const expectedRole =
        file.role === "structured_isdoc"
          ? "structured-isdoc"
          : "original-source";
      return artifact?.role !== expectedRole;
    })
  ) {
    addIssue(
      context,
      ["snapshot", "fileRefs"],
      "Cost-document file roles must match their immutable artifacts.",
    );
  }
  if (
    (value.snapshot.document.source === "manual") !==
    (value.snapshot.document.sourceRefSha256 === null)
  ) {
    addIssue(
      context,
      ["snapshot", "document", "sourceRefSha256"],
      "Imported cost-document sources require a digest reference; manual input must omit it.",
    );
  }
  const resolutionNeedsReason = new Set(["not_required", "waived"]).has(
    value.snapshot.document.deliveryNoteResolution,
  );
  if (
    resolutionNeedsReason !==
    (value.snapshot.document.deliveryNoteResolutionReason !== null)
  ) {
    addIssue(
      context,
      ["snapshot", "document", "deliveryNoteResolutionReason"],
      "Delivery-note resolution reason does not match the selected resolution.",
    );
  }
  const totalValues = Object.values(value.snapshot.totals);
  if (
    !totalValues.every((entry) => entry === null) &&
    !totalValues.every((entry) => entry !== null)
  ) {
    addIssue(
      context,
      ["snapshot", "totals"],
      "Cost-document totals must be all known or all unknown.",
    );
  }
  if (
    !legacy &&
    !rejected &&
    new Set(["receipt", "invoice", "credit_note"]).has(
      value.snapshot.document.documentType,
    ) &&
    value.snapshot.totals.totalWithVat === null
  ) {
    addIssue(
      context,
      ["snapshot", "totals"],
      "A native monetary cost document requires complete totals.",
    );
  }
  if (value.snapshot.totals.totalWithVat !== null) {
    validateAggregateTotals(
      value.snapshot.lines,
      value.snapshot.totals,
      context,
    );
    const costTotal = decimalToScaled(value.snapshot.totals.totalWithVat);
    if (
      (value.snapshot.document.documentType === "credit_note" &&
        costTotal > 0n) ||
      (value.snapshot.document.documentType !== "credit_note" && costTotal < 0n)
    ) {
      addIssue(
        context,
        ["snapshot", "totals", "totalWithVat"],
        "Cost-document total sign does not match its document type.",
      );
    }
  }
  if (
    value.snapshot.document.issueDate !== null &&
    value.snapshot.document.dueDate !== null &&
    value.snapshot.document.issueDate > value.snapshot.document.dueDate
  ) {
    addIssue(
      context,
      ["snapshot", "document", "dueDate"],
      "Cost-document due date cannot precede its issue date.",
    );
  }
  if (
    !legacy &&
    !value.artifacts.some(
      (artifact: any) => artifact.role === "original-source",
    )
  ) {
    addIssue(
      context,
      ["artifacts"],
      "Native cost-document versions require original-source evidence.",
    );
  }
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\0${canonicalEvidenceJson(value)}`);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function expectedIntegrity(body: VersionBody) {
  const snapshotSha256 = domainHash(SNAPSHOT_HASH_DOMAIN, body.snapshot);
  const artifactSetSha256 = domainHash(ARTIFACT_HASH_DOMAIN, body.artifacts);
  const unsigned = {
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256" as const,
      snapshotHashDomain: SNAPSHOT_HASH_DOMAIN,
      snapshotSha256,
      artifactHashDomain: ARTIFACT_HASH_DOMAIN,
      artifactSetSha256,
      versionHashDomain: VERSION_HASH_DOMAIN,
      versionSha256: null,
    },
  };
  return {
    canonicalization: CANONICALIZATION,
    hashAlgorithm: "sha256" as const,
    snapshotHashDomain: SNAPSHOT_HASH_DOMAIN,
    snapshotSha256,
    artifactHashDomain: ARTIFACT_HASH_DOMAIN,
    artifactSetSha256,
    versionHashDomain: VERSION_HASH_DOMAIN,
    versionSha256: domainHash(VERSION_HASH_DOMAIN, unsigned),
  };
}

export function createAccountingDocumentVersion(
  input: CreateAccountingDocumentVersionInputV1,
): AccountingDocumentVersionV1 {
  const body = versionBodySchema.parse(input);
  return verifyAccountingDocumentVersion({
    ...body,
    integrity: expectedIntegrity(body),
  });
}

export function verifyAccountingDocumentVersion(
  value: unknown,
): AccountingDocumentVersionV1 {
  const parsed = versionSchema.parse(value);
  const { integrity: _integrity, ...body } = parsed;
  const expected = expectedIntegrity(body);
  if (
    !safeEqualHex(parsed.integrity.snapshotSha256, expected.snapshotSha256) ||
    !safeEqualHex(
      parsed.integrity.artifactSetSha256,
      expected.artifactSetSha256,
    ) ||
    !safeEqualHex(parsed.integrity.versionSha256, expected.versionSha256)
  ) {
    throw new Error(
      "Accounting document version integrity verification failed.",
    );
  }
  return parsed;
}

export function canonicalAccountingDocumentVersionJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAccountingDocumentVersion(value));
}

export function verifyCanonicalAccountingDocumentVersionJsonBytes(
  value: Buffer | string,
): AccountingDocumentVersionV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const parsed = verifyAccountingDocumentVersion(JSON.parse(text));
  if (canonicalEvidenceJson(parsed) !== text) {
    throw new Error(
      "Accounting document version bytes are not canonical JSON.",
    );
  }
  return parsed;
}
