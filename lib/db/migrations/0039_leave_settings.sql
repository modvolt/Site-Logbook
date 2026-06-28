CREATE TABLE "leave_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"vacation_yearly_cap" integer DEFAULT 25 NOT NULL,
	"sick_yearly_cap" integer DEFAULT 60 NOT NULL,
	"other_yearly_cap" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
