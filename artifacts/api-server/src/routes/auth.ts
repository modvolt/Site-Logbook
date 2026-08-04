import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db, usersTable, USER_ROLES, resolvePermissions, type PermissionEffect, type User, type UserRole } from "@workspace/db";
import { LoginBody, SetupFirstAdminBody, VerifyVaultPasswordBody } from "@workspace/api-zod";
import { getPermissionOverrides } from "../lib/permissions";
import {
  destroySessionOrRevokeIdentity,
  establishAuthenticatedSession,
} from "../lib/auth-session";
import { establishVaultStepUp } from "../lib/vault-step-up";
import { createOfflineIdentityScope } from "../lib/offline-identity";

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

const vaultPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Příliš mnoho pokusů o ověření. Zkuste to prosím za chvíli." },
  skip: (req) => {
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

function serializeUser(
  u: User,
  overrides: ReadonlyArray<{ permission: string; effect: PermissionEffect }> = [],
) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    personId: u.personId,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
    permissions: resolvePermissions(u.role as UserRole, overrides),
    permissionOverrides: overrides,
  };
}

async function countUsers(): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
  return row?.c ?? 0;
}

const FIRST_ADMIN_SETUP_LOCK = 1_297_040_470;

async function createFirstAdmin(input: {
  username: string;
  passwordHash: string;
  name: string;
  email?: string | null;
}) {
  return db.transaction(async (tx) => {
    // Serialize first-run setup across all API instances. The count and insert
    // must share this transaction; otherwise two different usernames can both
    // become administrators during the initial deployment window.
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_ADMIN_SETUP_LOCK})`);
    const [row] = await tx.select({ c: sql<number>`count(*)::int` }).from(usersTable);
    if ((row?.c ?? 0) > 0) return null;
    const [user] = await tx
      .insert(usersTable)
      .values({
        username: input.username,
        passwordHash: input.passwordHash,
        name: input.name,
        email: input.email ?? null,
        role: "admin",
        isActive: true,
      })
      .returning();
    return user;
  });
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
    const overrides = await getPermissionOverrides(u.id);
    const user = serializeUser(u, overrides);
    res.json({
      authenticated: true,
      needsSetup: false,
      offlineScope: createOfflineIdentityScope({
        userId: u.id,
        sessionGeneration: u.sessionGeneration,
        role: u.role as UserRole,
        permissions: user.permissions,
      }),
      user,
    });
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
  const overrides = await getPermissionOverrides(user.id);
  await establishAuthenticatedSession(req, user);
  res.json(serializeUser(user, overrides));
});

router.post("/auth/logout", async (req, res, next): Promise<void> => {
  try {
    await destroySessionOrRevokeIdentity(req, async (userId) => {
      const [revoked] = await db
        .update(usersTable)
        .set({ sessionGeneration: sql`${usersTable.sessionGeneration} + 1` })
        .where(eq(usersTable.id, userId))
        .returning({ id: usersTable.id });
      if (!revoked) throw new Error("Authenticated user disappeared during logout");
    });
    res.clearCookie("stavba.sid");
    res.sendStatus(204);
  } catch (error) {
    res.clearCookie("stavba.sid");
    next(error);
  }
});

router.post(
  "/auth/vault/verify-password",
  vaultPasswordLimiter,
  async (req, res): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = VerifyVaultPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [user] = await db
      .select({ passwordHash: usersTable.passwordHash, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, req.auth.userId));
    const verified = !!user?.isActive && await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!verified) {
      res.status(401).json({ error: "Ověření se nezdařilo" });
      return;
    }

    const result = await establishVaultStepUp(req, "password");
    res.json({
      verified: true,
      method: "password",
      expiresAt: new Date(result.expiresAt).toISOString(),
    });
  },
);

router.post("/auth/setup", authLimiter, async (req, res): Promise<void> => {
  const parsed = SetupFirstAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password, name, email } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await createFirstAdmin({ username, passwordHash, name, email });
  if (!user) {
    res.status(409).json({ error: "Setup již proběhl" });
    return;
  }
  const overrides = await getPermissionOverrides(user.id);
  await establishAuthenticatedSession(req, user);
  res.status(201).json(serializeUser(user, overrides));
});

export { serializeUser, USER_ROLES };
export default router;
