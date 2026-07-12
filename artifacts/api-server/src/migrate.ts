import { runMigrations, MigrationParityError } from "@workspace/db/migrate";
import { logger } from "./lib/logger";

function migrationErrorDetails(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error) || depth > 3) return { value: String(err) };
  const pg = err as Error & {
    code?: string;
    constraint?: string;
    table?: string;
    column?: string;
    detail?: string;
    where?: string;
    cause?: unknown;
  };
  return {
    name: err.name,
    message: err.message,
    code: pg.code,
    constraint: pg.constraint,
    table: pg.table,
    column: pg.column,
    detail: pg.detail,
    where: pg.where,
    stack: err.stack,
    cause: pg.cause == null ? undefined : migrationErrorDetails(pg.cause, depth + 1),
  };
}

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
    console.log(`[migration] success ${JSON.stringify(base)}`);
    process.exitCode = 0;
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
    // Console output is intentionally synchronous enough for short-lived
    // startup processes. Pino may otherwise lose the last record on exit.
    console.error(`[migration] failure ${JSON.stringify(migrationErrorDetails(err))}`);
    process.exitCode = 1;
  });
