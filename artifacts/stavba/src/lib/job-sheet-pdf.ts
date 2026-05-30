import jsPDF from "jspdf";
import html2canvas from "html2canvas-pro";

export async function renderJobSheetPdf(element: HTMLElement): Promise<jsPDF> {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    ignoreElements: (el) => el.classList?.contains("no-print") ?? false,
  });

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const margin = 8;
  const usableWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * usableWidth) / canvas.width;
  const imgData = canvas.toDataURL("image/jpeg", 0.92);

  if (imgHeight <= pageHeight - margin * 2) {
    doc.addImage(imgData, "JPEG", margin, margin, usableWidth, imgHeight);
    return doc;
  }

  // Paginate a tall canvas across multiple A4 pages.
  const pageUsableHeight = pageHeight - margin * 2;
  const pageCanvasHeight = (pageUsableHeight * canvas.width) / usableWidth;
  let renderedHeight = 0;
  let isFirstPage = true;

  while (renderedHeight < canvas.height) {
    const sliceHeight = Math.min(pageCanvasHeight, canvas.height - renderedHeight);

    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const ctx = pageCanvas.getContext("2d");
    if (!ctx) break;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(
      canvas,
      0,
      renderedHeight,
      canvas.width,
      sliceHeight,
      0,
      0,
      canvas.width,
      sliceHeight,
    );

    const sliceData = pageCanvas.toDataURL("image/jpeg", 0.92);
    const sliceImgHeight = (sliceHeight * usableWidth) / canvas.width;

    if (!isFirstPage) doc.addPage();
    doc.addImage(sliceData, "JPEG", margin, margin, usableWidth, sliceImgHeight);

    renderedHeight += sliceHeight;
    isFirstPage = false;
  }

  return doc;
}

export async function jobSheetPdfBase64(element: HTMLElement): Promise<string> {
  const doc = await renderJobSheetPdf(element);
  const dataUri = doc.output("datauristring");
  return dataUri.split(",")[1] ?? "";
}
