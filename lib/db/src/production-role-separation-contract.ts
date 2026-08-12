import { createHash } from "node:crypto";

export const PRODUCTION_ROLE_CONTRACT_SCHEMA =
  "site-logbook.production-db-role-separation/v1" as const;
export const PRODUCTION_ROLE_PLAN_SCHEMA =
  "site-logbook.production-db-role-separation-plan/v1" as const;
export const PRODUCTION_ROLE_RECEIPT_SCHEMA =
  "site-logbook.production-db-role-separation-receipt/v1" as const;
export const PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA =
  "site-logbook.production-db-role-separation-postcommit/v1" as const;
export const PRODUCTION_ROLE_MAX_ARTIFACT_BYTES = 512 * 1024;
export const ROLE_CONTRACT_MIGRATION = "0107_canonical_audit_evidence" as const;
export const ROLE_CONTRACT_MIGRATION_SHA256 =
  "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122" as const;

const READ = ["SELECT"] as const;
const APPEND = ["SELECT", "INSERT"] as const;
const MUTABLE = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const STATEFUL = ["SELECT", "INSERT", "UPDATE"] as const;
const INSERT_DELETE = ["SELECT", "INSERT", "DELETE"] as const;
const SELECT_UPDATE = ["SELECT", "UPDATE"] as const;
const SELECT_DELETE = ["SELECT", "DELETE"] as const;
const NO_ACCESS = [] as const;
const SAFE_SEARCH_PATH_SETTING =
  "search_path=pg_catalog, public, pg_temp" as const;
const DATABASE_PUBLIC_PRIVILEGES = ["CONNECT"] as const;
const DATABASE_RUNTIME_PRIVILEGES = ["CONNECT"] as const;

const narrowerMutableDml: Readonly<Record<string, readonly TablePrivilege[]>> =
  {
    activity_attachments: INSERT_DELETE,
    backup_settings: STATEFUL,
    billing_document_files: STATEFUL,
    billing_document_merge_members: STATEFUL,
    billing_document_merges: STATEFUL,
    billing_settings: STATEFUL,
    client_errors: INSERT_DELETE,
    document_linking_settings: STATEFUL,
    email_import_accounts: STATEFUL,
    email_import_attachments: STATEFUL,
    email_import_log: STATEFUL,
    email_import_messages: STATEFUL,
    email_import_settings: STATEFUL,
    email_settings: STATEFUL,
    extraction_jobs: STATEFUL,
    health_log: APPEND,
    invoice_reminders: APPEND,
    invoice_source_links: INSERT_DELETE,
    job_assignees: INSERT_DELETE,
    job_groups: MUTABLE,
    job_visits: STATEFUL,
    jobs: STATEFUL,
    leave_settings: STATEFUL,
    object_uploads: STATEFUL,
    openai_settings: STATEFUL,
    operational_incident_events: APPEND,
    operational_incidents: STATEFUL,
    person_hourly_rates: STATEFUL,
    ppe_handover_documents: STATEFUL,
    ppe_handover_events: APPEND,
    ppe_items: STATEFUL,
    public_access_tokens: STATEFUL,
    quote_invoice_links: STATEFUL,
    quote_items: INSERT_DELETE,
    recurring_invoice_generations: APPEND,
    security_questions: SELECT_DELETE,
    supplier_parser_profiles: READ,
    switchboard_checklist_instances: STATEFUL,
    switchboard_checklist_responses: STATEFUL,
    switchboard_checklist_templates: STATEFUL,
    switchboard_checklist_template_versions: APPEND,
    switchboard_defects: STATEFUL,
    switchboard_documents: STATEFUL,
    switchboard_events: APPEND,
    switchboard_field_registry: SELECT_UPDATE,
    switchboard_label_versions: STATEFUL,
    switchboard_measurements: APPEND,
    switchboard_photos: APPEND,
    switchboard_processing_jobs: STATEFUL,
    switchboard_protocol_versions: STATEFUL,
    switchboard_qr_access_logs: APPEND,
    switchboard_service_records: NO_ACCESS,
    switchboards: STATEFUL,
    user_permission_overrides: INSERT_DELETE,
    user_preferences: STATEFUL,
    users: STATEFUL,
    warehouse_movements: STATEFUL,
    warehouse_price_history: MUTABLE,
    work_session_billing_links: STATEFUL,
    work_session_breaks: SELECT_UPDATE,
    work_session_events: APPEND,
    work_sessions: STATEFUL,
  };

export type TablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER";
export type SequencePrivilege = "USAGE" | "SELECT" | "UPDATE";
export type FunctionPrivilege = "EXECUTE";

export interface RequiredTableGrant {
  readonly schema: "public" | "drizzle";
  readonly name: string;
  readonly privileges: readonly TablePrivilege[];
}

export interface RequiredSequenceGrant {
  readonly schema: "public" | "drizzle";
  readonly name: string;
  readonly privileges: readonly SequencePrivilege[];
}

export interface RequiredFunctionGrant {
  readonly schema: "public";
  readonly name: string;
  readonly identityArguments: string;
  readonly privileges: readonly FunctionPrivilege[];
}

const mutableTableNames = [
  "activities",
  "activity_attachments",
  "activity_extra_works",
  "activity_materials",
  "activity_visits",
  "api_idempotency_records",
  "attachments",
  "audit_log",
  "backup_log",
  "backup_settings",
  "billing_document_files",
  "billing_document_lines",
  "billing_document_merge_members",
  "billing_document_merges",
  "billing_document_references",
  "billing_documents",
  "billing_settings",
  "client_errors",
  "customer_contacts",
  "customer_site_attachments",
  "customer_sites",
  "customers",
  "device_credentials",
  "document_linking_settings",
  "email_import_accounts",
  "email_import_attachments",
  "email_import_log",
  "email_import_messages",
  "email_import_settings",
  "email_settings",
  "employee_leaves",
  "extraction_jobs",
  "health_log",
  "invoice_lines",
  "invoice_reminders",
  "invoice_source_links",
  "invoices",
  "job_assignees",
  "job_groups",
  "job_visits",
  "jobs",
  "leave_settings",
  "machines",
  "material_markup_rules",
  "materials",
  "object_uploads",
  "openai_settings",
  "operational_incident_events",
  "operational_incidents",
  "people",
  "person_hourly_rates",
  "ppe_assignments",
  "ppe_handover_documents",
  "ppe_handover_events",
  "ppe_items",
  "public_access_tokens",
  "quote_invoice_links",
  "quote_items",
  "quotes",
  "recurring_invoice_generations",
  "recurring_invoice_templates",
  "security_questions",
  "supplier_parser_profiles",
  "switchboard_assignees",
  "switchboard_checklist_instances",
  "switchboard_checklist_responses",
  "switchboard_checklist_template_versions",
  "switchboard_checklist_templates",
  "switchboard_defects",
  "switchboard_documents",
  "switchboard_events",
  "switchboard_extracted_fields",
  "switchboard_field_registry",
  "switchboard_label_versions",
  "switchboard_measurements",
  "switchboard_photos",
  "switchboard_processing_jobs",
  "switchboard_protocol_versions",
  "switchboard_qr_access_logs",
  "switchboard_service_records",
  "switchboards",
  "tasks",
  "time_entries",
  "user_permission_overrides",
  "user_preferences",
  "user_sessions",
  "users",
  "warehouse_items",
  "warehouse_movements",
  "warehouse_price_history",
  "webauthn_credentials",
  "work_session_billing_links",
  "work_session_breaks",
  "work_session_events",
  "work_sessions",
] as const;

const appendOnlyTableNames = [
  "accounting_document_versions",
  "accounting_lifecycle_events",
  "accounting_payment_events",
  "accounting_reason_artifacts",
  "accounting_version_relations",
  "accounting_warehouse_price_observations",
  "audit_events",
  "external_account_events",
  "job_signature_events",
  "ppe_public_evidence_events",
  "ppe_public_evidence_versions",
  "quote_decision_events",
  "quote_versions",
] as const;

const statefulEvidenceTableNames = [
  "accounting_aggregate_heads",
  "accounting_export_outbox",
  "accounting_warehouse_price_projection_heads",
  "audit_export_outbox",
  "external_account_scopes",
  "external_accounts",
  "job_document_versions",
  "operational_alert_outbox",
] as const;

