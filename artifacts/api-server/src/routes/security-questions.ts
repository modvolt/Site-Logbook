import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, usersTable, securityQuestionsTable } from "@workspace/db";
import { SetSecurityQuestionsBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Normalize a security answer so trivial differences (casing, surrounding or
// repeated whitespace) don't cause a correct answer to be rejected. The same
// normalization runs on write and on verify.
export function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

router.get("/security-questions/status", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select({ id: securityQuestionsTable.id })
    .from(securityQuestionsTable)
    .where(eq(securityQuestionsTable.userId, req.auth!.userId));
  res.json({ configured: rows.length >= 3 });
});

router.put("/security-questions", requireAuth, async (req, res): Promise<void> => {
  if (req.auth!.role !== "admin") {
    res.status(403).json({ error: "Pouze administrátor" });
    return;
  }
  const parsed = SetSecurityQuestionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { currentPassword, questions } = parsed.data;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth!.userId));
  if (!user || !user.isActive) {
    res.status(401).json({ error: "Neautorizováno" });
    return;
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Nesprávné aktuální heslo" });
    return;
  }

  const rows = await Promise.all(
    questions.map(async (q, i) => ({
      userId: user.id,
      position: i + 1,
      question: q.question.trim(),
      answerHash: await bcrypt.hash(normalizeAnswer(q.answer), 10),
    })),
  );

  await db.transaction(async (tx) => {
    await tx.delete(securityQuestionsTable).where(eq(securityQuestionsTable.userId, user.id));
    await tx.insert(securityQuestionsTable).values(rows);
  });

  res.sendStatus(204);
});

export default router;
