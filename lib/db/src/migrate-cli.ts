import { runMigrations, MigrationParityError } from "./migrate";

runMigrations()
  .then((summary) => {
    if (summary.newlyApplied > 0) {
      console.log(
        `Migrations applied: ${summary.newlyApplied} new ` +
          `(now ${summary.appliedAfter}/${summary.expectedCount}, latest ${summary.latestExpectedTag}). ` +
          `Folder: ${summary.migrationsFolder}`,
      );
    } else {
      console.log(
        `Database already up to date ` +
          `(${summary.appliedAfter}/${summary.expectedCount} migrations, latest ${summary.latestExpectedTag}). ` +
          `Folder: ${summary.migrationsFolder}`,
      );
    }
    process.exit(0);
  })
  .catch((err) => {
    if (err instanceof MigrationParityError) {
      console.error(err.message);
    } else {
      console.error("Migration failed:", err);
    }
    process.exit(1);
  });
