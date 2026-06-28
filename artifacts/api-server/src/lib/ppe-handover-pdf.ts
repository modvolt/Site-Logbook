import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";

// jsPDF's built-in fonts are WinAnsi-only and cannot render Czech diacritics.
// We embed Roboto (regular + bold) — bundled as base64 by the esbuild .ttf loader.
const PDF_FONT = "Roboto";

function registerFonts(doc: jsPDF): void {
  doc.addFileToVFS("Roboto-Regular.ttf", robotoRegular);
  doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", robotoBold);
  doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function formatDateTime(dt: Date): string {
  return dt.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface PpeHandoverPdfData {
  documentNumber: string;
  companyName: string;
  employeeName: string;
  signatoryName: string;
  signedAt: Date;
  issuerSnapshot: string;
  confirmationText: string;
  signatureDataUrl: string;
  signatureSha256: string;
  ppeNameSnapshot: string;
  ppeCategorySnapshot: string | null;
  ppeStandardSnapshot: string | null;
  ppeProtectionClassSnapshot: string | null;
  ppeRiskDescriptionSnapshot: string | null;
  quantity: number;
  size: string | null;
  serialNumber: string | null;
  issuedAt: string;
  replaceBy: string | null;
  nextInspectionAt: string | null;
}

export function generatePpeHandoverPdf(data: PpeHandoverPdfData): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);
  doc.setFont(PDF_FONT, "normal");

  const marginL = 15;
  const marginR = 15;
  const pageW = 210;
  const contentW = pageW - marginL - marginR;
  let y = 15;

  // ── Header ──────────────────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(16);
  doc.text("Protokol o předání OOPP", marginL, y);
  y += 7;

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(`Číslo protokolu: ${data.documentNumber}`, marginL, y);
  y += 4;
  doc.text(`Datum podpisu: ${formatDateTime(data.signedAt)}`, marginL, y);
  doc.setTextColor(0, 0, 0);
  y += 8;

  // ── Company / Employee ───────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(10);
  doc.text("Zaměstnavatel", marginL, y);
  doc.text("Zaměstnanec", marginL + contentW / 2, y);
  y += 5;
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(10);
  doc.text(data.companyName, marginL, y, { maxWidth: contentW / 2 - 5 });
  doc.text(data.employeeName, marginL + contentW / 2, y, { maxWidth: contentW / 2 });
  y += 10;

  // ── PPE Details table ────────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(10);
  doc.text("Vydané ochranné pomůcky", marginL, y);
  y += 3;

  const tableRows: [string, string][] = [
    ["Pomůcka", data.ppeNameSnapshot],
    ["Kategorie", data.ppeCategorySnapshot ?? "—"],
    ["Norma / standard", data.ppeStandardSnapshot ?? "—"],
    ["Třída ochrany", data.ppeProtectionClassSnapshot ?? "—"],
    ["Počet (ks)", String(data.quantity)],
    ["Velikost", data.size ?? "—"],
    ["Sériové číslo", data.serialNumber ?? "—"],
    ["Datum výdeje", formatDate(data.issuedAt)],
    ["Výměna do", formatDate(data.replaceBy)],
    ["Příští kontrola", formatDate(data.nextInspectionAt)],
  ];

  if (data.ppeRiskDescriptionSnapshot) {
    tableRows.push(["Rizika / ochrana před", data.ppeRiskDescriptionSnapshot]);
  }

  autoTable(doc, {
    startY: y,
    margin: { left: marginL, right: marginR },
    head: [],
    body: tableRows,
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 50, font: PDF_FONT },
      1: { font: PDF_FONT },
    },
    styles: { font: PDF_FONT, fontSize: 9, cellPadding: 2 },
    theme: "striped",
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  // ── Confirmation text ────────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(10);
  doc.text("Potvrzení převzetí", marginL, y);
  y += 5;

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  const confirmLines = doc.splitTextToSize(data.confirmationText, contentW);
  doc.text(confirmLines, marginL, y);
  y += confirmLines.length * 4.5 + 6;

  // ── Signature image ──────────────────────────────────────────────────────────
  const sigW = 80;
  const sigH = 35;
  const sigX = marginL;

  // Check if we have space, else add a page
  if (y + sigH + 30 > 270) {
    doc.addPage();
    y = 15;
  }

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(10);
  doc.text("Podpis zaměstnance", marginL, y);
  y += 4;

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.rect(sigX, y, sigW, sigH);

  try {
    // data.signatureDataUrl is "data:image/png;base64,..."
    doc.addImage(data.signatureDataUrl, "PNG", sigX + 2, y + 2, sigW - 4, sigH - 4);
  } catch {
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("[Podpis]", sigX + sigW / 2, y + sigH / 2, { align: "center" });
    doc.setTextColor(0, 0, 0);
  }

  y += sigH + 4;

  // ── Signatory info ───────────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text(`Podepisující: ${data.signatoryName}`, marginL, y);
  y += 4;
  doc.text(`Čas podpisu: ${formatDateTime(data.signedAt)}`, marginL, y);
  y += 4;
  doc.text(`Vydávající: ${data.issuerSnapshot}`, marginL, y);
  y += 8;

  // ── SHA-256 integrity ────────────────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(130, 130, 130);
  doc.text(`SHA-256 podpisu: ${data.signatureSha256}`, marginL, y, { maxWidth: contentW });
  doc.setTextColor(0, 0, 0);

  // ── Footer on every page ─────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(
      `Protokol o předání OOPP č. ${data.documentNumber} | strana ${i} / ${pageCount}`,
      pageW / 2,
      290,
      { align: "center" },
    );
    doc.setTextColor(0, 0, 0);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
