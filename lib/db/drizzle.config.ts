import { defineConfig } from "drizzle-kit";
import path from "path";

// Note: `DATABASE_URL` is only required for commands that talk to a live
// database (`push`, `migrate`). It is intentionally NOT required for
// `drizzle-kit generate`, which only diffs the schema against the committed
// migration snapshots and must work offline (e.g. in CI / Docker builds).
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // Relative on purpose: drizzle-kit mis-joins an absolute `out` when reading
  // the migration snapshots (produces a `.//abs/path`). The npm scripts run with
  // cwd = this package dir, so "./migrations" resolves correctly for generate/push.
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
