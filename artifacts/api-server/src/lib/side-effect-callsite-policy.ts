export type SideEffectCallsiteSymbol =
  | "sendEmailWithPdf"
  | "sendPlainEmail"
  | ".sendMail"
  | ".putPrivateObject"
  | ".deletePrivateObject"
  | ".putPrivateObjectRecoveryStream";

export type SideEffectCallsiteV1 = {
  file: string;
  symbol: SideEffectCallsiteSymbol;
  occurrences: number;
  kind: "delivery" | "managed-object";
  boundary: "product-caller" | "provider-adapter" | "recovery-plane";
  migrationStatus: "legacy-unbound" | "independently-bound";
};

/**
 * Exact source-tree inventory at the R12-A/B checkpoint.
 *
 * The drift test compares this list against every TypeScript source file. New
 * provider calls therefore fail the hermetic gate until they are reviewed and
 * either registered here or routed through the durable lifecycle. The recovery
 * stream is deliberately isolated from ordinary writes because it is already
 * governed by the independent object-recovery evidence plane.
 */
export const SIDE_EFFECT_CALLSITE_INVENTORY_V1 = [
  {
    file: "lib/backup.ts",
    symbol: ".sendMail",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/email.ts",
    symbol: ".sendMail",
    occurrences: 3,
    kind: "delivery",
    boundary: "provider-adapter",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/health-watchdog.ts",
    symbol: ".sendMail",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/ppe-overdue-notifier.ts",
    symbol: ".sendMail",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/billing.ts",
    symbol: "sendEmailWithPdf",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/customers.ts",
    symbol: "sendEmailWithPdf",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/jobs.ts",
    symbol: "sendEmailWithPdf",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/invoice-reminders.ts",
    symbol: "sendEmailWithPdf",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/quote-service.ts",
    symbol: "sendEmailWithPdf",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/jobs.ts",
    symbol: "sendPlainEmail",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/ppe.ts",
    symbol: "sendPlainEmail",
    occurrences: 1,
    kind: "delivery",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },

  {
    file: "lib/backup.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/cost-document-service.ts",
    symbol: ".putPrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/invoice-service.ts",
    symbol: ".putPrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/quote-service.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/quote-version-service.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/switchboard-label-version.ts",
    symbol: ".putPrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/customer-documents.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/jobs.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/me.ts",
    symbol: ".putPrivateObject",
    occurrences: 3,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/ppe.ts",
    symbol: ".putPrivateObject",
    occurrences: 4,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/sign.ts",
    symbol: ".putPrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/storage.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboard-operations.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboard-protocols.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboards.ts",
    symbol: ".putPrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },

  {
    file: "lib/backup.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/cost-document-service.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/quote-version-service.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "lib/switchboard-label-version.ts",
    symbol: ".deletePrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/customer-documents.ts",
    symbol: ".deletePrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/gdpr.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/jobs.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/me.ts",
    symbol: ".deletePrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/ppe.ts",
    symbol: ".deletePrivateObject",
    occurrences: 3,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/sign.ts",
    symbol: ".deletePrivateObject",
    occurrences: 4,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboard-operations.ts",
    symbol: ".deletePrivateObject",
    occurrences: 2,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboard-protocols.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },
  {
    file: "routes/switchboards.ts",
    symbol: ".deletePrivateObject",
    occurrences: 1,
    kind: "managed-object",
    boundary: "product-caller",
    migrationStatus: "legacy-unbound",
  },

  {
    file: "lib/object-recovery.ts",
    symbol: ".putPrivateObjectRecoveryStream",
    occurrences: 2,
    kind: "managed-object",
    boundary: "recovery-plane",
    migrationStatus: "independently-bound",
  },
] as const satisfies readonly SideEffectCallsiteV1[];
