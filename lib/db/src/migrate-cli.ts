import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.log("Migrations applied successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
