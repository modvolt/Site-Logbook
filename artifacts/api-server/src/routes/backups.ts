import { Router, type IRouter } from "express";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { requireRole } from "../middlewares/auth";
import { createBackup, getBackup, listBackups } from "../lib/backup";
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

export default router;
