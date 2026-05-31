CREATE TABLE "backup_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"object_path" text,
	"size_bytes" bigint,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
