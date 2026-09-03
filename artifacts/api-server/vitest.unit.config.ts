import { defineConfig } from "vitest/config";
import { ttfBase64 } from "./vitest.config";

/**
 * Fast, hermetic API gate. Files in this suite must not import the application
 * bootstrap or @workspace/db's connection-exporting entry point.
 *
 * DB-backed tests remain in the API test tree and are run only through
 * `pnpm test:db` / `pnpm test:all:isolated` with an explicitly supplied local
 * TEST_DATABASE_URL. R14 will move the remaining DB tests under a reusable
 * ephemeral stack; this allow-list keeps the default gate fail-closed today.
 */
export default defineConfig({
  plugins: [ttfBase64()],
  test: {
    include: [
      "test/**/*contract.test.ts",
      "test/public-bearer-auth.test.ts",
      "test/public-bearer-route-policy.test.ts",
      "test/public-bearer-rate-limit.test.ts",
      "test/trusted-proxy.test.ts",
      "test/webauthn-rp.test.ts",
      "test/permission-resolution.test.ts",
      "test/auth-session.test.ts",
      "test/file-signature.test.ts",
      "test/isdoc-parser.test.ts",
      "test/imported-file-safety.test.ts",
      "test/request-body-security.test.ts",
      "test/public-origin.test.ts",
      "test/signature-image-security.test.ts",
      "test/secret-envelope.test.ts",
      "test/object-recovery.test.ts",
      "test/evidence-hash.test.ts",
      "test/switchboard-qr.test.ts",
      "test/upload-scanner.test.ts",
      "test/upload-abort.test.ts",
      "test/work-session-math.test.ts",
      "test/live-events-domains.test.ts",
      "test/migration-health.test.ts",
      "test/standard-production-migration.test.ts",
      "test/production-exact-0096-backup-producer.test.ts",
      "test/production-exact-0096-backup-producer-entrypoint.test.ts",
      "test/production-exact-0096-object-storage.test.ts",
      "test/production-startup-evidence.test.ts",
      "test/production-runtime-db-credential-cutover.test.ts",
      "test/production-runtime-fail-stop.test.ts",
      "test/operational-alert-outbox-stop.test.ts",
      "test/live-events-shutdown-race.test.ts",
    ],
    exclude: ["test/ppe-contract.test.ts"],
  },
});
