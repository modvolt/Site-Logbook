import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const operationalIncidentsTable = pgTable(
  "operational_incidents",
  {
    id: serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    code: text("code").notNull(),
    status: text("status").notNull().default("open"),
    severity: text("severity").notNull(),
    owner: text("owner").notNull(),
    runbook: text("runbook").notNull(),
    metric: text("metric").notNull(),
    observed: doublePrecision("observed"),
    threshold: doublePrecision("threshold"),
    sequence: integer("sequence").notNull().default(1),
    firstObservedAt: timestamp("first_observed_at").notNull(),
    lastObservedAt: timestamp("last_observed_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operational_incidents_fingerprint_uq").on(table.fingerprint),
    index("operational_incidents_status_severity_idx").on(
      table.status,
      table.severity,
    ),
    check(
      "operational_incidents_status_chk",
      sql`${table.status} in ('open', 'resolved')`,
    ),
    check(
      "operational_incidents_severity_chk",
      sql`${table.severity} in ('warning', 'critical')`,
    ),
    check("operational_incidents_sequence_chk", sql`${table.sequence} >= 1`),
    check(
      "operational_incidents_resolution_chk",
      sql`(${table.status} = 'open' and ${table.resolvedAt} is null) or (${table.status} = 'resolved' and ${table.resolvedAt} is not null)`,
    ),
  ],
);

export const operationalIncidentEventsTable = pgTable(
  "operational_incident_events",
  {
    id: serial("id").primaryKey(),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => operationalIncidentsTable.id, { onDelete: "restrict" }),
    eventKey: text("event_key").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    owner: text("owner").notNull(),
    runbook: text("runbook").notNull(),
    metric: text("metric").notNull(),
    observed: doublePrecision("observed"),
    threshold: doublePrecision("threshold"),
    observedAt: timestamp("observed_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operational_incident_events_key_uq").on(table.eventKey),
    uniqueIndex("operational_incident_events_sequence_uq").on(
      table.incidentId,
      table.sequence,
    ),
    index("operational_incident_events_created_idx").on(table.createdAt),
    check(
      "operational_incident_events_kind_chk",
      sql`${table.kind} in ('triggered', 'escalated', 'deescalated', 'recovered')`,
    ),
    check(
      "operational_incident_events_severity_chk",
      sql`${table.severity} in ('warning', 'critical')`,
    ),
    check(
      "operational_incident_events_key_chk",
      sql`${table.eventKey} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const operationalAlertOutboxTable = pgTable(
  "operational_alert_outbox",
  {
    id: serial("id").primaryKey(),
    incidentEventId: integer("incident_event_id")
      .notNull()
      .references(() => operationalIncidentEventsTable.id, {
        onDelete: "restrict",
      }),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at").notNull().defaultNow(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    lastFailureCategory: text("last_failure_category"),
    lastHttpStatus: integer("last_http_status"),
    deliveredAt: timestamp("delivered_at"),
    deadLetteredAt: timestamp("dead_lettered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operational_alert_outbox_event_uq").on(table.incidentEventId),
    index("operational_alert_outbox_claim_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "operational_alert_outbox_state_chk",
      sql`${table.state} in ('pending', 'delivering', 'delivered', 'dead_letter')`,
    ),
    check(
      "operational_alert_outbox_attempt_chk",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "operational_alert_outbox_lease_chk",
      sql`(${table.state} = 'delivering' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'delivering' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "operational_alert_outbox_terminal_chk",
      sql`(${table.state} = 'delivered' and ${table.deliveredAt} is not null and ${table.deadLetteredAt} is null) or (${table.state} = 'dead_letter' and ${table.deadLetteredAt} is not null and ${table.deliveredAt} is null) or (${table.state} in ('pending', 'delivering') and ${table.deliveredAt} is null and ${table.deadLetteredAt} is null)`,
    ),
  ],
);

export type OperationalIncident = typeof operationalIncidentsTable.$inferSelect;
export type OperationalIncidentEvent =
  typeof operationalIncidentEventsTable.$inferSelect;
export type OperationalAlertOutbox = typeof operationalAlertOutboxTable.$inferSelect;
