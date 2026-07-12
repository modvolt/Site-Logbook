CREATE TABLE "work_session_breaks" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"created_by_user_id" integer,
	"ended_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "work_session_breaks_state_check" CHECK (("work_session_breaks"."ended_at" is null and "work_session_breaks"."duration_seconds" is null)
          or ("work_session_breaks"."ended_at" is not null and "work_session_breaks"."duration_seconds" is not null and "work_session_breaks"."duration_seconds" >= 0))
);
--> statement-breakpoint
CREATE TABLE "work_session_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" integer,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"data" jsonb,
	CONSTRAINT "work_session_events_type_check" CHECK ("work_session_events"."event_type" in ('started', 'stopped', 'manual_created', 'manual_adjusted', 'break_started', 'break_stopped', 'voided', 'review_flagged', 'legacy_imported'))
);
--> statement-breakpoint
CREATE TABLE "work_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"parent_type" text NOT NULL,
	"parent_id_snapshot" integer NOT NULL,
	"job_id" integer,
	"activity_id" integer,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'timer' NOT NULL,
	"review_status" text DEFAULT 'not_required' NOT NULL,
	"review_reason" text,
	"review_flagged_at" timestamp,
	"note" text,
	"idempotency_key" text,
	"stop_idempotency_key" text,
	"created_by_user_id" integer,
	"ended_by_user_id" integer,
	"voided_at" timestamp,
	"voided_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "work_sessions_parent_check" CHECK (("work_sessions"."parent_type" = 'job' and "work_sessions"."activity_id" is null and ("work_sessions"."job_id" is null or "work_sessions"."job_id" = "work_sessions"."parent_id_snapshot"))
          or ("work_sessions"."parent_type" = 'activity' and "work_sessions"."job_id" is null and ("work_sessions"."activity_id" is null or "work_sessions"."activity_id" = "work_sessions"."parent_id_snapshot"))),
	CONSTRAINT "work_sessions_status_check" CHECK ("work_sessions"."status" in ('active', 'completed', 'voided')),
	CONSTRAINT "work_sessions_source_check" CHECK ("work_sessions"."source" in ('timer', 'manual', 'correction', 'legacy_manual', 'legacy_timer')),
	CONSTRAINT "work_sessions_review_status_check" CHECK ("work_sessions"."review_status" in ('not_required', 'needs_review', 'approved')),
	CONSTRAINT "work_sessions_state_check" CHECK (("work_sessions"."status" = 'active' and "work_sessions"."ended_at" is null and "work_sessions"."duration_seconds" is null and "work_sessions"."voided_at" is null)
          or ("work_sessions"."status" = 'completed' and "work_sessions"."ended_at" is not null and "work_sessions"."duration_seconds" is not null and "work_sessions"."voided_at" is null)
          or ("work_sessions"."status" = 'voided' and "work_sessions"."voided_at" is not null)),
	CONSTRAINT "work_sessions_duration_check" CHECK ("work_sessions"."source" = 'correction' or "work_sessions"."duration_seconds" is null or "work_sessions"."duration_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "work_session_breaks" ADD CONSTRAINT "work_session_breaks_session_id_work_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."work_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_breaks" ADD CONSTRAINT "work_session_breaks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_breaks" ADD CONSTRAINT "work_session_breaks_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_events" ADD CONSTRAINT "work_session_events_session_id_work_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."work_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_events" ADD CONSTRAINT "work_session_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_session_breaks_one_active_uq" ON "work_session_breaks" USING btree ("session_id") WHERE "work_session_breaks"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "work_session_breaks_session_id_idx" ON "work_session_breaks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "work_session_events_session_id_idx" ON "work_session_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "work_session_events_occurred_at_idx" ON "work_session_events" USING btree ("occurred_at");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "time_entries"
		WHERE num_nonnulls("job_id", "activity_id") <> 1
	) THEN
		RAISE EXCEPTION 'time_entries contains rows without exactly one job/activity parent; repair them before migration 0074';
	END IF;
