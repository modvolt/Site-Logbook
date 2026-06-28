import { pgTable, serial, integer, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const webauthnCredentialsTable = pgTable("webauthn_credentials", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  deviceName: text("device_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WebauthnCredential = typeof webauthnCredentialsTable.$inferSelect;
