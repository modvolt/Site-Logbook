import { afterEach, describe, expect, it, vi } from "vitest";
import { scanUploadContent } from "../src/lib/upload-scanner";

afterEach(() => {
  delete process.env.UPLOAD_SCANNER_URL;
  delete process.env.UPLOAD_SCANNER_TOKEN;
  vi.unstubAllGlobals();
});

describe("upload scanner hook", () => {
  it("fails closed for Office containers when no scanner is configured", async () => {
    await expect(scanUploadContent(
      Buffer.from("ole"),
      "application/msword",
      "contract.doc",
    )).resolves.toMatchObject({ verdict: "unavailable" });
  });

  it("allows magic-validated passive content without an external scanner", async () => {
    await expect(scanUploadContent(Buffer.from("pdf"), "application/pdf", "invoice.pdf"))
      .resolves.toEqual({ verdict: "content_validated" });
  });

  it("honors clean/malicious verdicts and fails closed on timeout/error", async () => {
    process.env.UPLOAD_SCANNER_URL = "https://scanner.invalid/scan";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verdict: "clean" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verdict: "malicious" }), { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(scanUploadContent(Buffer.from("a"), "application/pdf", "a.pdf"))
      .resolves.toEqual({ verdict: "clean" });
    await expect(scanUploadContent(Buffer.from("b"), "application/pdf", "b.pdf"))
      .resolves.toMatchObject({ verdict: "malicious" });
    await expect(scanUploadContent(Buffer.from("c"), "application/pdf", "c.pdf"))
      .resolves.toMatchObject({ verdict: "unavailable" });
  });
});
