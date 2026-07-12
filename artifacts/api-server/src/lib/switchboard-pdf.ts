import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import type { TextElement } from "./switchboard-parser";

type PdfDocument = Awaited<ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>["promise"]>;

async function loadPdf(buffer: Buffer): Promise<PdfDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try { return await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise; }
  catch (error) { throw classifyPdfError(error); }
}

export function classifyPdfError(error: unknown): Error & { code: string } {
  const source = error as { name?: string; message?: string };
  const text = `${source.name ?? ""} ${source.message ?? ""}`.toLowerCase();
  const code = text.includes("password") || text.includes("encrypted") ? "encrypted_pdf" : text.includes("invalid") || text.includes("corrupt") || text.includes("format") ? "corrupted_pdf" : "pdf_processing_failed";
  return Object.assign(new Error(code === "encrypted_pdf" ? "PDF je zašifrované nebo chráněné heslem." : code === "corrupted_pdf" ? "PDF je poškozené nebo má neplatný formát." : "PDF se nepodařilo načíst."), { code });
}

export async function extractPdfTextElements(buffer: Buffer): Promise<{ pages: number; elements: TextElement[] }> {
  const pdf = await loadPdf(buffer);
  const elements: TextElement[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let order = 0;
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const transform = item.transform;
      elements.push({ text: item.str.trim(), page: pageNumber, order: order++, x: transform[4], y: transform[5], width: item.width, height: item.height, method: "text_layer" });
    }
  }
  return { pages: pdf.numPages, elements };
}

export async function extractPdfOcrElements(buffer: Buffer): Promise<{ pages: number; elements: TextElement[] }> {
  const pdf = await loadPdf(buffer);
  let worker;
  try { worker = await createWorker(["ces", "eng"], 1, {
    langPath: process.env.OCR_LANG_PATH || undefined,
    cachePath: process.env.OCR_CACHE_PATH || undefined,
  }); } catch (error) { throw Object.assign(new Error(`Lokální OCR se nepodařilo spustit: ${error instanceof Error ? error.message : "neznámá chyba"}`), { code: "ocr_failed" }); }
  const elements: TextElement[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      const result = await worker.recognize(canvas.toBuffer("image/png"));
      let order = 0;
      for (const line of result.data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? []) {
        if (!line.text.trim()) continue;
        elements.push({ text: line.text.trim(), page: pageNumber, order: order++, x: line.bbox.x0, y: line.bbox.y0, width: line.bbox.x1 - line.bbox.x0, height: line.bbox.y1 - line.bbox.y0, blockId: `ocr-${pageNumber}-${order}`, method: "ocr" });
      }
    }
  } finally { await worker.terminate(); }
  return { pages: pdf.numPages, elements };
}
