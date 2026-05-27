import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, usersTable, USER_ROLES, type UserRole } from "@workspace/db";
import { CreateUserBody, UpdateUserBody, UpdateUserParams, DeleteUserParams } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { serializeUser } from "./auth";

const router: IRouter = Router();

router.use("/users", requireRole("admin"));

router.get("/users", async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.username);
  res.json(users.map(serializeUser));
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
    if (updates.role && updates.role !== "admin") {
      res.status(400).json({ error: "Nemůžete si odebrat vlastní admin roli" });
      return;
    }
    if (updates.isActive === false) {
      res.status(400).json({ error: "Nemůžete deaktivovat vlastní účet" });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
    if (!u) { res.status(404).json({ error: "User not found" }); return; }
    res.json(serializeUser(u));
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, params.data.id))
    .returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(serializeUser(user));
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
