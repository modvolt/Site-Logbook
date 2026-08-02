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
    const metadataStart = quotes.indexOf("function safeErrorMetadata");
    const handlerStart = quotes.indexOf("function handleError");
    expect(metadataStart).toBeGreaterThanOrEqual(0);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const metadata = quotes.slice(metadataStart, handlerStart);
    const handler = quotes.slice(handlerStart, quotes.indexOf("Public share-link routes"));

    expect(handler).toContain(
      'res.status(500).json({ error: fallback, code: "unexpected_error", requestId })',
    );
    expect(handler).toContain("const requestId = requestCorrelationId(res.req)");
    expect(handler).toContain("{ requestId, ...safeErrorMetadata(err) }");
    expect(handler).toContain('"Unexpected quote route error"');
    expect(handler).not.toContain(
      "err instanceof Error ? err.message : fallback",
    );
    expect(metadata).not.toMatch(/message|stack/i);
    expect(handler).not.toContain("err.stack");
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
    expect(uploadRoute).toContain("const requestId = requestCorrelationId(req)");
    expect(uploadRoute).toContain("providerRequestId: providerError?.$metadata?.requestId");
    expect(uploadRoute.match(/req\.log\.error\(\s*\{\s*requestId,/g)).toHaveLength(2);
    expect(uploadRoute).toMatch(
      /res\.status\(500\)\.json\(\{\s*error: "Nepodařilo se uložit soubor do úložiště\.",\s*code: "storage_upload_failed",\s*requestId,\s*\}\)/,
    );
    expect(uploadRoute).toContain(
      'error: "Nepodařilo se uložit soubor do úložiště."',
    );
    expect(uploadRoute).not.toMatch(/AccessKeyId|accessKeyId/);
    expect(uploadRoute).not.toMatch(/HostId|hostId|extendedRequestId/);
    expect(uploadRoute).not.toContain('providerError?.["Endpoint"]');
    expect(uploadRoute).not.toContain("err: error");
    expect(uploadRoute).not.toContain("s3err?.message");
    expect(uploadRoute).not.toContain("error instanceof Error ? error.message");
    expect(uploadRoute).not.toContain("providerError?.message");
    expect(uploadRoute).not.toContain("providerError?.stack");
  });
});
