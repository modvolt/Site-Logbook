import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const securityQuestionsTable = pgTable(
  "security_questions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    question: text("question").notNull(),
    answerHash: text("answer_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("security_questions_user_position_unique").on(t.userId, t.position)],
);

export const insertSecurityQuestionSchema = createInsertSchema(securityQuestionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSecurityQuestion = z.infer<typeof insertSecurityQuestionSchema>;
export type SecurityQuestion = typeof securityQuestionsTable.$inferSelect;
