import {
  pgTable, serial, integer, text, timestamp, date, numeric, boolean, jsonb,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { peopleTable } from "./people";
import { usersTable } from "./users";

export const switchboardsTable = pgTable("switchboards", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
  internalName: text("internal_name").notNull(),
  designation: text("designation").notNull(),
  installationLocation: text("installation_location"),
  serialNumber: text("serial_number"),
  productionDate: date("production_date"),
  typeDesignation: text("type_designation"),
  manufacturer: text("manufacturer").notNull().default("Modvolt s.r.o."),
  networkSystem: text("network_system"),
  ratedVoltage: text("rated_voltage"),
  ratedFrequency: text("rated_frequency"),
  ratedCurrent: text("rated_current"),
  ipRating: text("ip_rating"),
  ikRating: text("ik_rating"),
  dimensions: text("dimensions"),
  weight: text("weight"),
  standards: text("standards").array().notNull().default([]),
  properties: jsonb("properties").$type<Record<string, boolean>>().notNull().default({}),
  notes: text("notes"),
  status: text("status").notNull().default("created"),
  processingStatus: text("processing_status").notNull().default("idle"),
  assemblyStatus: text("assembly_status").notNull().default("not_started"),
  inspectionStatus: text("inspection_status").notNull().default("not_started"),
  measurementStatus: text("measurement_status").notNull().default("not_started"),
  qrTokenHash: text("qr_token_hash"),
  qrTokenPrefix: text("qr_token_prefix"),
  qrEnabled: boolean("qr_enabled").notNull().default(false),
  qrExpiresAt: timestamp("qr_expires_at"),
  archivedAt: timestamp("archived_at"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("switchboards_job_id_idx").on(t.jobId),
  index("switchboards_status_idx").on(t.status),
  uniqueIndex("switchboards_serial_number_unique_idx").on(t.serialNumber),
]);

export const switchboardAssigneesTable = pgTable("switchboard_assignees", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => peopleTable.id, { onDelete: "restrict" }),
  isResponsible: boolean("is_responsible").notNull().default(false),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("switchboard_assignees_unique_idx").on(t.switchboardId, t.personId)]);

export const switchboardDocumentsTable = pgTable("switchboard_documents", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  documentType: text("document_type").notNull(),
  version: integer("version").notNull(),
  storagePath: text("storage_path").notNull(),
  originalFileName: text("original_file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  isPublic: boolean("is_public").notNull().default(false),
  processingStatus: text("processing_status").notNull().default("pending"),
  processingErrorCode: text("processing_error_code"),
  processingErrorMessage: text("processing_error_message"),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("switchboard_documents_version_unique_idx").on(t.switchboardId, t.documentType, t.version),
  uniqueIndex("switchboard_documents_hash_unique_idx").on(t.switchboardId, t.sha256),
]);

