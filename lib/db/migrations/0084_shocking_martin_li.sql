ALTER TABLE "users" ADD COLUMN "person_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Link existing accounts only when both sides of the match are unambiguous.
-- A conflicting name/email remains unlinked and must be resolved by an admin.
WITH candidate_matches AS (
	SELECT DISTINCT u.id AS user_id, p.id AS person_id
	FROM "users" u
	JOIN "people" p ON lower(trim(p.name)) = lower(trim(u.name))
		OR (u.email IS NOT NULL AND p.email IS NOT NULL AND lower(trim(p.email)) = lower(trim(u.email)))
), unique_user_matches AS (
	SELECT user_id, min(person_id) AS person_id
	FROM candidate_matches
	GROUP BY user_id
	HAVING count(DISTINCT person_id) = 1
), exclusive_matches AS (
	SELECT person_id, min(user_id) AS user_id
	FROM unique_user_matches
	GROUP BY person_id
	HAVING count(DISTINCT user_id) = 1
)
UPDATE "users" u
SET "person_id" = matches.person_id
FROM exclusive_matches matches
WHERE u.id = matches.user_id;--> statement-breakpoint

CREATE UNIQUE INDEX "users_person_id_uq" ON "users" USING btree ("person_id") WHERE "users"."person_id" is not null;--> statement-breakpoint

-- Convert a currently running legacy job timer when its worker can be
-- determined from exactly one existing time entry, or exactly one assignee.
WITH entry_stats AS (
	SELECT job_id, min(person_id) AS person_id, count(DISTINCT person_id) AS person_count
	FROM "time_entries"
	WHERE job_id IS NOT NULL
	GROUP BY job_id
), assignee_union AS (
	SELECT id AS job_id, assigned_person_id AS person_id FROM "jobs" WHERE assigned_person_id IS NOT NULL
	UNION
	SELECT job_id, person_id FROM "job_assignees"
), assignee_stats AS (
	SELECT job_id, min(person_id) AS person_id, count(DISTINCT person_id) AS person_count
	FROM assignee_union
	GROUP BY job_id
), resolved AS (
	SELECT j.id AS job_id, j.timer_started_at,
		CASE
			WHEN entries.person_count = 1 THEN entries.person_id
			WHEN entries.person_count IS NULL AND assignees.person_count = 1 THEN assignees.person_id
			ELSE NULL
		END AS person_id
	FROM "jobs" j
	LEFT JOIN entry_stats entries ON entries.job_id = j.id
	LEFT JOIN assignee_stats assignees ON assignees.job_id = j.id
	WHERE j.timer_started_at IS NOT NULL
), ranked AS (
	SELECT resolved.*,
		row_number() OVER (PARTITION BY resolved.person_id ORDER BY resolved.timer_started_at DESC, resolved.job_id DESC) AS timer_rank
	FROM resolved
	WHERE resolved.person_id IS NOT NULL
)
INSERT INTO "work_sessions" (
	"person_id", "parent_type", "parent_id_snapshot", "job_id", "started_at",
	"status", "source", "review_status", "billing_status", "idempotency_key"
)
SELECT ranked.person_id, 'job', ranked.job_id, ranked.job_id, ranked.timer_started_at,
	'active', 'legacy_timer', 'not_required', 'unbilled', 'legacy-job-timer-0084-' || ranked.job_id
FROM ranked
WHERE ranked.timer_rank = 1
	AND NOT EXISTS (
		SELECT 1 FROM "work_sessions" active
		WHERE active.person_id = ranked.person_id AND active.status = 'active'
	)
	AND NOT EXISTS (
		SELECT 1 FROM "work_sessions" existing
		WHERE existing.idempotency_key = 'legacy-job-timer-0084-' || ranked.job_id
	);--> statement-breakpoint

INSERT INTO "work_session_events" ("session_id", "event_type", "data")
SELECT session.id, 'legacy_imported', jsonb_build_object('migration', '0084', 'source', 'jobs.timer_started_at')
FROM "work_sessions" session
WHERE session.idempotency_key LIKE 'legacy-job-timer-0084-%'
	AND NOT EXISTS (
		SELECT 1 FROM "work_session_events" event
		WHERE event.session_id = session.id AND event.event_type = 'legacy_imported'
	);--> statement-breakpoint

