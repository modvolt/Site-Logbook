CREATE TABLE "ppe_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'ostatni',
  "description" text,
  "default_replacement_months" integer,
  "default_inspection_months" integer,
  "active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ppe_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "ppe_item_id" integer NOT NULL,
  "person_id" integer NOT NULL,
  "ppe_name_snapshot" text NOT NULL,
  "person_name_snapshot" text NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "size" text,
  "serial_number" text,
  "issued_at" date NOT NULL,
  "replace_by" date,
  "next_inspection_at" date,
  "returned_at" date,
  "status" text NOT NULL DEFAULT 'issued',
  "employee_confirmed_at" timestamp,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ppe_assignments_ppe_item_id_ppe_items_id_fk" FOREIGN KEY ("ppe_item_id") REFERENCES "public"."ppe_items"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "ppe_assignments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ppe_assignments_person_id_idx" ON "ppe_assignments" ("person_id");
--> statement-breakpoint
CREATE INDEX "ppe_assignments_ppe_item_id_idx" ON "ppe_assignments" ("ppe_item_id");
--> statement-breakpoint
CREATE INDEX "ppe_assignments_status_idx" ON "ppe_assignments" ("status");
--> statement-breakpoint
CREATE INDEX "ppe_assignments_replace_by_idx" ON "ppe_assignments" ("replace_by");
--> statement-breakpoint
CREATE INDEX "ppe_assignments_next_inspection_idx" ON "ppe_assignments" ("next_inspection_at");