export const switchboardProcessingJobsTable = pgTable("switchboard_processing_jobs", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => switchboardDocumentsTable.id, { onDelete: "cascade" }),
  jobType: text("job_type").notNull().default("extract_dbo_label"),
  status: text("status").notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  parserVersion: text("parser_version").notNull(),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by"),
  availableAt: timestamp("available_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("switchboard_processing_jobs_queue_idx").on(t.status, t.availableAt)]);

export const switchboardFieldRegistryTable = pgTable("switchboard_field_registry", {
  id: serial("id").primaryKey(),
  fieldKey: text("field_key").notNull().unique(),
  canonicalNameCs: text("canonical_name_cs").notNull(),
  aliases: text("aliases").array().notNull().default([]),
  dataType: text("data_type").notNull(),
  required: boolean("required").notNull().default(false),
  minimumConfidence: numeric("minimum_confidence", { precision: 4, scale: 3 }).notNull().default("0.850"),
  normalizationRules: jsonb("normalization_rules").$type<Record<string, unknown>>().notNull().default({}),
  validationRules: jsonb("validation_rules").$type<Record<string, unknown>>().notNull().default({}),
  allowedRelations: text("allowed_relations").array().notNull().default([]),
  labelOrder: integer("label_order").notNull().default(0),
  protocolOrder: integer("protocol_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const switchboardExtractedFieldsTable = pgTable("switchboard_extracted_fields", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => switchboardDocumentsTable.id, { onDelete: "restrict" }),
  fieldKey: text("field_key").notNull(),
  foundLabel: text("found_label").notNull(),
  matchedAlias: text("matched_alias"),
  rawValue: text("raw_value"),
  normalizedValue: text("normalized_value"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  pageNumber: integer("page_number").notNull(),
  blockId: text("block_id"),
  extractionMethod: text("extraction_method").notNull(),
  relativeRelation: text("relative_relation").notNull(),
  validationStatus: text("validation_status").notNull(),
  validationMessage: text("validation_message"),
  parserVersion: text("parser_version").notNull(),
  manuallyCorrected: boolean("manually_corrected").notNull().default(false),
  correctedValue: text("corrected_value"),
  correctedByUserId: integer("corrected_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  correctedAt: timestamp("corrected_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("switchboard_extracted_fields_document_idx").on(t.documentId, t.fieldKey)]);

export const switchboardLabelVersionsTable = pgTable("switchboard_label_versions", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  sourceDocumentId: integer("source_document_id").references(() => switchboardDocumentsTable.id, { onDelete: "restrict" }),
  inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
  pdfStoragePath: text("pdf_storage_path"),
  pngStoragePath: text("png_storage_path"),
  qrTarget: text("qr_target").notNull(),
  status: text("status").notNull().default("draft"),
  generatorVersion: text("generator_version").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedByUserId: integer("approved_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
}, (t) => [uniqueIndex("switchboard_label_versions_unique_idx").on(t.switchboardId, t.version)]);

export const switchboardChecklistTemplatesTable = pgTable("switchboard_checklist_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  boardType: text("board_type"),
  isActive: boolean("is_active").notNull().default(true),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const switchboardChecklistTemplateVersionsTable = pgTable("switchboard_checklist_template_versions", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => switchboardChecklistTemplatesTable.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("switchboard_checklist_template_versions_unique_idx").on(t.templateId, t.version)]);

export const switchboardChecklistInstancesTable = pgTable("switchboard_checklist_instances", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  templateVersionId: integer("template_version_id").notNull().references(() => switchboardChecklistTemplateVersionsTable.id, { onDelete: "restrict" }),
  templateSnapshot: jsonb("template_snapshot").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("in_progress"),
  currentPhase: text("current_phase").notNull().default("assembly"),
  revision: integer("revision").notNull().default(1),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  completedByUserId: integer("completed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  overrideReason: text("override_reason"),
  overrideByUserId: integer("override_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("switchboard_checklist_instances_board_idx").on(t.switchboardId, t.status)]);

export const switchboardChecklistResponsesTable = pgTable("switchboard_checklist_responses", {
  id: serial("id").primaryKey(),
  instanceId: integer("instance_id").notNull().references(() => switchboardChecklistInstancesTable.id, { onDelete: "restrict" }),
  phaseKey: text("phase_key").notNull(),
  itemKey: text("item_key").notNull(),
  result: text("result"),
  value: text("value"),
  unit: text("unit"),
  passed: boolean("passed"),
  note: text("note"),
  justification: text("justification"),
  revision: integer("revision").notNull().default(1),
  performedByUserId: integer("performed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  performedAt: timestamp("performed_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("switchboard_checklist_responses_unique_idx").on(t.instanceId, t.itemKey)]);

export const switchboardMeasurementsTable = pgTable("switchboard_measurements", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  checklistResponseId: integer("checklist_response_id").references(() => switchboardChecklistResponsesTable.id, { onDelete: "set null" }),
  measurementType: text("measurement_type").notNull(),
  subjectLabel: text("subject_label"),
  value: numeric("value", { precision: 14, scale: 4 }),
  valueText: text("value_text"),
  unit: text("unit").notNull(),
  result: text("result").notNull(),
  instrument: text("instrument"),
  note: text("note"),
  measuredByUserId: integer("measured_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  measuredAt: timestamp("measured_at").notNull().defaultNow(),
});

export const switchboardDefectsTable = pgTable("switchboard_defects", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  checklistResponseId: integer("checklist_response_id").references(() => switchboardChecklistResponsesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull().default("medium"),
  isCritical: boolean("is_critical").notNull().default(false),
  status: text("status").notNull().default("open"),
  responsiblePersonId: integer("responsible_person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  repairDescription: text("repair_description"),
  foundByUserId: integer("found_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  foundAt: timestamp("found_at").notNull().defaultNow(),
  closedByUserId: integer("closed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at"),
});

export const switchboardPhotosTable = pgTable("switchboard_photos", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  category: text("category").notNull(),
  relatedType: text("related_type"),
  relatedId: integer("related_id"),
  storagePath: text("storage_path").notNull(),
  originalFileName: text("original_file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  description: text("description"),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  takenAt: timestamp("taken_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("switchboard_photos_board_idx").on(t.switchboardId, t.category)]);

export const switchboardProtocolVersionsTable = pgTable("switchboard_protocol_versions", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  protocolNumber: text("protocol_number").notNull(),
  dataSnapshot: jsonb("data_snapshot").$type<Record<string, unknown>>().notNull(),
  pdfStoragePath: text("pdf_storage_path").notNull(),
  generatorVersion: text("generator_version").notNull(),
  status: text("status").notNull().default("final"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("switchboard_protocol_versions_unique_idx").on(t.switchboardId, t.version)]);

export const switchboardServiceRecordsTable = pgTable("switchboard_service_records", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").notNull().references(() => switchboardsTable.id, { onDelete: "restrict" }),
  serviceType: text("service_type").notNull(),
  description: text("description").notNull(),
  performedByUserId: integer("performed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  performedAt: timestamp("performed_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const switchboardEventsTable = pgTable("switchboard_events", {
  id: serial("id").primaryKey(),
  switchboardId: integer("switchboard_id").references(() => switchboardsTable.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  actorUserId: integer("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorName: text("actor_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("switchboard_events_board_idx").on(t.switchboardId, t.createdAt)]);

export type Switchboard = typeof switchboardsTable.$inferSelect;
export type SwitchboardDocument = typeof switchboardDocumentsTable.$inferSelect;
