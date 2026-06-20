import app from "./app";
import { logger } from "./lib/logger";
import { startBackupScheduler } from "./lib/backup";
import { startReminderScheduler } from "./lib/invoice-reminders";
import { startExtractionWorker } from "./lib/extraction-worker";
import { describeObjectStorageConfig } from "./lib/objectStorage";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info(describeObjectStorageConfig(), "Object storage configuration");
  startBackupScheduler();
  startReminderScheduler();
  startExtractionWorker();
});
