import {
  parseProductionInvoice0108Intent,
  parseProductionInvoice0108Receipt,
  parseProductionInvoice0108RoleReceipt,
  validateProductionInvoice0108Inventory,
} from "./production-invoice-0108-contract.mjs";

export class ProductionInvoice0108RecoveryError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionInvoice0108RecoveryError";
    this.code = code;
    this.restoreRequired = code.startsWith("RESTORE_REQUIRED");
  }
}

function fail(code, message, options) {
  throw new ProductionInvoice0108RecoveryError(code, message, options);
}

export function classifyProductionInvoice0108Recovery({
  planCanonical,
  intentCanonical,
  migrationReceiptCanonical = null,
  roleReceiptCanonical = null,
  inventory,
}) {
  parseProductionInvoice0108Intent(intentCanonical, planCanonical);
  const state = validateProductionInvoice0108Inventory(inventory, "either");

  if (migrationReceiptCanonical === null) {
    if (roleReceiptCanonical !== null) {
      fail(
        "RESTORE_REQUIRED_ORPHAN_ROLE_RECEIPT",
        "Role receipt exists without its durable migration receipt.",
      );
    }
    if (state.phase === "post") {
      fail(
        "RESTORE_REQUIRED_UNKNOWN_COMMIT",
        "Exact 0108 is live without a durable migration receipt; do not retry.",
      );
    }
    return Object.freeze({
      decision: "READY_EXACT_0107_RECEIPT_ABSENT",
      migrationApplyAllowed: true,
      roleCeremonyAllowed: false,
      complete: false,
      restoreRequired: false,
      authorizesApplicationStart: false,
    });
  }

  const migrationReceipt = parseProductionInvoice0108Receipt(
    migrationReceiptCanonical,
    planCanonical,
    intentCanonical,
  );
  if (state.phase !== "post") {
    fail(
      "RESTORE_REQUIRED_RECEIPT_STATE_MISMATCH",
      "Durable 0108 receipt exists but the live journal is still exact 0107.",
    );
  }

  if (roleReceiptCanonical === null) {
    return Object.freeze({
      decision: "MIGRATION_RECEIPT_DURABLE_ROLE_DELTA_PENDING",
      migrationApplyAllowed: false,
      roleCeremonyAllowed: true,
      complete: false,
      restoreRequired: false,
      migrationReceiptSha256: migrationReceipt.artifact.sha256,
      authorizesApplicationStart: false,
    });
  }

  const roleReceipt = parseProductionInvoice0108RoleReceipt(
    roleReceiptCanonical,
    migrationReceiptCanonical,
  );
  return Object.freeze({
    decision: "EXACT_0108_AND_ROLE_DELTA_RECEIPT_BACKED",
    migrationApplyAllowed: false,
    roleCeremonyAllowed: false,
    complete: true,
    restoreRequired: false,
    migrationReceiptSha256: migrationReceipt.artifact.sha256,
    roleReceiptSha256: roleReceipt.artifact.sha256,
    authorizesApplicationStart: false,
  });
}

export function productionInvoice0108RestoreRequired(code, message, options) {
  const normalized = String(code).startsWith("RESTORE_REQUIRED")
    ? String(code)
    : `RESTORE_REQUIRED_${String(code)}`;
  fail(normalized, message, options);
}
