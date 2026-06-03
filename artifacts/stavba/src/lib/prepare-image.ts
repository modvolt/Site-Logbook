const DISPLAYABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function isHeic(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif")
  );
}

/**
 * Prepare an image for upload at FULL quality.
 *
 * We deliberately do NOT downscale or re-compress photos — the original bytes
 * are uploaded as-is so construction documentation keeps its full resolution.
 *
 * The single exception is HEIC/HEIF (iPhone) photos: browsers cannot display
 * them, so they are transcoded to JPEG at maximum quality (quality 1) purely so
 * they can be viewed in the app and embedded in the PDF job sheet.
 */
export async function prepareImageFile(file: File): Promise<File> {
  if (isHeic(file)) {
    const heic2any = (await import("heic2any")).default;
    const blob = (await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 1,
    })) as Blob;
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), {
      type: "image/jpeg",
    });
  }

  // Upload the original file untouched for types the server accepts directly.
  // Reject anything else with a clear message instead of letting the server
  // refuse it with a 415.
  if (!DISPLAYABLE_IMAGE_TYPES.has(file.type)) {
    throw new Error(
      `Formát obrázku není podporován (${file.type || "neznámý"}). Použijte JPEG nebo PNG.`,
    );
  }
  return file;
}
