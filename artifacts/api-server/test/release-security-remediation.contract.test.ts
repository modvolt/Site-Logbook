import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("phase 13.4 release security remediation", () => {
  it("targets the declared PostgreSQL 16 runtime in the remote DB gate", () => {
    const workflow = read(".github/workflows/quality-gate.yml");

    expect(workflow).toContain("image: postgres:16-alpine");
    expect(workflow).not.toContain("image: postgres:18-alpine");
  });

  it("does not expose unexpected quote errors to public token clients", () => {
    const quotes = read("artifacts/api-server/src/routes/quotes.ts");

    expect(quotes).toContain(
      'res.status(500).json({ error: fallback, code: "unexpected_error" })',
    );
    expect(quotes).not.toContain(
      "err instanceof Error ? err.message : fallback",
    );
  });

  it("redacts storage provider messages and credential identifiers", () => {
    const storage = read("artifacts/api-server/src/routes/storage.ts");
    const uploadStart = storage.indexOf('"/storage/uploads"');
    expect(uploadStart).toBeGreaterThanOrEqual(0);
    const uploadRoute = storage.slice(
      uploadStart,
      storage.indexOf("GET /storage/diagnose"),
    );

    expect(uploadRoute).toContain('code: "storage_upload_failed"');
    expect(uploadRoute).toContain(
      'error: "Nepodařilo se uložit soubor do úložiště."',
    );
    expect(uploadRoute).not.toMatch(/AWSAccessKeyId|awsAccessKeyId/);
    expect(uploadRoute).not.toContain("err: error");
    expect(uploadRoute).not.toContain("s3err?.message");
    expect(uploadRoute).not.toContain("error instanceof Error ? error.message");
  });
});
