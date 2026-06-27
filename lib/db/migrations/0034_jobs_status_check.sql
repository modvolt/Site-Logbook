-- Defense-in-depth: restrict free-text jobs.status to the known lifecycle set.
-- Client-facing statuses are planned/in_progress/done/cancelled; the server-only
-- "vyfakturovano" (invoiced) is written directly by the invoice issue flow and
-- reverted to "done" on storno. A DB CHECK guarantees no raw SQL, future
-- endpoint, or migration mistake can write a phantom/invalid status.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('planned', 'in_progress', 'done', 'cancelled', 'vyfakturovano'));--> statement-breakpoint
-- Mirror the same hardening for activities.billing_status: NULL (not tracked) or
-- the known intents only. "billed" is retained for rows with a live invoice link;
-- editable intents are billable/not_billable.
ALTER TABLE "activities" ADD CONSTRAINT "activities_billing_status_check" CHECK ("activities"."billing_status" IS NULL OR "activities"."billing_status" IN ('billable', 'not_billable', 'billed'));
