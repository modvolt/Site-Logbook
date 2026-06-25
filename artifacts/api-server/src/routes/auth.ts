import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db, usersTable, securityQuestionsTable, USER_ROLES, type User, type UserRole } from "@workspace/db";
import { LoginBody, SetupFirstAdminBody, ForgotPasswordQuestionsBody, ResetPasswordWithAnswersBody } from "@workspace/api-zod";
import { normalizeAnswer } from "./security-questions";

const router: IRouter = Router();

// Brute-force protection: limit credential-guessing on login and first-admin
// setup. Keyed per client IP (X-Forwarded-For via the app's "trust proxy").
// Localhost is skipped so that E2E tests (which connect directly, before any
// reverse proxy) are never blocked. In production the proxy sets
// X-Forwarded-For and req.ip is the real external IP, so the skip never fires.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Příliš mnoho pokusů. Zkuste to prosím za chvíli." },
  skip: (req) => {
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

function serializeUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

async function countUsers(): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
  return row?.c ?? 0;
}

router.get("/auth/me", async (req, res): Promise<void> => {
  const totalUsers = await countUsers();
  if (req.auth) {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth.userId));
    if (!u || !u.isActive) {
      req.session.destroy(() => undefined);
      res.json({ authenticated: false, needsSetup: totalUsers === 0 });
      return;
    }
    res.json({ authenticated: true, needsSetup: false, user: serializeUser(u) });
    return;
  }
  res.json({ authenticated: false, needsSetup: totalUsers === 0 });
});

router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || !user.isActive) {
    res.status(401).json({ error: "Neplatné přihlašovací údaje" });
    return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Neplatné přihlašovací údaje" });
    return;
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role as UserRole;
  req.session.name = user.name;
  res.json(serializeUser(user));
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.clearCookie("stavba.sid");
    res.sendStatus(204);
  });
});

router.post("/auth/setup", authLimiter, async (req, res): Promise<void> => {
  const total = await countUsers();
  if (total > 0) {
    res.status(409).json({ error: "Setup již proběhl" });
    return;
  }
  const parsed = SetupFirstAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password, name, email } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash, name, email: email ?? null, role: "admin", isActive: true })
    .returning();
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role as UserRole;
  req.session.name = user.name;
  res.status(201).json(serializeUser(user));
});

// --- Forgotten-password reset via security questions (public, admin only) ---

router.post("/auth/forgot-password/questions", authLimiter, async (req, res): Promise<void> => {
  const parsed = ForgotPasswordQuestionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || !user.isActive || user.role !== "admin") {
    res.status(404).json({ error: "Pro tento účet není obnova dostupná" });
    return;
  }
  const questions = await db
    .select({ position: securityQuestionsTable.position, question: securityQuestionsTable.question })
    .from(securityQuestionsTable)
    .where(eq(securityQuestionsTable.userId, user.id))
    .orderBy(securityQuestionsTable.position);
  if (questions.length < 3) {
    res.status(404).json({ error: "Pro tento účet není obnova dostupná" });
    return;
  }
  res.json({ username: user.username, questions });
});

router.post("/auth/forgot-password/reset", authLimiter, async (req, res): Promise<void> => {
  const parsed = ResetPasswordWithAnswersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, answers, newPassword } = parsed.data;
  const fail = () => res.status(401).json({ error: "Nesprávné odpovědi" });

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || !user.isActive || user.role !== "admin") {
    fail();
    return;
  }
  const questions = await db
    .select()
    .from(securityQuestionsTable)
    .where(eq(securityQuestionsTable.userId, user.id));
  if (questions.length < 3) {
    fail();
    return;
  }

  for (const q of questions) {
    const provided = answers.find((a) => a.position === q.position);
    if (!provided) {
      fail();
      return;
    }
    const ok = await bcrypt.compare(normalizeAnswer(provided.answer), q.answerHash);
    if (!ok) {
      fail();
      return;
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
  res.sendStatus(204);
});

export { serializeUser, USER_ROLES };
export default router;
