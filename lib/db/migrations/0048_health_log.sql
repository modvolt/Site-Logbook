CREATE TABLE "health_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"db_ok" boolean NOT NULL,
	"db_latency_ms" integer,
	"s3_ok" boolean NOT NULL,
	"smtp_ok" boolean NOT NULL,
	"overall_status" text DEFAULT 'ok' NOT NULL
);
