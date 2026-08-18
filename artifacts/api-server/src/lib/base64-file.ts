export class Base64FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base64FileError";
  }
}

export function decodeCanonicalBase64(encoded: string, maxBytes: number): Buffer {
  if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Base64FileError("Soubor je prázdný nebo příliš velký.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Base64FileError("Soubor nemá platné base64 kódování.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString("base64") !== encoded) {
    throw new Base64FileError("Soubor nemá platné nebo povolené base64 kódování.");
  }
  return buffer;
}
