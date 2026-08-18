import { createCanvas, loadImage } from "@napi-rs/canvas";
import { contentMatchesType } from "./fileSignature";

export const MAX_SIGNATURE_BYTES = 500 * 1024;
const MAX_SIGNATURE_DIMENSION = 2_048;
const MAX_SIGNATURE_PIXELS = 2_000_000;
const PREFIX = "data:image/png;base64,";

export class SignatureImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureImageError";
  }
}

export type DecodedSignature = {
  pngBuffer: Buffer;
  dataUrl: string;
  width: number;
  height: number;
};

/** Strictly decode and re-encode a PNG signature before it is stored or embedded. */
export async function decodeSignatureImage(dataUrl: string): Promise<DecodedSignature> {
  if (!dataUrl.startsWith(PREFIX)) {
    throw new SignatureImageError("Podpis musí být PNG data URL.");
  }
  const encoded = dataUrl.slice(PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 + 4) {
    throw new SignatureImageError("Podpis je příliš velký.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new SignatureImageError("Podpis nemá platné base64 kódování.");
  }
  const input = Buffer.from(encoded, "base64");
  if (input.length === 0 || input.length > MAX_SIGNATURE_BYTES) {
    throw new SignatureImageError("Podpis je prázdný nebo příliš velký.");
  }
  if (input.toString("base64") !== encoded) {
    throw new SignatureImageError("Podpis nemá kanonické base64 kódování.");
  }
  if (!contentMatchesType("image/png", input)) {
    throw new SignatureImageError("Soubor podpisu nemá platnou strukturu PNG.");
  }

  try {
    const image = await loadImage(input);
    const width = image.width;
    const height = image.height;
    if (
      width <= 0 ||
      height <= 0 ||
      width > MAX_SIGNATURE_DIMENSION ||
      height > MAX_SIGNATURE_DIMENSION ||
      width * height > MAX_SIGNATURE_PIXELS
    ) {
      throw new SignatureImageError("Rozměry podpisu překračují bezpečný limit.");
    }
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const pngBuffer = canvas.toBuffer("image/png");
    return {
      pngBuffer,
      dataUrl: `${PREFIX}${pngBuffer.toString("base64")}`,
      width,
      height,
    };
  } catch (error) {
    if (error instanceof SignatureImageError) throw error;
    throw new SignatureImageError("Obrázek podpisu se nepodařilo dekódovat.");
  }
}
