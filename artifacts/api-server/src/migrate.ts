import { runMigrations } from "@workspace/db/migrate";
import { logger } from "./lib/logger";

runMigrations()
  .then(() => {
    logger.info("Database migrations applied successfully.");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Database migration failed");
    process.exit(1);
  });
