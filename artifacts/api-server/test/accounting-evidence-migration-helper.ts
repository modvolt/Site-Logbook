import type { Pool } from "pg";

const EXPECTED_TABLES = [
  "accounting_aggregate_heads",
  "accounting_document_versions",
  "accounting_export_outbox",
  "accounting_lifecycle_events",
  "accounting_payment_events",
  "accounting_reason_artifacts",
  "accounting_version_relations",
  "accounting_warehouse_price_observations",
  "accounting_warehouse_price_projection_heads",
] as const;

const EXPECTED_TRIGGERS = [
  "accounting_aggregate_heads_guard_trg",
  "accounting_document_versions_immutable_trg",
  "accounting_export_outbox_guard_trg",
  "accounting_lifecycle_events_binding_trg",
  "accounting_lifecycle_events_immutable_trg",
  "accounting_payment_events_binding_trg",
  "accounting_payment_events_immutable_trg",
  "accounting_reason_artifacts_binding_trg",
  "accounting_reason_artifacts_immutable_trg",
  "accounting_version_relations_immutable_trg",
  "accounting_warehouse_price_observations_binding_trg",
  "accounting_warehouse_price_observations_immutable_trg",
  "accounting_warehouse_price_projection_heads_guard_trg",
] as const;

const EXPECTED_FUNCTIONS = [
  "deny_accounting_evidence_mutation",
  "guard_accounting_aggregate_head_transition",
  "guard_accounting_evidence_insert_binding",
  "guard_accounting_outbox_transition",
  "guard_accounting_warehouse_price_projection_head",
] as const;

export async function assertAccountingEvidenceMigrationInstalled(
  pool: Pool,
): Promise<void> {
  const result = await pool.query<{
    tables: string[];
    triggers: string[];
    functions: string[];
  }>(`
    select
      array(
        select tablename::text
        from pg_tables
        where schemaname = 'public' and tablename like 'accounting_%'
        order by tablename
      ) as tables,
      array(
        select trigger_name::text
        from information_schema.triggers
        where trigger_schema = 'public' and event_object_table like 'accounting_%'
        group by trigger_name
        order by trigger_name
      ) as triggers,
      array(
        select distinct routine_name::text
        from information_schema.routines
        where routine_schema = 'public'
          and routine_name in (
            'deny_accounting_evidence_mutation',
            'guard_accounting_aggregate_head_transition',
            'guard_accounting_evidence_insert_binding',
            'guard_accounting_outbox_transition',
            'guard_accounting_warehouse_price_projection_head'
          )
        order by routine_name
      ) as functions
  `);
  const installed = result.rows[0];
  if (
    !installed ||
    JSON.stringify(installed.tables) !== JSON.stringify(EXPECTED_TABLES) ||
    JSON.stringify(installed.triggers) !== JSON.stringify(EXPECTED_TRIGGERS) ||
    JSON.stringify(installed.functions) !== JSON.stringify(EXPECTED_FUNCTIONS)
  ) {
    throw new Error(
      `R13 accounting evidence migration is incomplete: ${JSON.stringify(installed)}`,
    );
  }
}
