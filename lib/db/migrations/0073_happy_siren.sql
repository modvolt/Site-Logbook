CREATE TABLE "user_permission_overrides" (
	"user_id" integer NOT NULL,
	"permission" text NOT NULL,
	"effect" text NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_permission_overrides_user_id_permission_pk" PRIMARY KEY("user_id","permission"),
	CONSTRAINT "user_permission_overrides_effect_check" CHECK ("user_permission_overrides"."effect" in ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_permission_overrides_user_id_idx" ON "user_permission_overrides" USING btree ("user_id");