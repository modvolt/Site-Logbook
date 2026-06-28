CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
);
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "ip_address" varchar(45);
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "user_agent" varchar(500);
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp;
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_idx" ON "user_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "user_sessions_expire_idx" ON "user_sessions" ("expire");
