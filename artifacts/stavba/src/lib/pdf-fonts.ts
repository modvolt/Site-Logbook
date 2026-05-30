import type jsPDF from "jspdf";
import robotoRegularUrl from "@/assets/fonts/Roboto-Regular.ttf?url";
import robotoBoldUrl from "@/assets/fonts/Roboto-Bold.ttf?url";

export const PDF_FONT = "Roboto";

let cache: { regular: string; bold: string } | null = null;

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Nepodařilo se načíst font (${res.status}): ${url}`);
  }
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const base64 = dataUrl.split(",")[1] ?? "";
  if (!base64) {
    throw new Error(`Prázdná data fontu: ${url}`);
  }
  return base64;
}

/**
 * Registers the Roboto font (regular + bold) on a jsPDF document so Czech
 * diacritics render correctly. jsPDF's built-in fonts are WinAnsi-only and
 * cannot display characters like ř, š, ě, ů. Base64 payloads are cached.
 */
export async function registerPdfFonts(doc: jsPDF): Promise<string> {
  if (!cache) {
    const [regular, bold] = await Promise.all([
      fetchAsBase64(robotoRegularUrl),
      fetchAsBase64(robotoBoldUrl),
    ]);
    cache = { regular, bold };
  }
  doc.addFileToVFS("Roboto-Regular.ttf", cache.regular);
  doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", cache.bold);
  doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
  doc.setFont(PDF_FONT, "normal");
  return PDF_FONT;
}
