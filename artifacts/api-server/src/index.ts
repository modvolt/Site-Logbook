import app from "./app";
import { logger } from "./lib/logger";
import { startBackupScheduler, startRestoreTestScheduler, checkPgDumpAvailability } from "./lib/backup";
import { startReminderScheduler } from "./lib/invoice-reminders";
import { startExtractionWorker } from "./lib/extraction-worker";
import { startEmailImportWorker } from "./lib/email-import";
import { startClientErrorPurgeScheduler } from "./routes/client-errors";
import { describeObjectStorageConfig } from "./lib/objectStorage";
import { startPpeOverdueScheduler } from "./lib/ppe-overdue-notifier";
import { startHealthWatchdog } from "./lib/health-watchdog";
import { startRecurringInvoiceScheduler } from "./lib/recurring-templates";
import { startLiveEventsService, shutdownLiveEventsService } from "./lib/live-events-service";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info(describeObjectStorageConfig(), "Object storage configuration");
  checkPgDumpAvailability().catch((e) => logger.warn({ err: e }, "pg_dump availability check failed"));
  startBackupScheduler();
  startRestoreTestScheduler();
  startReminderScheduler();
  startExtractionWorker();
  startEmailImportWorker();
  startClientErrorPurgeScheduler();
  startPpeOverdueScheduler();
  startHealthWatchdog();
  startRecurringInvoiceScheduler();

  // Start the PG LISTEN service for cross-instance SSE event broadcasting.
  startLiveEventsService().catch((e) =>
    logger.warn({ err: e }, "Failed to start live-events PG LISTEN service"),
  );
});

// Graceful shutdown: give in-flight requests 10s to finish, then close.
const shutdown = () => {
  logger.info("SIGTERM received — shutting down gracefully");
  void shutdownLiveEventsService();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
