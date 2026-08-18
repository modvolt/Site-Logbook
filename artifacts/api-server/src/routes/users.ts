import { Router, type IRouter, type Response } from "express";
import { eq, inArray, or, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  peopleTable,
  usersTable,
  userPermissionOverridesTable,
  userSessionsTable,
  USER_ROLES,
  isPermission,
  resolveAccountPermissions,
  type PermissionEffect,
  type UserRole,
  type UserAccountType,
} from "@workspace/db";
import { CreateUserBody, UpdateUserBody, UpdateUserParams, DeleteUserParams } from "@workspace/api-zod";
import { GetUserOffboardingPreviewParams, OffboardUserBody, OffboardUserHeader, OffboardUserParams } from "@workspace/api-zod";
import { requirePermission } from "../middlewares/permissions";
import { requireVaultStepUp } from "../middlewares/auth";
import { serializeUser } from "./auth";
import { getPermissionOverrides } from "../lib/permissions";
import { destroySession } from "../lib/auth-session";
import { getUserOffboardingPreview, lockAndAuthorizeUserManager, offboardUserAccess, UserOffboardingError } from "../lib/user-offboarding-service";

const router: IRouter = Router();

router.use("/users", requirePermission("users.manage"));

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function validatePersonLink(
  personId: number | null | undefined,
  currentUserId?: number,
  client: DbOrTx = db,
) {
  if (personId == null) return null;
  const [person] = await client
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(eq(peopleTable.id, personId));
  const [linkedUser] = await client
    .select({ id: usersTable.id, username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.personId, personId));
  if (!person) return "Vybraný zaměstnanec neexistuje.";
  if (linkedUser && linkedUser.id !== currentUserId) {
    return `Zaměstnanec je již propojen s účtem ${linkedUser.username}.`;
  }
  return null;
}

async function overridesByUser(userIds: number[]) {
  const grouped = new Map<number, Array<{ permission: string; effect: PermissionEffect }>>();
  if (userIds.length === 0) return grouped;
  const rows = await db
    .select()
    .from(userPermissionOverridesTable)
    .where(inArray(userPermissionOverridesTable.userId, userIds));
  for (const row of rows) {
    if (row.effect !== "allow" && row.effect !== "deny") continue;
    const list = grouped.get(row.userId) ?? [];
    list.push({ permission: row.permission, effect: row.effect });
    grouped.set(row.userId, list);
  }
  return grouped;
}

router.get("/users", async (_req, res): Promise<void> => {
  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.accountType, "internal"))
    .orderBy(usersTable.username);
  const overrides = await overridesByUser(users.map((user) => user.id));
  res.json(users.map((user) => serializeUser(user, overrides.get(user.id) ?? [])));
});

router.post("/users", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password, name, email, personId, role, isActive } = parsed.data;
  if (!USER_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: "Neplatná role" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await db.transaction(async (tx) => {
      await lockAndAuthorizeUserManager(tx, req.auth!.userId);
      const existing = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.username, username));
      if (existing.length > 0) {
        throw new UserOffboardingError(409, "username_conflict", "Uživatelské jméno již existuje");
      }
      const personLinkError = await validatePersonLink(personId, undefined, tx);
      if (personLinkError) {
        throw new UserOffboardingError(409, "person_link_conflict", personLinkError);
      }
      const [created] = await tx
        .insert(usersTable)
        .values({
          username,
          passwordHash,
          name,
          personId: personId ?? null,
          email: email ?? null,
          role,
          accountType: "internal",
          isActive: isActive ?? true,
        })
        .returning();
      if (!created) throw new Error("User was not created");
      return created;
    });
    res.status(201).json(serializeUser(user));
  } catch (error) {
    if (sendOffboardingError(res, error)) return;
    throw error;
  }
});