export const REQUIRED_TABLE_GRANTS: readonly RequiredTableGrant[] = [
  ...appendOnlyTableNames.map((name) => ({
    schema: "public" as const,
    name,
    privileges: APPEND,
  })),
  ...statefulEvidenceTableNames.map((name) => ({
    schema: "public" as const,
    name,
    privileges: STATEFUL,
  })),
  ...mutableTableNames.map((name) => ({
    schema: "public" as const,
    name,
    privileges: narrowerMutableDml[name] ?? MUTABLE,
  })),
  {
    schema: "public" as const,
    name: "audit_chain_heads",
    privileges: SELECT_UPDATE,
  },
  {
    schema: "drizzle" as const,
    name: "__drizzle_migrations",
    privileges: READ,
  },
].sort((left, right) => {
  const leftKey = `${left.schema}.${left.name}`;
  const rightKey = `${right.schema}.${right.name}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
});

const requiredSequenceNames = [
  "activities_id_seq",
  "activity_attachments_id_seq",
  "activity_extra_works_id_seq",
  "activity_materials_id_seq",
  "activity_visits_id_seq",
  "api_idempotency_records_id_seq",
  "attachments_id_seq",
  "audit_log_id_seq",
  "backup_log_id_seq",
  "billing_document_files_id_seq",
  "billing_document_lines_id_seq",
  "billing_document_merge_members_id_seq",
  "billing_document_merges_id_seq",
  "billing_document_references_id_seq",
  "billing_documents_id_seq",
  "client_errors_id_seq",
  "customer_contacts_id_seq",
  "customer_site_attachments_id_seq",
  "customer_sites_id_seq",
  "customers_id_seq",
  "device_credentials_id_seq",
  "email_import_accounts_id_seq",
  "email_import_attachments_id_seq",
  "email_import_log_id_seq",
  "email_import_messages_id_seq",
  "employee_leaves_id_seq",
  "external_account_events_id_seq",
  "external_account_scopes_id_seq",
  "extraction_jobs_id_seq",
  "health_log_id_seq",
  "invoice_lines_id_seq",
  "invoice_reminders_id_seq",
  "invoice_source_links_id_seq",
  "invoices_id_seq",
  "job_assignees_id_seq",
  "job_document_versions_id_seq",
  "job_groups_id_seq",
  "job_number_seq",
  "job_signature_events_id_seq",
  "job_visits_id_seq",
  "jobs_id_seq",
  "machines_id_seq",
  "material_markup_rules_id_seq",
  "materials_id_seq",
  "operational_alert_outbox_id_seq",
  "operational_incident_events_id_seq",
  "operational_incidents_id_seq",
  "people_id_seq",
  "person_hourly_rates_id_seq",
  "ppe_assignments_id_seq",
  "ppe_handover_documents_id_seq",
  "ppe_handover_events_id_seq",
  "ppe_items_id_seq",
  "ppe_public_evidence_events_id_seq",
  "ppe_public_evidence_versions_id_seq",
  "public_access_tokens_id_seq",
  "quote_decision_events_id_seq",
  "quote_invoice_links_id_seq",
  "quote_items_id_seq",
  "quote_versions_id_seq",
  "quotes_id_seq",
  "recurring_invoice_generations_id_seq",
  "recurring_invoice_templates_id_seq",
  "security_questions_id_seq",
  "supplier_parser_profiles_id_seq",
  "switchboard_assignees_id_seq",
  "switchboard_checklist_instances_id_seq",
  "switchboard_checklist_responses_id_seq",
  "switchboard_checklist_template_versions_id_seq",
  "switchboard_checklist_templates_id_seq",
  "switchboard_defects_id_seq",
  "switchboard_documents_id_seq",
  "switchboard_events_id_seq",
  "switchboard_extracted_fields_id_seq",
  "switchboard_field_registry_id_seq",
  "switchboard_label_versions_id_seq",
  "switchboard_measurements_id_seq",
  "switchboard_photos_id_seq",
  "switchboard_processing_jobs_id_seq",
  "switchboard_protocol_versions_id_seq",
  "switchboard_qr_access_logs_id_seq",
  "switchboard_service_records_id_seq",
  "switchboards_id_seq",
  "tasks_id_seq",
  "time_entries_id_seq",
  "users_id_seq",
  "warehouse_items_id_seq",
  "warehouse_movements_id_seq",
  "warehouse_price_history_id_seq",
  "webauthn_credentials_id_seq",
  "work_session_billing_links_id_seq",
  "work_session_breaks_id_seq",
  "work_session_events_id_seq",
  "work_sessions_id_seq",
] as const;

export const REQUIRED_SEQUENCE_GRANTS: readonly RequiredSequenceGrant[] = [
  ...requiredSequenceNames.map((name) => {
    const tableName =
      name === "job_number_seq" ? "jobs" : name.replace(/_id_seq$/, "");
    const table = REQUIRED_TABLE_GRANTS.find(
      (grant) => grant.schema === "public" && grant.name === tableName,
    );
    return {
      schema: "public" as const,
      name,
      privileges: table?.privileges.includes("INSERT")
        ? (["USAGE"] as const)
        : NO_ACCESS,
    };
  }),
  {
    schema: "drizzle",
    name: "__drizzle_migrations_id_seq",
    privileges: [],
  },
];

const requiredFunctions = [
  ["audit_canonical_json", "jsonb"],
  ["audit_domain_sha256", "text, text"],
  ["audit_event_core_semantics_are_valid", "jsonb"],
  ["audit_event_json_is_valid", "jsonb"],
  ["audit_export_intent_json_is_valid", "jsonb"],
  ["audit_json_has_exact_keys", "jsonb, text[]"],
  ["audit_json_is_safe_integer", "jsonb, numeric, numeric"],
  ["audit_json_is_sha256", "jsonb"],
  ["audit_json_is_string_or_null", "jsonb"],
  ["audit_ledger_json_is_valid", "jsonb"],
  ["audit_state_json_is_valid", "jsonb"],
  ["deny_accounting_evidence_mutation", ""],
  ["deny_audit_event_mutation", ""],
  ["deny_external_ledger_delete", ""],
  ["deny_immutable_evidence_mutation", ""],
  ["guard_accounting_aggregate_head_transition", ""],
  ["guard_accounting_evidence_insert_binding", ""],
  ["guard_accounting_outbox_transition", ""],
  ["guard_accounting_warehouse_price_projection_head", ""],
  ["guard_audit_event_commit_binding", ""],
  ["guard_audit_event_insert", ""],
  ["guard_audit_export_outbox_transition", ""],
  ["guard_audit_chain_head_transition", ""],
  ["guard_external_identity_row", ""],
  ["guard_job_document_version_transition", ""],
  ["reject_external_permission_override", ""],
  ["validate_external_account_row", ""],
  ["validate_external_account_scope_row", ""],
  ["validate_ppe_public_evidence_event_binding", ""],
] as const;

export const REQUIRED_FUNCTION_GRANTS: readonly RequiredFunctionGrant[] =
  requiredFunctions.map(([name, identityArguments]) => ({
    schema: "public",
    name,
    identityArguments,
    privileges: ["EXECUTE"],
  }));

export interface ProjectedRole {
  readonly name: string;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
}

export interface ProjectedAclGrant {
  readonly grantee: string;
  readonly privileges: readonly string[];
}

export interface ProjectedColumnGrant extends ProjectedAclGrant {
  readonly column: string;
}

export interface ProjectedSchema {
  readonly name: string;
  readonly owner: string;
  readonly publicPrivileges: readonly string[];
  readonly runtimePrivileges: readonly string[];
  readonly otherGrants: readonly ProjectedAclGrant[];
}

export interface ProjectedObject {
  readonly kind: "table" | "sequence" | "function";
  readonly schema: "public" | "drizzle";
  readonly name: string;
  readonly identityArguments: string;
  readonly owner: string;
  readonly securityDefiner: boolean;
  readonly functionSettings: readonly string[];
  readonly publicPrivileges: readonly string[];
  readonly runtimePrivileges: readonly string[];
  readonly otherGrants: readonly ProjectedAclGrant[];
  readonly columnGrants: readonly ProjectedColumnGrant[];
}

export interface ProjectedDefaultPrivilege {
  readonly schema: "public" | "drizzle";
  readonly kind: "table" | "sequence" | "function";
  readonly owner: string;
  readonly publicPrivileges: readonly string[];
  readonly runtimePrivileges: readonly string[];
  readonly otherGrants: readonly ProjectedAclGrant[];
}

export interface ProductionRoleProjection {
  readonly schemaVersion: typeof PRODUCTION_ROLE_CONTRACT_SCHEMA;
  readonly migration: typeof ROLE_CONTRACT_MIGRATION;
  readonly migrationSha256: typeof ROLE_CONTRACT_MIGRATION_SHA256;
  readonly databaseName: string;
  readonly databaseOwner: string;
  readonly databasePublicPrivileges: readonly string[];
  readonly databaseRuntimePrivileges: readonly string[];
  readonly databaseOtherGrants: readonly ProjectedAclGrant[];
  readonly runtimeRole: ProjectedRole;
  readonly migratorRole: ProjectedRole;
  readonly runtimeMemberOf: readonly string[];
  readonly migratorMemberOf: readonly string[];
  readonly runtimeRoleMembers: readonly string[];
  readonly migratorRoleMembers: readonly string[];
  readonly runtimeGlobalSettings: readonly string[];
  readonly runtimeDatabaseSettings: readonly string[];
  readonly schemas: readonly ProjectedSchema[];
  readonly defaultPrivileges: readonly ProjectedDefaultPrivilege[];
  readonly objects: readonly ProjectedObject[];
}

export interface RoleContractError {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
}

export interface RoleContractValidation {
  readonly ok: boolean;
  readonly errors: readonly RoleContractError[];
}

function keyForObject(
  value: Pick<
    ProjectedObject,
    "kind" | "schema" | "name" | "identityArguments"
  >,
): string {
  return `${value.kind}:${value.schema}.${value.name}(${value.identityArguments})`;
}

function canonicalPrivileges(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))].sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const lhs = canonicalPrivileges(left);
  const rhs = canonicalPrivileges(right);
  return (
    lhs.length === rhs.length &&
    lhs.every((value, index) => value === rhs[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

const roleKeys = [
  "name",
  "login",
  "superuser",
  "createDatabase",
  "createRole",
  "replication",
  "bypassRls",
] as const;
const aclGrantKeys = ["grantee", "privileges"] as const;
const columnGrantKeys = ["column", "grantee", "privileges"] as const;
const schemaKeys = [
  "name",
  "owner",
  "publicPrivileges",
  "runtimePrivileges",
  "otherGrants",
] as const;
const defaultPrivilegeKeys = [
  "schema",
  "kind",
  "owner",
  "publicPrivileges",
  "runtimePrivileges",
  "otherGrants",
] as const;
const objectKeys = [
  "kind",
  "schema",
  "name",
  "identityArguments",
  "owner",
  "securityDefiner",
  "functionSettings",
  "publicPrivileges",
  "runtimePrivileges",
  "otherGrants",
  "columnGrants",
] as const;
const projectionKeys = [
  "schemaVersion",
  "migration",
  "migrationSha256",
  "databaseName",
  "databaseOwner",
  "databasePublicPrivileges",
  "databaseRuntimePrivileges",
  "databaseOtherGrants",
  "runtimeRole",
  "migratorRole",
  "runtimeMemberOf",
  "migratorMemberOf",
  "runtimeRoleMembers",
  "migratorRoleMembers",
  "runtimeGlobalSettings",
  "runtimeDatabaseSettings",
  "schemas",
  "defaultPrivileges",
  "objects",
] as const;

function isProjectedRole(value: unknown): value is ProjectedRole {
  if (!isRecord(value) || !hasExactKeys(value, roleKeys)) return false;
  return (
    typeof value.name === "string" &&
    [
      value.login,
      value.superuser,
      value.createDatabase,
      value.createRole,
      value.replication,
      value.bypassRls,
    ].every((flag) => typeof flag === "boolean")
  );
}

function isAclGrant(value: unknown): value is ProjectedAclGrant {
  return (
    isRecord(value) &&
    hasExactKeys(value, aclGrantKeys) &&
    typeof value.grantee === "string" &&
    isStringArray(value.privileges)
  );
}

function isColumnGrant(value: unknown): value is ProjectedColumnGrant {
  return (
    isRecord(value) &&
    hasExactKeys(value, columnGrantKeys) &&
    typeof value.column === "string" &&
    typeof value.grantee === "string" &&
    isStringArray(value.privileges)
  );
}

function isStrictProductionRoleProjection(
  value: unknown,
): value is ProductionRoleProjection {
  if (!isRecord(value) || !hasExactKeys(value, projectionKeys)) return false;
  if (
    typeof value.schemaVersion !== "string" ||
    typeof value.migration !== "string" ||
    typeof value.migrationSha256 !== "string" ||
    typeof value.databaseName !== "string" ||
    typeof value.databaseOwner !== "string" ||
    !isStringArray(value.databasePublicPrivileges) ||
    !isStringArray(value.databaseRuntimePrivileges) ||
    !Array.isArray(value.databaseOtherGrants) ||
    !value.databaseOtherGrants.every(isAclGrant) ||
    !isProjectedRole(value.runtimeRole) ||
    !isProjectedRole(value.migratorRole) ||
    !isStringArray(value.runtimeMemberOf) ||
    !isStringArray(value.migratorMemberOf) ||
    !isStringArray(value.runtimeRoleMembers) ||
    !isStringArray(value.migratorRoleMembers) ||
    !isStringArray(value.runtimeGlobalSettings) ||
    !isStringArray(value.runtimeDatabaseSettings) ||
    !Array.isArray(value.schemas) ||
    !Array.isArray(value.defaultPrivileges) ||
    !Array.isArray(value.objects)
  ) {
    return false;
  }
  if (
    !value.schemas.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, schemaKeys) &&
        typeof entry.name === "string" &&
        typeof entry.owner === "string" &&
        isStringArray(entry.publicPrivileges) &&
        isStringArray(entry.runtimePrivileges) &&
        Array.isArray(entry.otherGrants) &&
        entry.otherGrants.every(isAclGrant),
    )
  ) {
    return false;
  }
  if (
    !value.defaultPrivileges.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, defaultPrivilegeKeys) &&
        (entry.schema === "public" || entry.schema === "drizzle") &&
        ["table", "sequence", "function"].includes(String(entry.kind)) &&
        typeof entry.owner === "string" &&
        isStringArray(entry.publicPrivileges) &&
        isStringArray(entry.runtimePrivileges) &&
        Array.isArray(entry.otherGrants) &&
        entry.otherGrants.every(isAclGrant),
    )
  ) {
    return false;
  }
  return value.objects.every(
    (entry) =>
      isRecord(entry) &&
      hasExactKeys(entry, objectKeys) &&
      ["table", "sequence", "function"].includes(String(entry.kind)) &&
      (entry.schema === "public" || entry.schema === "drizzle") &&
      typeof entry.name === "string" &&
      typeof entry.identityArguments === "string" &&
      typeof entry.owner === "string" &&
      typeof entry.securityDefiner === "boolean" &&
      isStringArray(entry.functionSettings) &&
      isStringArray(entry.publicPrivileges) &&
      isStringArray(entry.runtimePrivileges) &&
      Array.isArray(entry.otherGrants) &&
      entry.otherGrants.every(isAclGrant) &&
      Array.isArray(entry.columnGrants) &&
      entry.columnGrants.every(isColumnGrant),
  );
}

function requiredObjectMap(): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const grant of REQUIRED_TABLE_GRANTS) {
    result.set(`table:${grant.schema}.${grant.name}()`, grant.privileges);
  }
  for (const grant of REQUIRED_SEQUENCE_GRANTS) {
    result.set(`sequence:${grant.schema}.${grant.name}()`, grant.privileges);
  }
  for (const grant of REQUIRED_FUNCTION_GRANTS) {
    result.set(
      `function:${grant.schema}.${grant.name}(${grant.identityArguments})`,
      grant.privileges,
    );
  }
  return result;
}

export function validateProductionRoleProjection(
  value: unknown,
): RoleContractValidation {
  const errors: RoleContractError[] = [];
  const add = (code: string, path: string, detail: string) =>
    errors.push({ code, path, detail });

  if (!isStrictProductionRoleProjection(value)) {
    add(
      "PROJECTION_SHAPE_INVALID",
      "$",
      "projection must have the exact recursively validated schema",
    );
    return { ok: false, errors };
  }
  const projection = value;

  if (projection.schemaVersion !== PRODUCTION_ROLE_CONTRACT_SCHEMA) {
    add(
      "PROJECTION_SCHEMA_MISMATCH",
      "schemaVersion",
      "projection schema is not exact",
    );
  }
  if (
    projection.migration !== ROLE_CONTRACT_MIGRATION ||
    projection.migrationSha256 !== ROLE_CONTRACT_MIGRATION_SHA256
  ) {
    add(
      "MIGRATION_BINDING_MISMATCH",
      "migration",
      "projection is not bound to exact 0107",
    );
  }
  if (!projection.databaseName.trim()) {
    add("DATABASE_NAME_MISSING", "databaseName", "database name is empty");
  }
  for (const [path, name] of [
    ["databaseName", projection.databaseName],
    ["runtimeRole.name", projection.runtimeRole.name],
    ["migratorRole.name", projection.migratorRole.name],
  ] as const) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
      add("IDENTIFIER_INVALID", path, "identifier is not canonical");
    }
  }
  if (projection.runtimeRole.name === projection.migratorRole.name) {
    add(
      "OWNER_EQUALS_RUNTIME",
      "runtimeRole.name",
      "runtime and migrator roles must differ",
    );
  }
  if (projection.databaseOwner !== projection.migratorRole.name) {
    add(
      "DATABASE_OWNER_MISMATCH",
      "databaseOwner",
      "migrator must own the database",
    );
  }
  if (
    !sameStrings(
      projection.databasePublicPrivileges,
      DATABASE_PUBLIC_PRIVILEGES,
    )
  ) {
    add(
      "PUBLIC_DATABASE_GRANT_MISMATCH",
      "databasePublicPrivileges",
      "PUBLIC database grant must be exactly CONNECT",
    );
  }
  if (
    !sameStrings(
      projection.databaseRuntimePrivileges,
      DATABASE_RUNTIME_PRIVILEGES,
    )
  ) {
    add(
      "RUNTIME_DATABASE_GRANT_MISMATCH",
      "databaseRuntimePrivileges",
      "runtime database grant must be exactly CONNECT",
    );
  }
  if (projection.databaseOtherGrants.length > 0) {
    add(
      "OTHER_DATABASE_GRANT_FORBIDDEN",
      "databaseOtherGrants",
      "a non-owner third role has a direct database ACL",
    );
  }
  if (!projection.runtimeRole.login) {
    add(
      "RUNTIME_NOLOGIN",
      "runtimeRole.login",
      "runtime role must be the login role",
    );
  }
  const forbiddenRoleFlags: ReadonlyArray<
    readonly [keyof ProjectedRole, string]
  > = [
    ["superuser", "SUPERUSER"],
    ["createDatabase", "CREATEDB"],
    ["createRole", "CREATEROLE"],
    ["replication", "REPLICATION"],
    ["bypassRls", "BYPASSRLS"],
  ];
  for (const [field, label] of forbiddenRoleFlags) {
    if (projection.runtimeRole[field] === true) {
      add("RUNTIME_ROLE_FLAG_FORBIDDEN", `runtimeRole.${field}`, label);
    }
  }
  if (projection.migratorRole.login) {
    add(
      "MIGRATOR_LOGIN_FORBIDDEN",
      "migratorRole.login",
      "owner role must be NOLOGIN",
    );
  }
  for (const [field, label] of forbiddenRoleFlags) {
    if (projection.migratorRole[field] === true) {
      add("MIGRATOR_ROLE_FLAG_FORBIDDEN", `migratorRole.${field}`, label);
    }
  }
  if (projection.runtimeMemberOf.length > 0) {
    add(
      "RUNTIME_ROLE_MEMBERSHIP_FORBIDDEN",
      "runtimeMemberOf",
      `runtime inherits or can SET ROLE to: ${projection.runtimeMemberOf.join(", ")}`,
    );
  }
  if (projection.migratorMemberOf.length > 0) {
    add(
      "MIGRATOR_ROLE_MEMBERSHIP_FORBIDDEN",
      "migratorMemberOf",
      `migrator inherits or can SET ROLE to: ${projection.migratorMemberOf.join(", ")}`,
    );
  }
  if (projection.runtimeRoleMembers.length > 0) {
    add(
      "RUNTIME_ROLE_MEMBERS_FORBIDDEN",
      "runtimeRoleMembers",
      `other roles can SET ROLE to runtime: ${projection.runtimeRoleMembers.join(", ")}`,
    );
  }
  if (projection.migratorRoleMembers.length > 0) {
    add(
      "MIGRATOR_ROLE_MEMBERS_FORBIDDEN",
      "migratorRoleMembers",
      `other roles can SET ROLE to migrator: ${projection.migratorRoleMembers.join(", ")}`,
    );
  }
  if (projection.runtimeGlobalSettings.length !== 0) {
    add(
      "RUNTIME_GLOBAL_SETTING_FORBIDDEN",
      "runtimeGlobalSettings",
      "runtime global role settings must be empty",
    );
  }
  if (
    !sameStrings(projection.runtimeDatabaseSettings, [SAFE_SEARCH_PATH_SETTING])
  ) {
    add(
      "RUNTIME_DATABASE_SEARCH_PATH_MISMATCH",
      "runtimeDatabaseSettings",
      `expected exactly ${SAFE_SEARCH_PATH_SETTING}`,
    );
  }

  const schemaMap = new Map(
    projection.schemas.map((schema) => [schema.name, schema]),
  );
  for (const schemaName of ["public", "drizzle"] as const) {
    const schema = schemaMap.get(schemaName);
    if (!schema) {
      add(
        "SCHEMA_PROJECTION_MISSING",
        `schemas.${schemaName}`,
        "schema is absent",
      );
      continue;
    }
    if (schema.owner !== projection.migratorRole.name) {
      add(
        "SCHEMA_OWNER_MISMATCH",
        `schemas.${schemaName}.owner`,
        "migrator must own schema",
      );
    }
    const expectedPublicPrivileges = schemaName === "public" ? ["USAGE"] : [];
    if (!sameStrings(schema.publicPrivileges, expectedPublicPrivileges)) {
      add(
        "PUBLIC_SCHEMA_GRANT_MISMATCH",
        `schemas.${schemaName}.publicPrivileges`,
        `PUBLIC schema grant must be exactly ${expectedPublicPrivileges.join(",")}`,
      );
    }
    if (!sameStrings(schema.runtimePrivileges, ["USAGE"])) {
      add(
        "RUNTIME_SCHEMA_GRANT_MISMATCH",
        `schemas.${schemaName}.runtimePrivileges`,
        "runtime schema grant must be exactly USAGE",
      );
    }
    if (schema.otherGrants.length > 0) {
      add(
        "OTHER_SCHEMA_GRANT_FORBIDDEN",
        `schemas.${schemaName}.otherGrants`,
        "a non-owner third role has a direct schema ACL",
      );
    }
  }
  if (projection.schemas.length !== 2) {
    add(
      "EXTRA_SCHEMA_PROJECTION",
      "schemas",
      "only public and drizzle are in this contract",
    );
  }

  const expectedDefaultKeys = new Set(
    ["public", "drizzle"].flatMap((schema) =>
      ["table", "sequence", "function"].map((kind) => `${schema}:${kind}`),
    ),
  );
  const actualDefaultKeys = new Set<string>();
  for (const entry of projection.defaultPrivileges) {
    const key = `${entry.schema}:${entry.kind}`;
    if (!expectedDefaultKeys.has(key) || actualDefaultKeys.has(key)) {
      add(
        "DEFAULT_PRIVILEGE_PROJECTION_INVALID",
        `defaultPrivileges.${key}`,
        "unexpected or duplicate row",
      );
      continue;
    }
    actualDefaultKeys.add(key);
    if (entry.owner !== projection.migratorRole.name) {
      add(
        "DEFAULT_PRIVILEGE_OWNER_MISMATCH",
        `defaultPrivileges.${key}.owner`,
        "migrator must own defaults",
      );
    }
    if (
      entry.publicPrivileges.length > 0 ||
      entry.runtimePrivileges.length > 0 ||
      entry.otherGrants.length > 0
    ) {
      add(
        "DEFAULT_PRIVILEGE_NOT_DARK",
        `defaultPrivileges.${key}`,
        "future objects must not grant PUBLIC or runtime implicitly",
      );
    }
  }
  for (const key of expectedDefaultKeys) {
    if (!actualDefaultKeys.has(key)) {
      add(
        "DEFAULT_PRIVILEGE_PROJECTION_MISSING",
        `defaultPrivileges.${key}`,
        "required row is absent",
      );
    }
  }

  const expected = requiredObjectMap();
  const actual = new Map<string, ProjectedObject>();
  for (const object of projection.objects) {
    const key = keyForObject(object);
    if (actual.has(key)) {
      add(
        "DUPLICATE_OBJECT_PROJECTION",
        `objects.${key}`,
        "object appears more than once",
      );
      continue;
    }
    actual.set(key, object);
    const expectedPrivileges = expected.get(key);
    if (!expectedPrivileges) {
      add(
        "EXTRA_OBJECT_PROJECTION",
        `objects.${key}`,
        "object is outside exact 0107 manifest",
      );
      continue;
    }
    if (object.owner !== projection.migratorRole.name) {
      add(
        "OBJECT_OWNER_MISMATCH",
        `objects.${key}.owner`,
        "migrator must own object",
      );
    }
    if (object.kind === "function" && object.securityDefiner) {
      add(
        "SECURITY_DEFINER_FUNCTION_FORBIDDEN",
        `objects.${key}.securityDefiner`,
        "runtime-executable contract functions must remain SECURITY INVOKER",
      );
    }
    if (
      object.kind === "function" &&
      !sameStrings(object.functionSettings, [SAFE_SEARCH_PATH_SETTING])
    ) {
      add(
        "FUNCTION_SEARCH_PATH_MISMATCH",
        `objects.${key}.functionSettings`,
        `function must fix ${SAFE_SEARCH_PATH_SETTING}`,
      );
    }
    if (object.kind !== "function" && object.functionSettings.length > 0) {
      add(
        "NON_FUNCTION_SETTING_FORBIDDEN",
        `objects.${key}.functionSettings`,
        "only functions can have function settings",
      );
    }
    if (object.publicPrivileges.length > 0) {
      add(
        "PUBLIC_OBJECT_GRANT_FORBIDDEN",
        `objects.${key}.publicPrivileges`,
        "PUBLIC has object privilege",
      );
    }
    if (!sameStrings(object.runtimePrivileges, expectedPrivileges)) {
      add(
        "RUNTIME_OBJECT_GRANT_MISMATCH",
        `objects.${key}.runtimePrivileges`,
        `expected exactly ${expectedPrivileges.join(",")}`,
      );
    }
    if (object.otherGrants.length > 0) {
      add(
        "OTHER_OBJECT_GRANT_FORBIDDEN",
        `objects.${key}.otherGrants`,
        "a non-owner third role has a direct object ACL",
      );
    }
    if (object.columnGrants.length > 0) {
      add(
        "COLUMN_GRANT_FORBIDDEN",
        `objects.${key}.columnGrants`,
        "column ACLs are outside the exact table grant envelope",
      );
    }
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) {
      add(
        "REQUIRED_OBJECT_PROJECTION_MISSING",
        `objects.${key}`,
        "required object is absent",
      );
    }
  }
  if (actual.size !== expected.size) {
    add(
      "OBJECT_CARDINALITY_MISMATCH",
      "objects",
      `expected ${expected.size}, received ${actual.size}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`ROLE_CONTRACT_IDENTIFIER_INVALID:${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  quoteIdentifier(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const ROLE_FORBIDDEN_KEY =
  /(?:password|passwd|secret|token|credential|private.?key|database.?url|connection.?string|access.?key|cookie)/i;
const ROLE_FORBIDDEN_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /github_pat_|gh[pousr]_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
] as const;
const ROLE_CREDENTIAL_URI = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;

export function assertProductionRoleSecretFree(
  value: unknown,
  field = "artifact",
): void {
  if (typeof value === "string") {
    if (
      ROLE_FORBIDDEN_VALUES.some((pattern) => pattern.test(value)) ||
      (value.includes("://") && ROLE_CREDENTIAL_URI.test(value))
    )
      throw new Error(`ROLE_SEPARATION_SECRET_MATERIAL:${field}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertProductionRoleSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (ROLE_FORBIDDEN_KEY.test(key))
      throw new Error(`ROLE_SEPARATION_SECRET_MATERIAL:${field}.${key}`);
    assertProductionRoleSecretFree(entry, `${field}.${key}`);
  }
}

