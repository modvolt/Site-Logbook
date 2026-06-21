CREATE TABLE "material_markup_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"markup_percent" numeric(6, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "material_markup_rules_category_uq" ON "material_markup_rules" USING btree (lower("category"));