function sendOffboardingError(res: Response, error: unknown): boolean {
  if (!(error instanceof UserOffboardingError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

router.get("/users/:id/offboarding-preview", async (req, res): Promise<void> => {
  const params = GetUserOffboardingPreviewParams.safeParse(req.params);
  if (!params.success || !Number.isSafeInteger(params.data.id) || params.data.id <= 0) {
    res.status(400).json({
      error: params.success ? "Neplatné ID uživatele." : params.error.message,
    });
    return;
  }
  try {
    res.json(
      await getUserOffboardingPreview({
        actorUserId: req.auth!.userId,
        targetUserId: params.data.id,
      }),
    );
  } catch (error) {
    if (sendOffboardingError(res, error)) return;
    throw error;
  }
});

router.post("/users/:id/offboard", requireVaultStepUp, async (req, res): Promise<void> => {
  const params = OffboardUserParams.safeParse(req.params);
  const header = OffboardUserHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  const bodyKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? Object.keys(req.body).sort() : [];
  const exactBodyKeys = ["confirmation", "expectedSessionGeneration", "expectedUsername", "reason"];
  if (!params.success || !Number.isSafeInteger(params.data.id) || params.data.id <= 0 || !header.success || bodyKeys.length !== exactBodyKeys.length || bodyKeys.some((key, index) => key !== exactBodyKeys[index])) {
    res.status(400).json({
      error: "Neplatný nebo neúplný požadavek na odpojení uživatele.",
    });
    return;
  }
  const parsed = OffboardUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!Number.isSafeInteger(parsed.data.expectedSessionGeneration)) {
    res.status(400).json({ error: "Generace session musí být celé číslo." });
    return;
  }
  try {
    res.json(
      await offboardUserAccess({
        actorUserId: req.auth!.userId,
        targetUserId: params.data.id,
        expectedUsername: parsed.data.expectedUsername,
        expectedSessionGeneration: parsed.data.expectedSessionGeneration,
        reason: parsed.data.reason,
      }),
    );
  } catch (error) {
    if (sendOffboardingError(res, error)) return;
    throw error;
  }
});

router.patch("/users/:id", async (req, res): Promise<void> => {
  const params = UpdateUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, email, personId, role, isActive, password } = parsed.data;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (personId !== undefined) {
    const personLinkError = await validatePersonLink(personId, params.data.id);
    if (personLinkError) {
      res.status(409).json({ error: personLinkError });
      return;
    }
    updates.personId = personId;
  }
  if (role !== undefined) {
    if (!USER_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: "Neplatná role" });
      return;
    }
    updates.role = role;
  }
  if (password) updates.passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await db.transaction(async (tx) => {
      await lockAndAuthorizeUserManager(tx, req.auth!.userId);
      await tx.execute(sql`select id from users where id = ${params.data.id} for update`);
      const [currentUser] = await tx.select().from(usersTable).where(eq(usersTable.id, params.data.id));
      if (!currentUser) {
        throw new UserOffboardingError(404, "user_not_found", "User not found");
      }
      if (currentUser.accountType !== "internal") {
        throw new UserOffboardingError(409, "external_account_workflow_required", "ExternĂ­ ĂşÄŤet lze spravovat pouze vyhrazenĂ˝m workflow.");
      }
      if (isActive === false && currentUser.isActive) {
        throw new UserOffboardingError(409, "offboarding_required", "Pro deaktivaci použijte potvrzený offboarding.");
      }
      if (isActive === true && !currentUser.isActive) {
        throw new UserOffboardingError(409, "reactivation_workflow_required", "Reaktivace vyžaduje nové heslo a samostatné potvrzení.");
      }
      if (req.auth?.userId === params.data.id && updates.role && updates.role !== currentUser.role) {
        throw new UserOffboardingError(409, "self_role_change_forbidden", "Nemůžete změnit vlastní roli.");
      }
      if (Object.keys(updates).length === 0) return currentUser;

      const revokeAllSessions = Boolean(password);
      if (revokeAllSessions) updates.sessionGeneration = sql`${usersTable.sessionGeneration} + 1`;
      const [updatedUser] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, params.data.id)).returning();
      if (updatedUser && revokeAllSessions) {
        await tx.delete(userSessionsTable).where(or(eq(userSessionsTable.userId, params.data.id), sql`${userSessionsTable.sess}->>'userId' = ${String(params.data.id)}`));
      }
      return updatedUser;
    });
  } catch (error) {
    if (sendOffboardingError(res, error)) return;
    throw error;
  }
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (password && req.auth?.userId === user.id) {
    await destroySession(req);
    res.clearCookie("stavba.sid");
  }
  res.json(serializeUser(user, await getPermissionOverrides(user.id)));
});

router.put("/users/:id/permissions", async (req, res): Promise<void> => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "Neplatné ID uživatele" });
    return;
  }
  const rawOverrides = Array.isArray(req.body?.overrides) ? req.body.overrides : null;
  if (!rawOverrides) {
    res.status(400).json({ error: "Pole overrides je povinné" });
    return;
  }

  const seen = new Set<string>();
  const overrides: Array<{ permission: string; effect: PermissionEffect }> = [];
  for (const raw of rawOverrides) {
    const permission = typeof raw?.permission === "string" ? raw.permission : "";
    const effect = raw?.effect;
    if (!isPermission(permission) || (effect !== "allow" && effect !== "deny") || seen.has(permission)) {
      res.status(400).json({ error: "Neplatná nebo duplicitní výjimka oprávnění" });
      return;
    }
    seen.add(permission);
    overrides.push({ permission, effect });
  }

  try {
    const target = await db.transaction(async (tx) => {
      await lockAndAuthorizeUserManager(tx, req.auth!.userId);
      await tx.execute(sql`select id from users where id = ${userId} for update`);
      const [lockedTarget] = await tx.select().from(usersTable).where(eq(usersTable.id, userId));
      if (!lockedTarget) {
        throw new UserOffboardingError(404, "user_not_found", "User not found");
      }
      if (!lockedTarget.isActive) {
        throw new UserOffboardingError(409, "user_inactive", "Neaktivnímu účtu nelze udělit oprávnění.");
      }
      if (lockedTarget.accountType !== "internal") {
        throw new UserOffboardingError(409, "external_account_workflow_required", "ExternĂ­ ĂşÄŤet lze spravovat pouze vyhrazenĂ˝m workflow.");
      }
      if (req.auth?.userId === userId && !resolveAccountPermissions(
        lockedTarget.accountType as UserAccountType,
        lockedTarget.role as UserRole,
        overrides,
      ).includes("users.manage")) {
        throw new UserOffboardingError(409, "self_permission_lockout_forbidden", "Nemůžete si odebrat vlastní správu oprávnění.");
      }
      await tx.delete(userPermissionOverridesTable).where(eq(userPermissionOverridesTable.userId, userId));
      if (overrides.length > 0) {
        await tx.insert(userPermissionOverridesTable).values(
          overrides.map((override) => ({
            userId,
            permission: override.permission,
            effect: override.effect,
            updatedByUserId: req.auth!.userId,
            updatedAt: new Date(),
          })),
        );
      }
      return lockedTarget;
    });
    res.json(serializeUser(target, overrides));
  } catch (error) {
    if (sendOffboardingError(res, error)) return;
    throw error;
  }
});

router.delete("/users/:id", async (req, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  res.status(409).json({
    error: "Mazání účtů je kvůli auditní historii vypnuto. Použijte offboarding.",
    code: "user_deletion_retired",
  });
});

export default router;
