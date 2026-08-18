import { describe, expect, it } from "vitest";
import { decodeSignatureImage, SignatureImageError } from "../src/lib/signature-image";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX8AAAAASUVORK5CYII=";

describe("signature PNG decoding", () => {
  it("decodes and re-encodes an actual PNG", async () => {
    const result = await decodeSignatureImage(`data:image/png;base64,${PNG_BASE64}`);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.pngBuffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.dataUrl).toBe(`data:image/png;base64,${result.pngBuffer.toString("base64")}`);
  });

  it("rejects spoofed, non-canonical and trailing-polyglot data", async () => {
    await expect(decodeSignatureImage("data:image/png;base64,bm90LXBuZw=="))
      .rejects.toBeInstanceOf(SignatureImageError);
    await expect(decodeSignatureImage("data:image/png;base64,AAAA=bad"))
      .rejects.toBeInstanceOf(SignatureImageError);
    const polyglot = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.from("<script>")]);
    await expect(decodeSignatureImage(`data:image/png;base64,${polyglot.toString("base64")}`))
      .rejects.toBeInstanceOf(SignatureImageError);
  });
});
