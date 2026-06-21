CREATE TABLE "openai_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key" text,
	"model" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
