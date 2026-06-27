import { runMigrations, MigrationParityError } from "@workspace/db/migrate";
import { logger } from "./lib/logger";

runMigrations()
  .then((summary) => {
    const base = {
      migrationsFolder: summary.migrationsFolder,
      expected: summary.expectedCount,
      applied: summary.appliedAfter,
      newlyApplied: summary.newlyApplied,
      latestExpected: summary.latestExpectedTag,
    };
    if (summary.newlyApplied > 0) {
      logger.info(
        base,
        `Database migrations applied: ${summary.newlyApplied} new ` +
          `(now ${summary.appliedAfter}/${summary.expectedCount}, latest ${summary.latestExpectedTag}).`,
      );
    } else {
      logger.info(
        base,
        `Database already up to date ` +
          `(${summary.appliedAfter}/${summary.expectedCount} migrations, latest ${summary.latestExpectedTag}).`,
      );
    }
    process.exit(0);
  })
  .catch((err) => {
    if (err instanceof MigrationParityError || err?.name === "MigrationParityError") {
      logger.error(
        {
          migrationsFolder: err.summary?.migrationsFolder,
          expected: err.summary?.expectedCount,
          applied: err.summary?.appliedAfter,
          missing: err.missingTags,
        },
        err.message,
      );
    } else {
      logger.error({ err }, "Database migration failed");
    }
    process.exit(1);
  });
