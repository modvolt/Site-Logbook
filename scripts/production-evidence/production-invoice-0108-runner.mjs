import {
  PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY,
  PRODUCTION_INVOICE_0108_CONFIRMATION,
  PRODUCTION_INVOICE_0108_MIGRATION,
  PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
  canonicalProductionInvoice0108Sql,
  createProductionInvoice0108Intent,
  createProductionInvoice0108Plan,
  createProductionInvoice0108Receipt,
  parseProductionInvoice0108BackupReference,
  parseProductionInvoice0108Intent,
  parseProductionInvoice0108Plan,
  parseProductionInvoice0108Receipt,
  parseProductionInvoice0108RoleReceipt,
  validateProductionInvoice0108Inventory,
} from "./production-invoice-0108-contract.mjs";
import { canonicalProductionMigrationJson } from "./production-migration-contract.mjs";
import {
  classifyProductionInvoice0108Recovery,
  productionInvoice0108RestoreRequired,
} from "./production-invoice-0108-verifier.mjs";

const STORAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class ProductionInvoice0108RunnerError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionInvoice0108RunnerError";
    this.code = code;
    this.restoreRequired = options?.restoreRequired === true;
  }
}

function fail(code, message, options) {
  throw new ProductionInvoice0108RunnerError(
    `PRODUCTION_INVOICE_0108_${code}`,
    message,
    options,
  );
}

function requireConfirmation(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "CONFIRMATION_REQUIRED",
      `${field} requires the exact attended confirmation.`,
    );
  }
}

function exactStorageId(value, field) {
  if (!STORAGE_ID.test(String(value))) {
    fail("STORAGE_INVALID", `${field} is not a reviewed storage identifier.`);
  }
  return value;
}

function requireDependencies({
  database,
  artifacts,
  backupAuthority,
  roleAuthority,
}) {
  if (
    !database ||
    typeof database.connect !== "function" ||
    typeof database.readInventoryReadOnly !== "function" ||
    typeof database.readInventoryInTransaction !== "function" ||
    typeof database.assertMigrationAuthorityInTransaction !== "function" ||
    !artifacts ||
    typeof artifacts.persistExclusive !== "function" ||
    typeof artifacts.readCanonical !== "function" ||
    typeof artifacts.readOptionalCanonical !== "function" ||
    !backupAuthority ||
    typeof backupAuthority.assertFreshExact0107BackupRestoreReceipt !==
      "function" ||
    !roleAuthority ||
    typeof roleAuthority.assertExact0108Contract !== "function" ||
    typeof roleAuthority.applyExact0108Delta !== "function"
  ) {
    fail(
      "UNAVAILABLE",
      "Runner authorities are incomplete; production mutation remains disabled.",
    );
  }
}

async function persistAndReadback(artifacts, storageId, canonical) {
  exactStorageId(storageId, "storageId");
  await artifacts.persistExclusive(storageId, canonical);
  const readback = await artifacts.readCanonical(storageId);
  if (readback !== canonical) {
    fail(
      "READBACK_MISMATCH",
      "Exclusive durable artifact read-back differs from canonical bytes.",
    );
  }
}

function sameInventory(left, right) {
  return (
    canonicalProductionMigrationJson(left) ===
    canonicalProductionMigrationJson(right)
  );
}

function splitExact0108Statements(canonicalSql) {
  const statements = canonicalSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (
    statements.length === 0 ||
    statements.some((statement) =>
      /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(statement),
    )
  ) {
    fail(
      "SQL_INVALID",
      "Pinned 0108 SQL must contain statements but no transaction control.",
    );
  }
  return Object.freeze(statements);
}

async function releaseClient(client, destroy = false) {
  await client?.release?.(destroy);
}