END $$;--> statement-breakpoint
-- Preserve every existing aggregate as an immutable legacy adjustment. The old
-- time_entries table remains in place as the compatibility projection.
INSERT INTO "work_sessions" (
	"person_id", "parent_type", "parent_id_snapshot", "job_id", "activity_id",
	"started_at", "ended_at", "duration_seconds", "status", "source", "note",
	"created_at", "updated_at"
)
SELECT
	"person_id", CASE WHEN "job_id" IS NOT NULL THEN 'job' ELSE 'activity' END,
	coalesce("job_id", "activity_id"), "job_id", "activity_id", "created_at", "created_at",
	greatest(0, round(coalesce("hours", 0)::numeric * 3600)::integer),
	'completed', 'legacy_manual', 'Převod souhrnného času před zavedením pracovních session',
	"created_at", "updated_at"
FROM "time_entries"
WHERE coalesce("hours", 0) <> 0;--> statement-breakpoint
-- Older concurrently-running timers are closed at migration time. The newest
-- timer for each person remains active, allowing the global unique index below
-- to be created without silently discarding elapsed work.
WITH ranked AS (
	SELECT te.*,
		row_number() OVER (PARTITION BY "person_id" ORDER BY "timer_started_at" DESC, "id" DESC) AS rn
	FROM "time_entries" te
	WHERE "timer_started_at" IS NOT NULL
)
INSERT INTO "work_sessions" (
	"person_id", "parent_type", "parent_id_snapshot", "job_id", "activity_id",
	"started_at", "ended_at", "duration_seconds", "status", "source", "note",
	"created_at", "updated_at"
)
SELECT
	"person_id", CASE WHEN "job_id" IS NOT NULL THEN 'job' ELSE 'activity' END,
	coalesce("job_id", "activity_id"), "job_id", "activity_id", "timer_started_at",
	CASE WHEN rn = 1 THEN NULL ELSE now() END,
	CASE WHEN rn = 1 THEN NULL ELSE greatest(0, floor(extract(epoch from (now() - "timer_started_at")))::integer) END,
	CASE WHEN rn = 1 THEN 'active' ELSE 'completed' END,
	'legacy_timer',
	CASE WHEN rn = 1 THEN 'Aktivní časovač převedený ze starého modelu'
	     ELSE 'Souběžný starý časovač automaticky uzavřen při migraci' END,
	"created_at", now()
FROM ranked;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", "timer_started_at",
		row_number() OVER (PARTITION BY "person_id" ORDER BY "timer_started_at" DESC, "id" DESC) AS rn
	FROM "time_entries"
	WHERE "timer_started_at" IS NOT NULL
)
UPDATE "time_entries" te
SET "hours" = round((coalesce(te."hours", 0) +
	greatest(0, extract(epoch from (now() - ranked."timer_started_at")) / 3600.0))::numeric, 2),
	"timer_started_at" = NULL,
	"updated_at" = now()
FROM ranked
WHERE te."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
UPDATE "work_sessions"
SET "review_status" = 'needs_review',
	"review_reason" = 'Délka session překročila 12hodinový limit při převodu',
	"review_flagged_at" = now()
WHERE ("status" = 'active' AND "started_at" < now() - interval '12 hours')
	OR ("status" = 'completed' AND "duration_seconds" > 43200);--> statement-breakpoint
INSERT INTO "work_session_events" ("session_id", "event_type", "occurred_at", "data")
SELECT "id", 'legacy_imported', "created_at", jsonb_build_object('source', "source")
FROM "work_sessions";--> statement-breakpoint
INSERT INTO "work_session_events" ("session_id", "event_type", "occurred_at", "data")
SELECT "id", 'review_flagged', "review_flagged_at", jsonb_build_object('reason', 'duration_limit', 'thresholdSeconds', 43200)
FROM "work_sessions" WHERE "review_status" = 'needs_review';--> statement-breakpoint
CREATE UNIQUE INDEX "work_sessions_one_active_person_uq" ON "work_sessions" USING btree ("person_id") WHERE "work_sessions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "work_sessions_idempotency_key_uq" ON "work_sessions" USING btree ("idempotency_key") WHERE "work_sessions"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_sessions_stop_idempotency_key_uq" ON "work_sessions" USING btree ("stop_idempotency_key") WHERE "work_sessions"."stop_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "work_sessions_job_id_idx" ON "work_sessions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "work_sessions_activity_id_idx" ON "work_sessions" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "work_sessions_person_started_idx" ON "work_sessions" USING btree ("person_id","started_at");