INSERT INTO "time_entries" ("person_id", "job_id", "hours", "timer_started_at")
SELECT session.person_id, session.job_id, 0, session.started_at
FROM "work_sessions" session
WHERE session.idempotency_key LIKE 'legacy-job-timer-0084-%' AND session.job_id IS NOT NULL
ON CONFLICT ("person_id", "job_id") DO UPDATE
SET "timer_started_at" = excluded."timer_started_at", "updated_at" = now();--> statement-breakpoint

UPDATE "jobs" job
SET "timer_started_at" = NULL
WHERE job.timer_started_at IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "work_sessions" session
		WHERE session.idempotency_key = 'legacy-job-timer-0084-' || job.id
	);--> statement-breakpoint

-- Long-term activities used the same legacy global timer and need the same
-- compatibility conversion. Existing time tracking wins over creator linkage.
WITH entry_stats AS (
	SELECT activity_id, min(person_id) AS person_id, count(DISTINCT person_id) AS person_count
	FROM "time_entries"
	WHERE activity_id IS NOT NULL
	GROUP BY activity_id
), resolved AS (
	SELECT activity.id AS activity_id, activity.timer_started_at,
		CASE
			WHEN entries.person_count = 1 THEN entries.person_id
			WHEN entries.person_count IS NULL THEN creator.person_id
			ELSE NULL
		END AS person_id
	FROM "activities" activity
	LEFT JOIN entry_stats entries ON entries.activity_id = activity.id
	LEFT JOIN "users" creator ON creator.id = activity.created_by_user_id
	WHERE activity.timer_started_at IS NOT NULL
), ranked AS (
	SELECT resolved.*,
		row_number() OVER (PARTITION BY resolved.person_id ORDER BY resolved.timer_started_at DESC, resolved.activity_id DESC) AS timer_rank
	FROM resolved
	WHERE resolved.person_id IS NOT NULL
)
INSERT INTO "work_sessions" (
	"person_id", "parent_type", "parent_id_snapshot", "activity_id", "started_at",
	"status", "source", "review_status", "billing_status", "idempotency_key"
)
SELECT ranked.person_id, 'activity', ranked.activity_id, ranked.activity_id, ranked.timer_started_at,
	'active', 'legacy_timer', 'not_required', 'unbilled', 'legacy-activity-timer-0084-' || ranked.activity_id
FROM ranked
WHERE ranked.timer_rank = 1
	AND NOT EXISTS (
		SELECT 1 FROM "work_sessions" active
		WHERE active.person_id = ranked.person_id AND active.status = 'active'
	)
	AND NOT EXISTS (
		SELECT 1 FROM "work_sessions" existing
		WHERE existing.idempotency_key = 'legacy-activity-timer-0084-' || ranked.activity_id
	);--> statement-breakpoint

INSERT INTO "work_session_events" ("session_id", "event_type", "data")
SELECT session.id, 'legacy_imported', jsonb_build_object('migration', '0084', 'source', 'activities.timer_started_at')
FROM "work_sessions" session
WHERE session.idempotency_key LIKE 'legacy-activity-timer-0084-%'
	AND NOT EXISTS (
		SELECT 1 FROM "work_session_events" event
		WHERE event.session_id = session.id AND event.event_type = 'legacy_imported'
	);--> statement-breakpoint

INSERT INTO "time_entries" ("person_id", "activity_id", "hours", "timer_started_at")
SELECT session.person_id, session.activity_id, 0, session.started_at
FROM "work_sessions" session
WHERE session.idempotency_key LIKE 'legacy-activity-timer-0084-%' AND session.activity_id IS NOT NULL
ON CONFLICT ("person_id", "activity_id") DO UPDATE
SET "timer_started_at" = excluded."timer_started_at", "updated_at" = now();--> statement-breakpoint

UPDATE "activities" activity
SET "timer_started_at" = NULL, "updated_at" = now()
WHERE activity.timer_started_at IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "work_sessions" session
		WHERE session.idempotency_key = 'legacy-activity-timer-0084-' || activity.id
	);
