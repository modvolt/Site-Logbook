import { Router, type IRouter } from "express";
import { desc, sql, lt, gte } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db, clientErrorsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { z } from "zod/v4";
import { logger } from "../lib/logger";

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

/** Default retention period in days (overridden by CLIENT_ERRORS_RETENTION_DAYS env var). */
export const DEFAULT_RETENTION_DAYS = 90;

/** Resolve the effective retention period from env or the default. */
export function resolveRetentionDays(override?: number): number {
  if (override !== undefined && Number.isInteger(override) && override > 0) return override;
  const env = Number(process.env.CLIENT_ERRORS_RETENTION_DAYS);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_RETENTION_DAYS;
}

/**
 * Delete client error rows older than `retentionDays` days.
 * Returns the number of rows deleted.
 */
export async function purgeOldClientErrors(retentionDays?: number): Promise<number> {
  const days = resolveRetentionDays(retentionDays);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(clientErrorsTable)
    .where(lt(clientErrorsTable.createdAt, cutoff))
    .returning({ id: clientErrorsTable.id });
  return result.length;
}

let schedulerStarted = false;

/**
 * Start the periodic client-error purge. Idempotent.
 * Runs every 24 hours. Retention window is CLIENT_ERRORS_RETENTION_DAYS (default 90).
 */
export function startClientErrorPurgeScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const tick = (): void => {
    const days = resolveRetentionDays();
    purgeOldClientErrors(days)
      .then((deleted) => {
        if (deleted > 0) {
          logger.info({ deleted, retentionDays: days }, "Purged old client error records");
        }
      })
      .catch((err) => logger.error({ err }, "Client error purge failed"));
  };

  const intervalMs = 24 * 60 * 60 * 1000;
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  logger.info(
    { retentionDays: resolveRetentionDays(), intervalHours: 24 },
    "Client error purge scheduler started",
  );
}

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

  const sinceRaw = typeof req.query.since === "string" ? req.query.since : undefined;
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;
  const sinceFilter = sinceDate && !isNaN(sinceDate.getTime())
    ? gte(clientErrorsTable.createdAt, sinceDate)
    : undefined;

  const baseQuery = db.select().from(clientErrorsTable);
  const countQuery = db.select({ total: sql<number>`count(*)::int` }).from(clientErrorsTable);

  const [items, [{ total }]] = await Promise.all([
    (sinceFilter ? baseQuery.where(sinceFilter) : baseQuery)
      .orderBy(desc(clientErrorsTable.createdAt))
      .limit(limit)
      .offset(offset),
    sinceFilter ? countQuery.where(sinceFilter) : countQuery,
  ]);

  res.json({
    items: items.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
    total: total ?? 0,
  });
});

router.delete("/client-errors", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const rawDays = Number(req.query.olderThanDays);
  const olderThanDays = Number.isInteger(rawDays) && rawDays > 0 ? rawDays : undefined;
  const days = resolveRetentionDays(olderThanDays);
  const deleted = await purgeOldClientErrors(days);
  req.log.info({ deleted, retentionDays: days }, "Admin triggered client error purge");
  res.json({ deleted, olderThanDays: days });
});

export default router;
