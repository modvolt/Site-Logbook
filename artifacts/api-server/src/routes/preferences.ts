import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, userPreferencesTable } from "@workspace/db";
import { UpdateMyPreferencesBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function serialize(row: { exportColumns: string[] | null } | undefined) {
  return { exportColumns: row?.exportColumns ?? null };
}

router.get("/preferences", requireAuth, async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const [row] = await db
    .select()
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId));
  res.json(serialize(row));
});

router.put("/preferences", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateMyPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = req.auth!.userId;
  const exportColumns = parsed.data.exportColumns ?? null;
  const [row] = await db
    .insert(userPreferencesTable)
    .values({ userId, exportColumns, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferencesTable.userId,
      set: { exportColumns, updatedAt: new Date() },
    })
    .returning();
  res.json(serialize(row));
});

export default router;
