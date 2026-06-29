import { Router, type IRouter } from "express";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { requireRole } from "../middlewares/auth";
import {
  createBackup,
  getBackup,
  listBackups,
  restoreBackup,
  testBackupRestore,
  getBackupSettings,
  upsertBackupSettings,
  getBackupStatus,
  triggerAutoBackupIfDue,
} from "../lib/backup";
import type { BackupLog } from "@workspace/db";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// All backup operations are restricted to elevated roles (backups contain the
// entire database). Path-scoped so it does not leak to other routers.
router.use("/backups", requireRole("master", "admin"));

function serialize(b: BackupLog) {
  return {
    id: b.id,
    filename: b.filename,
    sizeBytes: b.sizeBytes ?? null,
    status: b.status,
    trigger: b.trigger,
    error: b.error ?? null,
    createdBy: b.createdBy ?? null,
    createdAt: b.createdAt.toISOString(),
    restoreTestedAt: b.restoreTestedAt ? b.restoreTestedAt.toISOString() : null,
    restoreStatus: b.restoreStatus ?? null,
    restoreError: b.restoreError ?? null,
    restoreDurationMs: b.restoreDurationMs ?? null,
    restoreVerifiedTables: b.restoreVerifiedTables ?? null,
  };
}

router.get("/backups", async (_req, res): Promise<void> => {
  const rows = await listBackups();
  const lastSuccess = rows.find((r) => r.status === "success");
  res.json({
    items: rows.map(serialize),
    lastSuccessAt: lastSuccess ? lastSuccess.createdAt.toISOString() : null,
  });
});

router.post("/backups", async (req, res): Promise<void> => {
  try {
    const row = await createBackup({ trigger: "manual", actor: req.auth?.name ?? null });
    res.status(201).json(serialize(row));
  } catch (err) {
    req.log.error({ err }, "Manual backup failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Vytvoření zálohy selhalo.",
    });
  }
});

router.get("/backups/:id/download", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Neplatné ID zálohy." });
    return;
  }
  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    res.status(404).json({ error: "Záloha nenalezena." });
    return;
  }
  res.setHeader("Content-Disposition", `attachment; filename="${row.filename}"`);
  try {
    await objectStorage.servePrivateObject(row.objectPath, res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Soubor zálohy nebyl nalezen v úložišti." });
      return;
    }
    req.log.error({ err, backupId: id }, "Backup download failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Stažení zálohy selhalo." });
    }
  }
});

router.post("/backups/:id/restore", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Neplatné ID zálohy." });
    return;
  }
  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    res.status(404).json({ error: "Záloha nenalezena." });
    return;
  }
  try {
    req.log.warn({ backupId: id, actor: req.auth?.name ?? null }, "Database restore started");
    await restoreBackup(id);
    res.json({ ok: true, message: "Databáze byla obnovena ze zálohy." });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Soubor zálohy nebyl nalezen v úložišti." });
      return;
    }
    req.log.error({ err, backupId: id }, "Database restore failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Obnovení ze zálohy selhalo.",
    });
  }
});

router.post("/backups/:id/restore-test", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Neplatné ID zálohy." });
    return;
  }
  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    res.status(404).json({ error: "Záloha nenalezena." });
    return;
  }
  try {
    req.log.info({ backupId: id, actor: req.auth?.name ?? null }, "Backup restore test started");
    const result = await testBackupRestore(id);
    res.json(serialize(result));
  } catch (err) {
    req.log.error({ err, backupId: id }, "Backup restore test failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Restore test selhal.",
    });
  }
});

router.get("/backups/settings", async (_req, res): Promise<void> => {
  const settings = await getBackupSettings();
  res.json({
    restoreTestDayOfWeek: settings?.restoreTestDayOfWeek ?? null,
    restoreNotifyEmail: settings?.restoreNotifyEmail ?? null,
  });
});

router.put("/backups/settings", async (req, res): Promise<void> => {
  const body = req.body as {
    restoreTestDayOfWeek?: number | null;
    restoreNotifyEmail?: string | null;
  };

  const dayOfWeek = body.restoreTestDayOfWeek ?? null;
  if (dayOfWeek !== null && (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
    res.status(400).json({ error: "restoreTestDayOfWeek must be 0–6 or null." });
    return;
  }

  const email = body.restoreNotifyEmail?.trim() || null;
  const settings = await upsertBackupSettings({
    restoreTestDayOfWeek: dayOfWeek,
    restoreNotifyEmail: email,
  });
  res.json({
    restoreTestDayOfWeek: settings.restoreTestDayOfWeek ?? null,
    restoreNotifyEmail: settings.restoreNotifyEmail ?? null,
  });
});

router.get("/backups/status", async (_req, res): Promise<void> => {
  try {
    const status = await getBackupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Status query failed.",
    });
  }
});

// ─── Internal trigger endpoint ────────────────────────────────────────────────
// Protected by BACKUP_TRIGGER_SECRET (Bearer token in Authorization header).
// Designed for external cron schedulers / Replit Scheduled Deployments.
// Auth is verified in the handler (not via requireRole) because this path is
// in the PUBLIC_PREFIXES allowlist (no session cookie required).

router.post("/internal/backup-trigger", async (req, res): Promise<void> => {
  const secret = process.env.BACKUP_TRIGGER_SECRET;
  if (!secret) {
    res.status(503).json({ error: "BACKUP_TRIGGER_SECRET not configured on this server." });
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Invalid or missing Authorization: Bearer <secret>." });
    return;
  }

  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: "DATABASE_URL not configured." });
    return;
  }

  try {
    const result = await triggerAutoBackupIfDue();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Internal backup trigger failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Trigger failed.",
    });
  }
});

export default router;