export function createProductionInvoice0108Executable({
  sourceSha,
  readMigrationSql,
  database = null,
  artifacts = null,
  backupAuthority = null,
  roleAuthority = null,
  now = () => new Date(),
} = {}) {
  requireDependencies({ database, artifacts, backupAuthority, roleAuthority });
  if (typeof readMigrationSql !== "function") {
    fail("SQL_UNAVAILABLE", "A source-pinned 0108 SQL reader is required.");
  }

  async function loadPinnedSql() {
    const raw = await readMigrationSql();
    return canonicalProductionInvoice0108Sql(raw);
  }

  async function loadDurable(planStorageId, intentStorageId) {
    const planCanonical = await artifacts.readCanonical(
      exactStorageId(planStorageId, "planStorageId"),
    );
    const intentCanonical = await artifacts.readCanonical(
      exactStorageId(intentStorageId, "intentStorageId"),
    );
    const intent = parseProductionInvoice0108Intent(
      intentCanonical,
      planCanonical,
    );
    await loadPinnedSql();
    return Object.freeze({ planCanonical, intentCanonical, intent });
  }

  return Object.freeze({
    async prepare({
      intentId,
      operator,
      approvedAt,
      confirmation,
      backupRestoreReferenceCanonical,
    }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_INVOICE_0108_CONFIRMATION,
        "prepare.confirmation",
      );
      await loadPinnedSql();
      const boundary = new Date(approvedAt);
      const backup = parseProductionInvoice0108BackupReference(
        backupRestoreReferenceCanonical,
        { at: boundary },
      );
      await backupAuthority.assertFreshExact0107BackupRestoreReceipt({
        referenceCanonical: backup.artifact.canonical,
        at: boundary.toISOString(),
        expectedInventorySha256:
          "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
      });
      const live = await database.readInventoryReadOnly();
      validateProductionInvoice0108Inventory(live, "pre");
      const plan = createProductionInvoice0108Plan({
        sourceSha,
        backupRestoreReferenceCanonical: backup.artifact.canonical,
        createdAt: approvedAt,
      });
      const intent = createProductionInvoice0108Intent({
        planCanonical: plan.canonical,
        intentId,
        operator,
        createdAt: approvedAt,
        confirmation,
      });
      const planStorageId = `invoice-0108-plan-${plan.sha256.slice(7, 23)}.json`;
      const intentStorageId = `invoice-0108-intent-${intentId.slice(0, 16)}.json`;
      await persistAndReadback(artifacts, planStorageId, plan.canonical);
      await persistAndReadback(artifacts, intentStorageId, intent.canonical);
      return Object.freeze({
        decision: "DURABLE_INTENT_PREPARED",
        planStorageId,
        intentStorageId,
        planSha256: plan.sha256,
        intentSha256: intent.sha256,
        authorizesApplicationStart: false,
      });
    },

    async inspect({
      planStorageId,
      intentStorageId,
      migrationReceiptStorageId,
      roleReceiptStorageId,
    }) {
      const durable = await loadDurable(planStorageId, intentStorageId);
      const migrationReceiptCanonical = migrationReceiptStorageId
        ? await artifacts.readOptionalCanonical(
            exactStorageId(
              migrationReceiptStorageId,
              "migrationReceiptStorageId",
            ),
          )
        : null;
      const roleReceiptCanonical = roleReceiptStorageId
        ? await artifacts.readOptionalCanonical(
            exactStorageId(roleReceiptStorageId, "roleReceiptStorageId"),
          )
        : null;
      const inventory = await database.readInventoryReadOnly();
      return classifyProductionInvoice0108Recovery({
        planCanonical: durable.planCanonical,
        intentCanonical: durable.intentCanonical,
        migrationReceiptCanonical,
        roleReceiptCanonical,
        inventory,
      });
    },

    async apply({ planStorageId, intentStorageId, confirmation }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_INVOICE_0108_CONFIRMATION,
        "apply.confirmation",
      );
      const durable = await loadDurable(planStorageId, intentStorageId);
      const plan = parseProductionInvoice0108Plan(durable.planCanonical);
      const boundary = now();
      parseProductionInvoice0108BackupReference(
        plan.value.backupRestoreReferenceCanonical,
        { at: boundary },
      );
      await backupAuthority.assertFreshExact0107BackupRestoreReceipt({
        referenceCanonical: plan.value.backupRestoreReferenceCanonical,
        at: boundary.toISOString(),
        expectedInventorySha256:
          "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
      });
      const receiptStorageId = `invoice-0108-receipt-${durable.intent.value.intentId.slice(0, 16)}.json`;
      if ((await artifacts.readOptionalCanonical(receiptStorageId)) !== null) {
        fail(
          "ALREADY_ATTEMPTED",
          "Durable migration receipt already exists; inspect instead of retrying.",
        );
      }
      const initial = await database.readInventoryReadOnly();
      validateProductionInvoice0108Inventory(initial, "pre");
      const canonicalSql = await loadPinnedSql();
      const statements = splitExact0108Statements(canonicalSql);
      const client = await database.connect();
      let transactionOpen = false;
      let commitStarted = false;
      let commitSucceeded = false;
      let released = false;
      const release = async (destroy = false) => {
        if (released) return;
        released = true;
        await releaseClient(client, destroy);
      };
      let before;
      let after;
      const startedAt = now().toISOString();
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL statement_timeout = '30min'");
        await client.query(
          "SET LOCAL idle_in_transaction_session_timeout = '35min'",
        );
        await database.assertMigrationAuthorityInTransaction(client, {
          sourceSha: plan.value.sourceSha,
          migration: PRODUCTION_INVOICE_0108_MIGRATION,
        });
        await client.query("SELECT pg_advisory_xact_lock($1::integer)", [
          PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY,
        ]);
        before = await database.readInventoryInTransaction(client);
        validateProductionInvoice0108Inventory(before, "pre");
        for (const statement of statements) await client.query(statement);
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1::text, $2::bigint)",
          [
            PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
            PRODUCTION_INVOICE_0108_MIGRATION.when,
          ],
        );
        after = await database.readInventoryInTransaction(client);
        validateProductionInvoice0108Inventory(after, "post");
        commitStarted = true;
        await client.query("COMMIT");
        commitSucceeded = true;
        transactionOpen = false;
        await release();
      } catch (error) {
        if (commitStarted && !commitSucceeded) {
          await release(true);
          productionInvoice0108RestoreRequired(
            "RESTORE_REQUIRED_COMMIT_OUTCOME_UNKNOWN",
            "0108 COMMIT outcome is ambiguous; do not retry and restore from the fresh exact-0107 backup.",
            { cause: error },
          );
        }
        if (commitSucceeded) {
          await release();
          productionInvoice0108RestoreRequired(
            "RESTORE_REQUIRED_POST_COMMIT_EVIDENCE_INVALID",
            "0108 committed but post-commit evidence is incomplete.",
            { cause: error },
          );
        }
        if (transactionOpen) {
          try {
            await client.query("ROLLBACK");
            transactionOpen = false;
          } catch (rollbackError) {
            await release(true);
            productionInvoice0108RestoreRequired(
              "RESTORE_REQUIRED_ROLLBACK_OUTCOME_UNKNOWN",
              "Pre-commit rollback outcome is ambiguous; restore review is required.",
              { cause: rollbackError },
            );
          }
        }
        await release();
        throw error;
      } finally {
        if (!released && !commitStarted) await release();
      }

      let receipt;
      try {
        const committed = await database.readInventoryReadOnly();
        validateProductionInvoice0108Inventory(committed, "post");
        if (!sameInventory(committed, after)) {
          productionInvoice0108RestoreRequired(
            "RESTORE_REQUIRED_POST_COMMIT_INVENTORY_DRIFT",
            "Committed inventory differs from the locked in-transaction exact-0108 state.",
          );
        }
        const completedAt = now().toISOString();
        receipt = createProductionInvoice0108Receipt({
          planCanonical: durable.planCanonical,
          intentCanonical: durable.intentCanonical,
          before,
          after,
          transactionStartedAt: startedAt,
          transactionCompletedAt: completedAt,
        });
      } catch (error) {
        if (error?.restoreRequired) throw error;
        productionInvoice0108RestoreRequired(
          "RESTORE_REQUIRED_POST_COMMIT_EVIDENCE_INVALID",
          "0108 committed but exact post-commit inventory or receipt evidence is unavailable.",
          { cause: error },
        );
      }
      try {
        await persistAndReadback(
          artifacts,
          receiptStorageId,
          receipt.canonical,
        );
      } catch (error) {
        productionInvoice0108RestoreRequired(
          "RESTORE_REQUIRED_UNKNOWN_COMMIT",
          "0108 committed but its exclusive durable receipt is not confirmed; do not retry.",
          { cause: error },
        );
      }
      return Object.freeze({
        decision: "MIGRATION_COMMITTED_RECEIPT_DURABLE",
        receiptStorageId,
        receiptSha256: receipt.sha256,
        roleDeltaRequired: true,
        authorizesApplicationStart: false,
      });
    },

    async applyRoleDelta({
      planStorageId,
      intentStorageId,
      migrationReceiptStorageId,
      confirmation,
    }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
        "role.confirmation",
      );
      const durable = await loadDurable(planStorageId, intentStorageId);
      const migrationId = exactStorageId(
        migrationReceiptStorageId,
        "migrationReceiptStorageId",
      );
      const migrationReceiptCanonical =
        await artifacts.readCanonical(migrationId);
      parseProductionInvoice0108Receipt(
        migrationReceiptCanonical,
        durable.planCanonical,
        durable.intentCanonical,
      );
      const live = await database.readInventoryReadOnly();
      validateProductionInvoice0108Inventory(live, "post");
      const roleReceiptStorageId = `invoice-0108-role-${durable.intent.value.intentId.slice(0, 16)}.json`;
      if (
        (await artifacts.readOptionalCanonical(roleReceiptStorageId)) !== null
      ) {
        fail(
          "ROLE_ALREADY_ATTEMPTED",
          "Role delta receipt already exists; inspect instead of retrying.",
        );
      }
      await roleAuthority.assertExact0108Contract({
        migration: PRODUCTION_INVOICE_0108_MIGRATION.tag,
        migrationSha256: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
        requiredPreState: "exact-0107-plus-0108-default-dark",
      });
      let roleReceiptCanonical;
      try {
        roleReceiptCanonical = await roleAuthority.applyExact0108Delta({
          migrationReceiptCanonical,
          confirmation,
        });
      } catch (error) {
        if (error?.commitOutcomeUnknown || error?.restoreRequired) {
          productionInvoice0108RestoreRequired(
            "RESTORE_REQUIRED_ROLE_COMMIT_OUTCOME_UNKNOWN",
            "0108 role delta commit outcome is ambiguous; do not retry.",
            { cause: error },
          );
        }
        throw error;
      }
      let roleReceipt;
      try {
        roleReceipt = parseProductionInvoice0108RoleReceipt(
          roleReceiptCanonical,
          migrationReceiptCanonical,
        );
      } catch (error) {
        productionInvoice0108RestoreRequired(
          "RESTORE_REQUIRED_ROLE_POST_COMMIT_EVIDENCE_INVALID",
          "Role authority returned invalid post-commit evidence; do not retry.",
          { cause: error },
        );
      }
      try {
        await persistAndReadback(
          artifacts,
          roleReceiptStorageId,
          roleReceipt.artifact.canonical,
        );
      } catch (error) {
        productionInvoice0108RestoreRequired(
          "RESTORE_REQUIRED_ROLE_RECEIPT_CUSTODY",
          "Role delta committed but its exclusive durable receipt is not confirmed.",
          { cause: error },
        );
      }
      return Object.freeze({
        decision: "ROLE_DELTA_COMMITTED_RECEIPT_DURABLE",
        roleReceiptStorageId,
        roleReceiptSha256: roleReceipt.artifact.sha256,
        authorizesApplicationStart: false,
      });
    },
  });
}
