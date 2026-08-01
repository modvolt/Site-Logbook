import { defineConfig } from "vitest/config";
import { ttfBase64 } from "./vitest.config";

/**
 * Explicit database suite. The wrapper refuses ambient DATABASE_URL values and
 * maps a validated local TEST_DATABASE_URL into the child process.
 */
export default defineConfig({
  plugins: [ttfBase64()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    sequence: {
      concurrent: false,
    },
  },
});
