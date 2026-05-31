import { defineConfig } from "drizzle-kit";
import path from "path";

// Note: `DATABASE_URL` is only required for commands that talk to a live
// database (`push`, `migrate`). It is intentionally NOT required for
// `drizzle-kit generate`, which only diffs the schema against the committed
// migration snapshots and must work offline (e.g. in CI / Docker builds).
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./migrations"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