export function canonicalProductionRoleJson(value: unknown): string {
  assertProductionRoleSecretFree(value);
  const canonical = `${stableJson(value)}\n`;
  if (
    Buffer.byteLength(canonical, "utf8") === 0 ||
    Buffer.byteLength(canonical, "utf8") > PRODUCTION_ROLE_MAX_ARTIFACT_BYTES
  ) {
    throw new Error("ROLE_SEPARATION_ARTIFACT_TOO_LARGE");
  }
  return canonical;
}

export function parseCanonicalProductionRoleArtifact(
  canonical: string,
  field = "artifact",
): {
  readonly value: unknown;
  readonly canonical: string;
  readonly sha256: string;
} {
  if (
    typeof canonical !== "string" ||
    Buffer.byteLength(canonical, "utf8") === 0 ||
    Buffer.byteLength(canonical, "utf8") > PRODUCTION_ROLE_MAX_ARTIFACT_BYTES
  ) {
    throw new Error(`ROLE_SEPARATION_ARTIFACT_INVALID:${field}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    throw new Error(`ROLE_SEPARATION_ARTIFACT_INVALID:${field}`);
  }
  if (canonicalProductionRoleJson(value) !== canonical)
    throw new Error(`ROLE_SEPARATION_ARTIFACT_NOT_CANONICAL:${field}`);
  return Object.freeze({ value, canonical, sha256: sha256(value) });
}

function sha256(value: unknown): string {
  assertProductionRoleSecretFree(value);
  const canonical = `${stableJson(value)}\n`;
  if (Buffer.byteLength(canonical, "utf8") > PRODUCTION_ROLE_MAX_ARTIFACT_BYTES)
    throw new Error("ROLE_SEPARATION_ARTIFACT_TOO_LARGE");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function groupTableGrants(runtime: string): string[] {
  const groups = new Map<string, string[]>();
  for (const item of REQUIRED_TABLE_GRANTS) {
    const key = item.privileges.join(", ");
    groups.set(key, [
      ...(groups.get(key) ?? []),
      qualified(item.schema, item.name),
    ]);
  }
  return [...groups.entries()]
    .filter(([privileges]) => privileges.length > 0)
    .map(
      ([privileges, objects]) =>
        `GRANT ${privileges} ON TABLE ${objects.join(", ")} TO ${runtime}`,
    );
}

export interface ProductionRolePlan {
  readonly schemaVersion: typeof PRODUCTION_ROLE_PLAN_SCHEMA;
  readonly executionDefault: "disabled";
  readonly migration: typeof ROLE_CONTRACT_MIGRATION;
  readonly migrationSha256: typeof ROLE_CONTRACT_MIGRATION_SHA256;
  readonly databaseName: string;
  readonly runtimeRole: string;
  readonly migratorRole: string;
  readonly statements: readonly string[];
  readonly planSha256: string;
}

export function buildProductionRolePlan(input: {
  readonly databaseName: string;
  readonly runtimeRole: string;
  readonly migratorRole: string;
}): ProductionRolePlan {
  const database = quoteIdentifier(input.databaseName);
  const runtime = quoteIdentifier(input.runtimeRole);
  const migrator = quoteIdentifier(input.migratorRole);
  const databaseLiteral = quoteLiteral(input.databaseName);
  const runtimeLiteral = quoteLiteral(input.runtimeRole);
  const migratorLiteral = quoteLiteral(input.migratorRole);
  if (input.runtimeRole === input.migratorRole)
    throw new Error("OWNER_EQUALS_RUNTIME");

  const tables = REQUIRED_TABLE_GRANTS.map((item) =>
    qualified(item.schema, item.name),
  );
  const sequences = REQUIRED_SEQUENCE_GRANTS.map((item) =>
    qualified(item.schema, item.name),
  );
  const grantedSequences = REQUIRED_SEQUENCE_GRANTS.filter((item) =>
    item.privileges.includes("USAGE"),
  ).map((item) => qualified(item.schema, item.name));
  const functions = REQUIRED_FUNCTION_GRANTS.map(
    (item) => `${qualified(item.schema, item.name)}(${item.identityArguments})`,
  );
  const revokeThirdPartyAcls = String.raw`DO $role_acl$
DECLARE target_role name; column_acl record; membership record;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name, member.rolname AS member_name
    FROM pg_auth_members edge
    JOIN pg_roles parent ON parent.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    WHERE parent.rolname IN (${runtimeLiteral}, ${migratorLiteral})
       OR member.rolname IN (${runtimeLiteral}, ${migratorLiteral})
    ORDER BY parent.rolname, member.rolname
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_name, membership.member_name);
  END LOOP;
  FOR target_role IN
    WITH acl_grantees AS (
      SELECT acl.grantee FROM pg_database database_row
        CROSS JOIN LATERAL aclexplode(COALESCE(database_row.datacl, acldefault('d', database_row.datdba))) acl
        WHERE database_row.datname = ${databaseLiteral}
      UNION SELECT acl.grantee FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
        WHERE namespace.nspname IN ('public', 'drizzle')
      UNION SELECT acl.grantee FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,
          acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, relation.relowner))) acl
        WHERE namespace.nspname IN ('public', 'drizzle')
      UNION SELECT acl.grantee FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
        WHERE namespace.nspname = 'public'
      UNION SELECT acl.grantee FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
        WHERE defaults.defaclrole = ${migratorLiteral}::regrole
      UNION SELECT acl.grantee FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        WHERE attribute.attacl IS NOT NULL
    )
    SELECT role.rolname FROM acl_grantees
    JOIN pg_roles role ON role.oid = acl_grantees.grantee
    WHERE acl_grantees.grantee <> 0 AND role.rolname NOT IN (${runtimeLiteral}, ${migratorLiteral})
    ORDER BY role.rolname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', ${databaseLiteral}, target_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public, drizzle FROM %I', target_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE ${tables.join(", ")} FROM %I', target_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE ${sequences.join(", ")} FROM %I', target_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION ${functions.join(", ")} FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA drizzle REVOKE ALL PRIVILEGES ON TABLES FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA drizzle REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I', target_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA drizzle REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I', target_role);
  END LOOP;
  FOR column_acl IN
    SELECT namespace.nspname, relation.relname, attribute.attname, role.rolname
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    JOIN pg_roles role ON role.oid = acl.grantee
    WHERE attribute.attacl IS NOT NULL AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND namespace.nspname IN ('public', 'drizzle')
      AND role.rolname <> ${migratorLiteral}
    ORDER BY namespace.nspname, relation.relname, attribute.attnum, role.rolname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
      column_acl.attname, column_acl.nspname, column_acl.relname, column_acl.rolname);
  END LOOP;
