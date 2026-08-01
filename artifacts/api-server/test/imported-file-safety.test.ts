import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  bufferReadableWithLimit,
  decodeBase64UrlWithLimit,
  inspectImportedFile,
  resolveImportedContentType,
} from "../src/lib/imported-file-safety";

afterEach(() => {
  delete process.env.UPLOAD_SCANNER_URL;
  delete process.env.UPLOAD_SCANNER_TOKEN;
});

describe("imported file safety", () => {
  it("normalizes a declared alias and safely falls back to the file extension", () => {
    expect(resolveImportedContentType("image/jpg", "scan.jpg")).toBe("image/jpeg");
    expect(resolveImportedContentType("application/octet-stream", "invoice.isdoc")).toBe(
      "application/xml",
    );
    expect(resolveImportedContentType("application/octet-stream", "payload.exe")).toBeNull();
  });

  it("decodes only canonical Base64URL within the declared byte limit", () => {
    const original = Buffer.from([0xfb, 0xff, 0x00, 0x01]);
    const encoded = original.toString("base64url");
    expect(decodeBase64UrlWithLimit(encoded, original.length)).toEqual(original);
    expect(() => decodeBase64UrlWithLimit("+/8=", 2)).toThrow(/Base64URL/);
    expect(() => decodeBase64UrlWithLimit(encoded, original.length + 1)).toThrow(
      /velikost/i,
    );
    expect(() => decodeBase64UrlWithLimit(encoded, original.length, 2)).toThrow(/limit/i);
  });

  it("stops a stream before buffering beyond the attachment cap", async () => {
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);
    await expect(bufferReadableWithLimit(stream, 8)).rejects.toThrow(/limit/i);
    expect(stream.destroyed).toBe(true);
  });

  it("rejects spoofed content and accepts a structurally valid passive document", async () => {
    await expect(
      inspectImportedFile(Buffer.from("not a pdf"), "application/pdf", "invoice.pdf"),
    ).resolves.toMatchObject({ ok: false });

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
    await expect(inspectImportedFile(pdf, "application/pdf", "invoice.pdf")).resolves.toEqual({
      ok: true,
      scan: { verdict: "content_validated" },
    });
  });
});
