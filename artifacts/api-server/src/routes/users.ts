import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  userPermissionOverridesTable,
  USER_ROLES,
  isPermission,
  resolvePermissions,
  type PermissionEffect,
  type UserRole,
} from "@workspace/db";
import { CreateUserBody, UpdateUserBody, UpdateUserParams, DeleteUserParams } from "@workspace/api-zod";
import { requirePermission } from "../middlewares/permissions";
import { serializeUser } from "./auth";
import { getPermissionOverrides } from "../lib/permissions";

const router: IRouter = Router();

router.use("/users", requirePermission("users.manage"));

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
  const users = await db.select().from(usersTable).orderBy(usersTable.username);
  const overrides = await overridesByUser(users.map((user) => user.id));
  res.json(users.map((user) => serializeUser(user, overrides.get(user.id) ?? [])));
});

router.post("/users", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password, name, email, role, isActive } = parsed.data;
  if (!USER_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: "Neplatná role" });
    return;
  }
  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username));
  if (existing.length > 0) {
    res.status(409).json({ error: "Uživatelské jméno již existuje" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      name,
      email: email ?? null,
      role,
      isActive: isActive ?? true,
    })
    .returning();
  res.status(201).json(serializeUser(user));
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
  const { name, email, role, isActive, password } = parsed.data;
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!currentUser) { res.status(404).json({ error: "User not found" }); return; }
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) {
    if (!USER_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: "Neplatná role" });
      return;
    }
    updates.role = role;
  }
  if (isActive !== undefined) updates.isActive = isActive;
  if (password) updates.passwordHash = await bcrypt.hash(password, 10);

  // Prevent locking yourself out
  if (req.auth?.userId === params.data.id) {
    if (updates.role && updates.role !== currentUser.role) {
      res.status(400).json({ error: "Nemůžete změnit vlastní roli" });
      return;
    }
    if (updates.isActive === false) {
      res.status(400).json({ error: "Nemůžete deaktivovat vlastní účet" });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.json(serializeUser(currentUser, await getPermissionOverrides(currentUser.id)));
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, params.data.id))
    .returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
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

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (
    req.auth?.userId === userId &&
    !resolvePermissions(target.role as UserRole, overrides).includes("users.manage")
  ) {
    res.status(400).json({ error: "Nemůžete si odebrat vlastní správu oprávnění" });
    return;
  }

  await db.transaction(async (tx) => {
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
  });

  res.json(serializeUser(target, overrides));
});

router.delete("/users/:id", async (req, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (req.auth?.userId === params.data.id) {
    res.status(400).json({ error: "Nemůžete smazat vlastní účet" });
    return;
  }
  const [user] = await db.delete(usersTable).where(eq(usersTable.id, params.data.id)).returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.sendStatus(204);
});

export default router;
