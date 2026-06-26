import { Router, type IRouter } from "express";
import { desc, sql } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db, clientErrorsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { z } from "zod/v4";

const router: IRouter = Router();

const errorLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Příliš mnoho chybových zpráv." },
  skip: (req) => {
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

const ReportClientErrorBody = z.object({
  message: z.string().max(2000),
  stack: z.string().max(10000).optional(),
  componentStack: z.string().max(10000).optional(),
  path: z.string().max(2000).optional(),
});

router.post("/client-errors", requireAuth, errorLimiter, async (req, res): Promise<void> => {
  const parsed = ReportClientErrorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Neplatná data." });
    return;
  }
  const { message, stack, componentStack, path } = parsed.data;
  const userId: number | undefined = (req.session as { userId?: number }).userId;
  const userRole: string | undefined = (req.session as { userRole?: string }).userRole;
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : undefined;

  await db.insert(clientErrorsTable).values({
    userId: userId ?? null,
    userRole: userRole ?? null,
    message,
    stack: stack ?? null,
    componentStack: componentStack ?? null,
    path: path ?? null,
    userAgent: userAgent ?? null,
  });

  req.log.warn({ clientError: { message, path, userRole } }, "Client-side crash reported");
  res.status(204).end();
});

router.get("/client-errors", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(clientErrorsTable)
      .orderBy(desc(clientErrorsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(clientErrorsTable),
  ]);

  res.json({
    items: items.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
    total: total ?? 0,
  });
});

export default router;
