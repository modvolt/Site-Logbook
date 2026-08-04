CREATE TABLE "operational_alert_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_event_id" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"last_failure_category" text,
	"last_http_status" integer,
	"delivered_at" timestamp,
	"dead_lettered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operational_alert_outbox_state_chk" CHECK ("operational_alert_outbox"."state" in ('pending', 'delivering', 'delivered', 'dead_letter')),
	CONSTRAINT "operational_alert_outbox_attempt_chk" CHECK ("operational_alert_outbox"."attempt_count" >= 0),
	CONSTRAINT "operational_alert_outbox_lease_chk" CHECK (("operational_alert_outbox"."state" = 'delivering' and "operational_alert_outbox"."lease_token" is not null and "operational_alert_outbox"."lease_expires_at" is not null) or ("operational_alert_outbox"."state" <> 'delivering' and "operational_alert_outbox"."lease_token" is null and "operational_alert_outbox"."lease_expires_at" is null)),
	CONSTRAINT "operational_alert_outbox_terminal_chk" CHECK (("operational_alert_outbox"."state" = 'delivered' and "operational_alert_outbox"."delivered_at" is not null and "operational_alert_outbox"."dead_lettered_at" is null) or ("operational_alert_outbox"."state" = 'dead_letter' and "operational_alert_outbox"."dead_lettered_at" is not null and "operational_alert_outbox"."delivered_at" is null) or ("operational_alert_outbox"."state" in ('pending', 'delivering') and "operational_alert_outbox"."delivered_at" is null and "operational_alert_outbox"."dead_lettered_at" is null))
);
--> statement-breakpoint
CREATE TABLE "operational_incident_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"event_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"owner" text NOT NULL,
	"runbook" text NOT NULL,
	"metric" text NOT NULL,
	"observed" double precision,
	"threshold" double precision,
	"observed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operational_incident_events_kind_chk" CHECK ("operational_incident_events"."kind" in ('triggered', 'escalated', 'deescalated', 'recovered')),
	CONSTRAINT "operational_incident_events_severity_chk" CHECK ("operational_incident_events"."severity" in ('warning', 'critical')),
	CONSTRAINT "operational_incident_events_key_chk" CHECK ("operational_incident_events"."event_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operational_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"owner" text NOT NULL,
	"runbook" text NOT NULL,
	"metric" text NOT NULL,
	"observed" double precision,
	"threshold" double precision,
	"sequence" integer DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp NOT NULL,
	"last_observed_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operational_incidents_status_chk" CHECK ("operational_incidents"."status" in ('open', 'resolved')),
	CONSTRAINT "operational_incidents_severity_chk" CHECK ("operational_incidents"."severity" in ('warning', 'critical')),
	CONSTRAINT "operational_incidents_sequence_chk" CHECK ("operational_incidents"."sequence" >= 1),
	CONSTRAINT "operational_incidents_resolution_chk" CHECK (("operational_incidents"."status" = 'open' and "operational_incidents"."resolved_at" is null) or ("operational_incidents"."status" = 'resolved' and "operational_incidents"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "operational_alert_outbox" ADD CONSTRAINT "operational_alert_outbox_incident_event_id_operational_incident_events_id_fk" FOREIGN KEY ("incident_event_id") REFERENCES "public"."operational_incident_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_incident_events" ADD CONSTRAINT "operational_incident_events_incident_id_operational_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."operational_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_alert_outbox_event_uq" ON "operational_alert_outbox" USING btree ("incident_event_id");--> statement-breakpoint
CREATE INDEX "operational_alert_outbox_claim_idx" ON "operational_alert_outbox" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_incident_events_key_uq" ON "operational_incident_events" USING btree ("event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_incident_events_sequence_uq" ON "operational_incident_events" USING btree ("incident_id","sequence");--> statement-breakpoint
CREATE INDEX "operational_incident_events_created_idx" ON "operational_incident_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_incidents_fingerprint_uq" ON "operational_incidents" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "operational_incidents_status_severity_idx" ON "operational_incidents" USING btree ("status","severity");
--> statement-breakpoint
CREATE TRIGGER "operational_incident_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "operational_incident_events"
FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();