END
$role_acl$`;
  const statements = [
    `ALTER ROLE ${runtime} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `ALTER ROLE ${migrator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `ALTER ROLE ${runtime} RESET ALL`,
    `ALTER ROLE ${runtime} IN DATABASE ${database} RESET ALL`,
    `ALTER ROLE ${runtime} IN DATABASE ${database} SET search_path TO pg_catalog, public, pg_temp`,
    `REVOKE ${migrator} FROM ${runtime}`,
    `REVOKE ${runtime} FROM ${migrator}`,
    `ALTER DATABASE ${database} OWNER TO ${migrator}`,
    `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM PUBLIC, ${runtime}`,
    `GRANT CONNECT ON DATABASE ${database} TO PUBLIC, ${runtime}`,
    `ALTER SCHEMA "public" OWNER TO ${migrator}`,
    `ALTER SCHEMA "drizzle" OWNER TO ${migrator}`,
    `REVOKE CREATE ON SCHEMA "public", "drizzle" FROM PUBLIC`,
    `REVOKE ALL PRIVILEGES ON SCHEMA "public", "drizzle" FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA "public" TO PUBLIC`,
    `REVOKE ALL ON SCHEMA "public", "drizzle" FROM ${runtime}`,
    `GRANT USAGE ON SCHEMA "public", "drizzle" TO ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "public" REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "public" REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "public" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "drizzle" REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "drizzle" REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA "drizzle" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, ${runtime}`,
    `REVOKE ALL PRIVILEGES ON TABLE ${tables.join(", ")} FROM PUBLIC, ${runtime}`,
    `REVOKE ALL PRIVILEGES ON SEQUENCE ${sequences.join(", ")} FROM PUBLIC, ${runtime}`,
    `REVOKE ALL PRIVILEGES ON FUNCTION ${functions.join(", ")} FROM PUBLIC, ${runtime}`,
    revokeThirdPartyAcls,
    ...REQUIRED_TABLE_GRANTS.map(
      (item) =>
        `ALTER TABLE ${qualified(item.schema, item.name)} OWNER TO ${migrator}`,
    ),
    ...REQUIRED_SEQUENCE_GRANTS.map(
      (item) =>
        `ALTER SEQUENCE ${qualified(item.schema, item.name)} OWNER TO ${migrator}`,
    ),
    ...REQUIRED_FUNCTION_GRANTS.map(
      (item) =>
        `ALTER FUNCTION ${qualified(item.schema, item.name)}(${item.identityArguments}) OWNER TO ${migrator}`,
    ),
    ...REQUIRED_FUNCTION_GRANTS.flatMap((item) => [
      `ALTER FUNCTION ${qualified(item.schema, item.name)}(${item.identityArguments}) RESET ALL`,
      `ALTER FUNCTION ${qualified(item.schema, item.name)}(${item.identityArguments}) SET search_path TO pg_catalog, public, pg_temp`,
    ]),
    ...groupTableGrants(runtime),
    `GRANT USAGE ON SEQUENCE ${grantedSequences.join(", ")} TO ${runtime}`,
    `GRANT EXECUTE ON FUNCTION ${functions.join(", ")} TO ${runtime}`,
  ];
  const body = {
    schemaVersion: PRODUCTION_ROLE_PLAN_SCHEMA,
    executionDefault: "disabled" as const,
    migration: ROLE_CONTRACT_MIGRATION,
    migrationSha256: ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: input.databaseName,
    runtimeRole: input.runtimeRole,
    migratorRole: input.migratorRole,
    statements,
  };
  return { ...body, planSha256: sha256(body) };
}

const planKeys = [
  "schemaVersion",
  "executionDefault",
  "migration",
  "migrationSha256",
  "databaseName",
  "runtimeRole",
  "migratorRole",
  "statements",
  "planSha256",
] as const;

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function validateProductionRolePlan(
  value: unknown,
): value is ProductionRolePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (!hasExactKeys(plan, planKeys)) return false;
  if (
    plan.schemaVersion !== PRODUCTION_ROLE_PLAN_SCHEMA ||
    plan.executionDefault !== "disabled" ||
    plan.migration !== ROLE_CONTRACT_MIGRATION ||
    plan.migrationSha256 !== ROLE_CONTRACT_MIGRATION_SHA256 ||
    typeof plan.databaseName !== "string" ||
    typeof plan.runtimeRole !== "string" ||
    typeof plan.migratorRole !== "string" ||
    plan.runtimeRole === plan.migratorRole ||
    !Array.isArray(plan.statements) ||
    plan.statements.length === 0 ||
    !plan.statements.every(
      (statement) => typeof statement === "string" && statement.length > 0,
    ) ||
    typeof plan.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.planSha256)
  ) {
    return false;
  }
  const { planSha256, ...body } = plan;
  if (sha256(body) !== planSha256) return false;
  try {
    const expected = buildProductionRolePlan({
      databaseName: plan.databaseName,
      runtimeRole: plan.runtimeRole,
      migratorRole: plan.migratorRole,
    });
    return stableJson(plan) === stableJson(expected);
  } catch {
    return false;
  }
}

export interface ProductionRoleReceipt {
  readonly schemaVersion: typeof PRODUCTION_ROLE_RECEIPT_SCHEMA;
  readonly planSha256: string;
  readonly migrationSha256: typeof ROLE_CONTRACT_MIGRATION_SHA256;
  readonly executorId: string;
  readonly approvalId: string;
  readonly executedAt: string;
  readonly statementCount: number;
  readonly postProjectionSha256: string;
  readonly postValidation: "passed";
  readonly authorizesDeployment: false;
  readonly postCommitVerification: "unavailable";
  readonly postCommitVerifierArtifact: null;
  readonly receiptSha256: string;
}

const receiptKeys = [
  "schemaVersion",
  "planSha256",
  "migrationSha256",
  "executorId",
  "approvalId",
  "executedAt",
  "statementCount",
  "postProjectionSha256",
  "postValidation",
  "authorizesDeployment",
  "postCommitVerification",
  "postCommitVerifierArtifact",
  "receiptSha256",
] as const;

export function validateProductionRoleReceipt(
  value: unknown,
): value is ProductionRoleReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (!hasExactKeys(receipt, receiptKeys)) return false;
  if (
    receipt.schemaVersion !== PRODUCTION_ROLE_RECEIPT_SCHEMA ||
    receipt.migrationSha256 !== ROLE_CONTRACT_MIGRATION_SHA256 ||
    typeof receipt.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.planSha256) ||
    typeof receipt.executorId !== "string" ||
    !isBoundedEvidenceId(receipt.executorId) ||
    typeof receipt.approvalId !== "string" ||
    !isBoundedEvidenceId(receipt.approvalId) ||
    typeof receipt.executedAt !== "string" ||
    !isCanonicalIsoTimestamp(receipt.executedAt) ||
    typeof receipt.statementCount !== "number" ||
    !Number.isSafeInteger(receipt.statementCount) ||
    receipt.statementCount < 1 ||
    typeof receipt.postProjectionSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.postProjectionSha256) ||
    receipt.postValidation !== "passed" ||
    receipt.authorizesDeployment !== false ||
    receipt.postCommitVerification !== "unavailable" ||
    receipt.postCommitVerifierArtifact !== null ||
    typeof receipt.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.receiptSha256)
  ) {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return sha256(body) === receiptSha256;
}

export interface ProductionRolePostCommitProjectionArtifact {
  readonly schemaVersion: typeof PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA;
  readonly kind: "site-logbook-production-db-role-separation-postcommit";
  readonly planSha256: string;
  readonly transactionReceiptSha256: string;
  readonly projection: ProductionRoleProjection;
  readonly projectionSha256: string;
  readonly verifierId: string;
  readonly observedAt: string;
  readonly authorizesDeployment: false;
}

const postCommitProjectionKeys = [
  "schemaVersion",
  "kind",
  "planSha256",
  "transactionReceiptSha256",
  "projection",
  "projectionSha256",
  "verifierId",
  "observedAt",
  "authorizesDeployment",
] as const;

export function parseProductionRolePostCommitProjectionArtifact(
  canonical: string,
  expected: {
    readonly plan: ProductionRolePlan;
    readonly transactionReceipt: ProductionRoleReceipt;
  },
): Readonly<{
  value: ProductionRolePostCommitProjectionArtifact;
  canonical: string;
  sha256: string;
}> {
  if (!validateProductionRolePlan(expected.plan))
    throw new Error("ROLE_SEPARATION_PLAN_INVALID");
  if (!validateProductionRoleReceipt(expected.transactionReceipt))
    throw new Error("ROLE_SEPARATION_RECEIPT_INVALID");
  const artifact = parseCanonicalProductionRoleArtifact(
    canonical,
    "postCommitProjection",
  );
  if (
    !isRecord(artifact.value) ||
    !hasExactKeys(artifact.value, postCommitProjectionKeys)
  )
    throw new Error("ROLE_SEPARATION_POST_COMMIT_ARTIFACT_INVALID");
  const value =
    artifact.value as unknown as ProductionRolePostCommitProjectionArtifact;
  const validation = validateProductionRoleProjection(value.projection);
  if (
    value.schemaVersion !== PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA ||
    value.kind !== "site-logbook-production-db-role-separation-postcommit" ||
    value.planSha256 !== expected.plan.planSha256 ||
    value.transactionReceiptSha256 !==
      expected.transactionReceipt.receiptSha256 ||
    value.projectionSha256 !== sha256(value.projection) ||
    value.projectionSha256 !==
      expected.transactionReceipt.postProjectionSha256 ||
    value.projection.databaseName !== expected.plan.databaseName ||
    value.projection.runtimeRole.name !== expected.plan.runtimeRole ||
    value.projection.migratorRole.name !== expected.plan.migratorRole ||
    !validation.ok ||
    typeof value.verifierId !== "string" ||
    !isBoundedEvidenceId(value.verifierId) ||
    typeof value.observedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.observedAt) ||
    Date.parse(value.observedAt) <
      Date.parse(expected.transactionReceipt.executedAt) ||
    value.authorizesDeployment !== false
  ) {
    throw new Error("ROLE_SEPARATION_POST_COMMIT_ARTIFACT_INVALID");
  }
  return Object.freeze({
    value: Object.freeze(value),
    canonical: artifact.canonical,
    sha256: artifact.sha256,
  });
}

function isBoundedEvidenceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export interface RolePlanExecutor {
  readonly id: string;
  begin(): Promise<void>;
  execute(statement: string): Promise<void>;
  project(input: {
    databaseName: string;
    runtimeRole: string;
    migratorRole: string;
  }): Promise<ProductionRoleProjection>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface RolePlanActivation {
  readonly enabled: true;
  readonly expectedPlanSha256: string;
  readonly approvalId: string;
  readonly preProjectionCanonical: string;
  readonly expectedPreProjectionSha256: string;
}

export function createOneShotProductionRoleExecutor(
  executor: RolePlanExecutor,
): {
  execute(
    plan: ProductionRolePlan,
    activation?: RolePlanActivation,
  ): Promise<ProductionRoleReceipt>;
} {
  let attempted = false;
  return {
    async execute(plan, activation) {
      if (attempted)
        throw new Error("ROLE_SEPARATION_EXECUTOR_ALREADY_ATTEMPTED");
      attempted = true;
      if (!validateProductionRolePlan(plan))
        throw new Error("ROLE_SEPARATION_PLAN_INVALID");
      if (
        activation?.enabled !== true ||
        activation.expectedPlanSha256 !== plan.planSha256 ||
        !isBoundedEvidenceId(activation.approvalId) ||
        !isBoundedEvidenceId(executor.id)
      ) {
        throw new Error("ROLE_SEPARATION_EXECUTION_DISABLED");
      }
      const preProjectionArtifact = parseCanonicalProductionRoleArtifact(
        activation.preProjectionCanonical,
        "preProjection",
      );
      if (
        preProjectionArtifact.sha256 !==
          activation.expectedPreProjectionSha256 ||
        !isStrictProductionRoleProjection(preProjectionArtifact.value) ||
        (preProjectionArtifact.value as ProductionRoleProjection)
          .schemaVersion !== PRODUCTION_ROLE_CONTRACT_SCHEMA ||
        (preProjectionArtifact.value as ProductionRoleProjection).migration !==
          ROLE_CONTRACT_MIGRATION ||
        (preProjectionArtifact.value as ProductionRoleProjection)
          .migrationSha256 !== ROLE_CONTRACT_MIGRATION_SHA256 ||
        (preProjectionArtifact.value as ProductionRoleProjection)
          .databaseName !== plan.databaseName ||
        (preProjectionArtifact.value as ProductionRoleProjection).runtimeRole
          .name !== plan.runtimeRole ||
        (preProjectionArtifact.value as ProductionRoleProjection).migratorRole
          .name !== plan.migratorRole
      ) {
        throw new Error("ROLE_SEPARATION_PRE_PROJECTION_INVALID");
      }
      await executor.begin();
      try {
        for (const statement of plan.statements)
          await executor.execute(statement);
        const projection = await executor.project({
          databaseName: plan.databaseName,
          runtimeRole: plan.runtimeRole,
          migratorRole: plan.migratorRole,
        });
        const validation = validateProductionRoleProjection(projection);
        if (!validation.ok) {
          throw new Error(
            `ROLE_SEPARATION_POST_VALIDATION_FAILED:${validation.errors
              .map((error) => error.code)
              .join(",")}`,
          );
        }
        if (
          projection.databaseName !== plan.databaseName ||
          projection.runtimeRole.name !== plan.runtimeRole ||
          projection.migratorRole.name !== plan.migratorRole
        ) {
          throw new Error("ROLE_SEPARATION_POST_PROJECTION_BINDING_MISMATCH");
        }
        const executedAt = new Date().toISOString();
        const body = {
          schemaVersion: PRODUCTION_ROLE_RECEIPT_SCHEMA,
          planSha256: plan.planSha256,
          migrationSha256: ROLE_CONTRACT_MIGRATION_SHA256,
          executorId: executor.id,
          approvalId: activation.approvalId,
          executedAt,
          statementCount: plan.statements.length,
          postProjectionSha256: sha256(projection),
          postValidation: "passed" as const,
          authorizesDeployment: false as const,
          postCommitVerification: "unavailable" as const,
          postCommitVerifierArtifact: null,
        };
        const receipt = { ...body, receiptSha256: sha256(body) };
        if (!validateProductionRoleReceipt(receipt)) {
          throw new Error("ROLE_SEPARATION_RECEIPT_INVALID");
        }
        try {
          await executor.commit();
        } catch (error) {
          throw new RoleSeparationCommitOutcomeUnknownError(error);
        }
        return receipt;
      } catch (error) {
        if (error instanceof RoleSeparationCommitOutcomeUnknownError) {
          throw error;
        }
        await executor.rollback();
        throw error;
      }
    },
  };
}

export class RoleSeparationCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("ROLE_SEPARATION_COMMIT_OUTCOME_UNKNOWN", { cause });
    this.name = "RoleSeparationCommitOutcomeUnknownError";
  }
}

/**
 * Read-only projection SQL. The caller supplies the three values as `$1`
 * database name, `$2` runtime role and `$3` migrator role. It deliberately
 * returns normalized rows; assembling them into ProductionRoleProjection is a
 * host-side evidence step and is not wired into application startup here.
 */
export const PRODUCTION_ROLE_PROJECTION_SQL = String.raw`
WITH requested AS (
  SELECT $1::name AS database_name, $2::name AS runtime_role, $3::name AS migrator_role
)
SELECT jsonb_build_object(
  'database', (SELECT jsonb_build_object(
      'name', d.datname, 'owner', owner.rolname,
      'publicPrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
        WHERE acl.grantee = 0 ORDER BY acl.privilege_type),
      'runtimePrivileges', ARRAY_REMOVE(ARRAY[
        CASE WHEN has_database_privilege(r.runtime_role, d.oid, 'CONNECT') THEN 'CONNECT' END,
        CASE WHEN has_database_privilege(r.runtime_role, d.oid, 'CREATE') THEN 'CREATE' END,
        CASE WHEN has_database_privilege(r.runtime_role, d.oid, 'TEMP') THEN 'TEMPORARY' END], NULL),
      'otherGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', direct.grantee, 'privileges', direct.privileges)
          ORDER BY direct.grantee), '[]'::jsonb)
        FROM (SELECT grantee.rolname AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
          JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname NOT IN (r.runtime_role, owner.rolname)
          GROUP BY grantee.rolname) direct))
    FROM pg_database d JOIN pg_roles owner ON owner.oid = d.datdba, requested r
    WHERE d.datname = r.database_name),
  'roles', (SELECT jsonb_agg(jsonb_build_object(
      'name', role.rolname, 'login', role.rolcanlogin, 'superuser', role.rolsuper,
      'createDatabase', role.rolcreatedb, 'createRole', role.rolcreaterole,
      'replication', role.rolreplication, 'bypassRls', role.rolbypassrls))
    FROM pg_roles role, requested r
    WHERE role.rolname IN (r.runtime_role, r.migrator_role)),
  'runtimeMemberOf', (SELECT COALESCE(jsonb_agg(parent.rolname ORDER BY parent.rolname), '[]'::jsonb)
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid, requested r
    WHERE member.rolname = r.runtime_role),
  'migratorMemberOf', (SELECT COALESCE(jsonb_agg(parent.rolname ORDER BY parent.rolname), '[]'::jsonb)
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid, requested r
    WHERE member.rolname = r.migrator_role),
  'runtimeRoleMembers', (SELECT COALESCE(jsonb_agg(member.rolname ORDER BY member.rolname), '[]'::jsonb)
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid, requested r
    WHERE parent.rolname = r.runtime_role),
  'migratorRoleMembers', (SELECT COALESCE(jsonb_agg(member.rolname ORDER BY member.rolname), '[]'::jsonb)
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid, requested r
    WHERE parent.rolname = r.migrator_role),
  'runtimeGlobalSettings', COALESCE((SELECT to_jsonb(setting.setconfig)
    FROM pg_db_role_setting setting JOIN pg_roles role ON role.oid = setting.setrole, requested r
    WHERE role.rolname = r.runtime_role AND setting.setdatabase = 0), '[]'::jsonb),
  'runtimeDatabaseSettings', COALESCE((SELECT to_jsonb(setting.setconfig)
    FROM pg_db_role_setting setting JOIN pg_roles role ON role.oid = setting.setrole
    JOIN pg_database database_row ON database_row.oid = setting.setdatabase, requested r
    WHERE role.rolname = r.runtime_role AND database_row.datname = r.database_name), '[]'::jsonb),
  'schemas', (SELECT jsonb_agg(jsonb_build_object(
      'name', namespace.nspname, 'owner', owner.rolname,
      'publicPrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
        WHERE acl.grantee = 0 ORDER BY acl.privilege_type),
      'runtimePrivileges', ARRAY_REMOVE(ARRAY[
        CASE WHEN has_schema_privilege(r.runtime_role, namespace.oid, 'USAGE') THEN 'USAGE' END,
        CASE WHEN has_schema_privilege(r.runtime_role, namespace.oid, 'CREATE') THEN 'CREATE' END], NULL),
      'otherGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', direct.grantee, 'privileges', direct.privileges)
          ORDER BY direct.grantee), '[]'::jsonb)
        FROM (SELECT grantee.rolname AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
          JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname NOT IN (r.runtime_role, owner.rolname)
          GROUP BY grantee.rolname) direct)))
    FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner, requested r
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'),
  'defaultPrivileges', (SELECT jsonb_agg(jsonb_build_object(
      'schema', namespace.nspname, 'kind', requested_kind.kind, 'owner', owner.rolname,
      'publicPrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(default_acl.defaclacl,
          acldefault(requested_kind.acl_kind, owner.oid))) acl
        WHERE acl.grantee = 0 ORDER BY acl.privilege_type),
      'runtimePrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(default_acl.defaclacl,
          acldefault(requested_kind.acl_kind, owner.oid))) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE grantee.rolname = r.runtime_role ORDER BY acl.privilege_type),
      'otherGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', direct.grantee, 'privileges', direct.privileges)
          ORDER BY direct.grantee), '[]'::jsonb)
        FROM (SELECT grantee.rolname AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM aclexplode(COALESCE(default_acl.defaclacl,
            acldefault(requested_kind.acl_kind, owner.oid))) acl
          JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname NOT IN (r.runtime_role, owner.rolname)
          GROUP BY grantee.rolname) direct)))
    FROM requested r
    JOIN pg_roles owner ON owner.rolname = r.migrator_role
    CROSS JOIN (VALUES ('table', 'r'::"char", 'r'::"char"), ('sequence', 'S'::"char", 's'::"char"),
      ('function', 'f'::"char", 'f'::"char")) requested_kind(kind, catalog_kind, acl_kind)
    JOIN pg_namespace namespace ON namespace.nspname IN ('public', 'drizzle')
    LEFT JOIN pg_default_acl default_acl ON default_acl.defaclrole = owner.oid
      AND default_acl.defaclnamespace = namespace.oid
      AND default_acl.defaclobjtype = requested_kind.catalog_kind),
  'relations', (SELECT jsonb_agg(jsonb_build_object(
      'kind', CASE relation.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END,
      'schema', namespace.nspname, 'name', relation.relname, 'identityArguments', '',
      'owner', owner.rolname, 'securityDefiner', false, 'functionSettings', ARRAY[]::text[],
      'publicPrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(relation.relacl,
          acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, relation.relowner))) acl
        WHERE acl.grantee = 0 ORDER BY acl.privilege_type),
      'runtimePrivileges', CASE WHEN relation.relkind = 'S' THEN ARRAY_REMOVE(ARRAY[
        CASE WHEN has_sequence_privilege(r.runtime_role, relation.oid, 'USAGE') THEN 'USAGE' END,
        CASE WHEN has_sequence_privilege(r.runtime_role, relation.oid, 'SELECT') THEN 'SELECT' END,
        CASE WHEN has_sequence_privilege(r.runtime_role, relation.oid, 'UPDATE') THEN 'UPDATE' END], NULL)
      ELSE ARRAY_REMOVE(ARRAY[
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'SELECT') THEN 'SELECT' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'INSERT') THEN 'INSERT' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'UPDATE') THEN 'UPDATE' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'DELETE') THEN 'DELETE' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'REFERENCES') THEN 'REFERENCES' END,
        CASE WHEN has_table_privilege(r.runtime_role, relation.oid, 'TRIGGER') THEN 'TRIGGER' END], NULL) END,
      'otherGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', direct.grantee, 'privileges', direct.privileges)
          ORDER BY direct.grantee), '[]'::jsonb)
        FROM (SELECT grantee.rolname AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM aclexplode(COALESCE(relation.relacl,
            acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, relation.relowner))) acl
          JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname NOT IN (r.runtime_role, owner.rolname)
          GROUP BY grantee.rolname) direct),
      'columnGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'column', direct.column_name, 'grantee', direct.grantee,
          'privileges', direct.privileges)
          ORDER BY direct.column_number, direct.grantee), '[]'::jsonb)
        FROM (SELECT attribute.attnum AS column_number,
            attribute.attname AS column_name,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM pg_attribute attribute
          CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
          LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0
            AND NOT attribute.attisdropped AND attribute.attacl IS NOT NULL
          GROUP BY attribute.attnum, attribute.attname, acl.grantee, grantee.rolname) direct)))
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner, requested r
    WHERE namespace.nspname IN ('public', 'drizzle') AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')),
  'functions', (SELECT jsonb_agg(jsonb_build_object(
      'kind', 'function', 'schema', namespace.nspname, 'name', procedure.proname,
      'identityArguments', pg_catalog.oidvectortypes(procedure.proargtypes), 'owner', owner.rolname,
      'securityDefiner', procedure.prosecdef,
      'functionSettings', COALESCE(procedure.proconfig, ARRAY[]::text[]),
      'publicPrivileges', ARRAY(SELECT acl.privilege_type
        FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
        WHERE acl.grantee = 0 ORDER BY acl.privilege_type),
      'runtimePrivileges', CASE WHEN has_function_privilege(r.runtime_role, procedure.oid, 'EXECUTE') THEN ARRAY['EXECUTE'] ELSE ARRAY[]::text[] END,
      'otherGrants', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', direct.grantee, 'privileges', direct.privileges)
          ORDER BY direct.grantee), '[]'::jsonb)
        FROM (SELECT grantee.rolname AS grantee,
            array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
          JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname NOT IN (r.runtime_role, owner.rolname)
          GROUP BY grantee.rolname) direct),
      'columnGrants', ARRAY[]::jsonb[]))
    FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_roles owner ON owner.oid = procedure.proowner, requested r
    WHERE namespace.nspname = 'public')
) AS projection;
`;
