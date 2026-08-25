import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  INVOICE_0108_KNOWN_ROWS_SHA256,
  INVOICE_0108_MIGRATION,
  INVOICE_0108_SNAPSHOT,
  classifyObservedInvoice0108DefaultKind,
  loadAndValidateInvoice0108MigrationBundle,
  validateInvoice0108SchemaObservation,
  type Invoice0108SchemaObservation,
} from "./invoice-0108-schema-preflight.js";

const migrationsDir = path.resolve(import.meta.dirname, "../migrations");

test("classifies PostgreSQL numeric defaults as pinned literals", () => {
  assert.equal(
    classifyObservedInvoice0108DefaultKind(
      "billing_settings",
      "advance_number_next_seq",
      "1",
    ),
    "literal:1",
  );
  assert.equal(
    classifyObservedInvoice0108DefaultKind(
      "billing_settings",
      "advance_number_next_seq",
      "next_invoice_number()",
    ),
    "unsupported:next_invoice_number()",
  );
});

function exactObservation(): Invoice0108SchemaObservation {
  const bundle = loadAndValidateInvoice0108MigrationBundle(migrationsDir);
  return {
    columns: bundle.projection.columns,
    constraintNames: bundle.projection.constraintNames,
    indexNames: bundle.projection.indexNames,
    sequenceNames: bundle.projection.sequenceNames,
    allocationTableOwner: "site_logbook_migrator",
    allocationSequenceOwner: "site_logbook_migrator",
    runtimeRole: "site_logbook_runtime",
    runtimeTableSelect: true,
    runtimeTableInsert: true,
    runtimeTableUpdate: true,
    runtimeTableDelete: false,
    runtimeSequenceUsage: true,
    publicTablePrivileges: false,
    publicSequencePrivileges: false,
  };
}

test("pins the exact 0108 journal, canonical-LF SQL, snapshot chain and delta projection", () => {
  const bundle = loadAndValidateInvoice0108MigrationBundle(migrationsDir);
  assert.deepEqual(bundle.migration, INVOICE_0108_MIGRATION);
  assert.equal(bundle.snapshotSha256, `sha256:${INVOICE_0108_SNAPSHOT.sha256}`);
  assert.equal(bundle.projection.columns.length, 33);
  assert.equal(
    bundle.projection.columns.filter(
      (column) => column.table === "invoice_source_allocations",
    ).length,
    23,
  );
  assert.equal(bundle.projection.constraintNames.length, 12);
  assert.equal(bundle.projection.indexNames.length, 7);
  assert.deepEqual(bundle.projection.sequenceNames, [
    "invoice_source_allocations_id_seq",
  ]);
  assert.match(bundle.projectionSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    INVOICE_0108_KNOWN_ROWS_SHA256,
    "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281",
  );
});

test("accepts only the exact schema and least-privilege 0108 role delta", () => {
  const bundle = loadAndValidateInvoice0108MigrationBundle(migrationsDir);
  assert.deepEqual(validateInvoice0108SchemaObservation(exactObservation(), bundle), {
    projectionSha256: bundle.projectionSha256,
    roleDeltaReady: true,
  });
  const missing = exactObservation();
  assert.throws(
    () =>
      validateInvoice0108SchemaObservation(
        { ...missing, columns: missing.columns.slice(1) },
        bundle,
      ),
    (error: unknown) =>
      (error as { code?: unknown }).code === "INVOICE_0108_SCHEMA_DRIFT",
  );
  const excessive = exactObservation();
  assert.throws(
    () =>
      validateInvoice0108SchemaObservation(
        { ...excessive, runtimeTableDelete: true },
        bundle,
      ),
    (error: unknown) =>
      (error as { code?: unknown }).code === "INVOICE_0108_ROLE_DRIFT",
  );
});
