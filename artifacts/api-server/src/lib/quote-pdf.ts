import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";

const PDF_FONT = "Roboto";

export interface QuotePdfSupplier {
  name: string;
  ic?: string | null;
  dic?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  footerNote?: string | null;
  vatPayer: boolean;
}

export interface QuotePdfItem {
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  vatRate: number | null;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

export interface QuotePdfData {
  quoteNumber: string;
  customerName?: string | null;
  customerIc?: string | null;
  customerDic?: string | null;
  customerAddress?: string | null;
  customerEmail?: string | null;
  validUntil?: string | null;
  notes?: string | null;
  items: QuotePdfItem[];
  subtotalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  supplier: QuotePdfSupplier;
  currency: string;
}

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

function formatCzk(n: number, currency: string): string {
  return `${n.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Render a quote PDF to a Buffer. Pure (no IO); the caller persists the bytes.
 */
export function generateQuotePdf(data: QuotePdfData): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  let y = 18;

  // ---- Title ----
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(18);
  doc.text("CENOVÁ NABÍDKA", marginX, y);
  doc.setFontSize(12);
  doc.text(data.quoteNumber, pageWidth - marginX, y, { align: "right" });
  y += 10;

  // ---- Supplier (left) / Customer (right) blocks ----
  const colRightX = pageWidth / 2 + 4;
  const blockTop = y;

  const supplierLines = [
    data.supplier.name,
    data.supplier.address || "",
    data.supplier.ic ? `IČ: ${data.supplier.ic}` : "",
    data.supplier.dic ? `DIČ: ${data.supplier.dic}` : (!data.supplier.vatPayer ? "Neplátce DPH" : ""),
    data.supplier.email || "",
    data.supplier.phone || "",
  ].filter((l) => l.length > 0);

  const customerLines = [
    data.customerName || "—",
    data.customerAddress || "",
    data.customerIc ? `IČ: ${data.customerIc}` : "",
    data.customerDic ? `DIČ: ${data.customerDic}` : "",
    data.customerEmail || "",
  ].filter((l) => l.length > 0);

  doc.setFontSize(9);
  doc.setFont(PDF_FONT, "bold");
  doc.text("Dodavatel", marginX, blockTop);
  doc.text("Odběratel", colRightX, blockTop);
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(10);

  let ly = blockTop + 6;
  for (const line of supplierLines) {
    doc.text(line, marginX, ly);
    ly += 5;
  }
  let ry = blockTop + 6;
  for (const line of customerLines) {
    doc.text(line, colRightX, ry);
    ry += 5;
  }
  y = Math.max(ly, ry) + 4;

  // ---- Meta (validity) ----
  doc.setFontSize(9);
  if (data.validUntil) {
    doc.setFont(PDF_FONT, "bold");
    doc.text("Platnost nabídky:", marginX, y);
    doc.setFont(PDF_FONT, "normal");
    doc.text(formatDate(data.validUntil), marginX + 36, y);
    y += 7;
  }

  // ---- Line items table ----
  const showVat = data.supplier.vatPayer;
  const head = showVat
    ? [["Popis", "Množ.", "MJ", "Cena/MJ", "Bez DPH", "DPH %", "DPH", "Celkem"]]
    : [["Popis", "Množ.", "MJ", "Cena/MJ", "Celkem"]];

  const body = data.items.map((item) => {
    const base = [
      item.description,
      String(num(item.quantity)),
      item.unit ?? "",
      formatCzk(item.unitPrice, data.currency),
    ];
    if (showVat) {
      return [
        ...base,
        formatCzk(item.totalWithoutVat, data.currency),
        item.vatRate != null ? `${num(item.vatRate)} %` : "—",
        formatCzk(item.totalVat, data.currency),
        formatCzk(item.totalWithVat, data.currency),
      ];
    }
    return [...base, formatCzk(item.totalWithoutVat, data.currency)];
  });

  autoTable(doc, {
    startY: y,
    head,
    body,
    margin: { left: marginX, right: marginX },
    styles: { font: PDF_FONT, fontStyle: "normal", fontSize: 8, cellPadding: 1.6 },
    headStyles: { font: PDF_FONT, fontStyle: "bold", fillColor: [37, 99, 235], textColor: 255 },
    columnStyles: showVat
      ? {
          0: { cellWidth: "auto" },
          1: { halign: "right", cellWidth: 14 },
          2: { cellWidth: 10 },
          3: { halign: "right", cellWidth: 22 },
          4: { halign: "right", cellWidth: 22 },
          5: { halign: "right", cellWidth: 14 },
          6: { halign: "right", cellWidth: 20 },
          7: { halign: "right", cellWidth: 24 },
        }
      : {
          0: { cellWidth: "auto" },
          1: { halign: "right", cellWidth: 18 },
          2: { cellWidth: 14 },
          3: { halign: "right", cellWidth: 30 },
          4: { halign: "right", cellWidth: 32 },
        },
  });

  const afterTable = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable;
  y = (afterTable?.finalY ?? y + 20) + 8;

  // ---- Page-break guard for totals block ----
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + 40 > pageHeight - marginX) {
    doc.addPage();
    y = 20;
  }

  // ---- Totals ----
  const totalsX = pageWidth - marginX - 70;
  doc.setFontSize(10);
  if (showVat) {
    doc.setFont(PDF_FONT, "normal");
    doc.text("Celkem bez DPH:", totalsX, y);
    doc.text(formatCzk(data.subtotalWithoutVat, data.currency), pageWidth - marginX, y, { align: "right" });
    y += 5;
    doc.text("DPH celkem:", totalsX, y);
    doc.text(formatCzk(data.totalVat, data.currency), pageWidth - marginX, y, { align: "right" });
    y += 5;
  } else {
    doc.setFont(PDF_FONT, "normal");
    doc.text("Mezisoučet:", totalsX, y);
    doc.text(formatCzk(data.subtotalWithoutVat, data.currency), pageWidth - marginX, y, { align: "right" });
    y += 5;
  }

  doc.setDrawColor(180);
  doc.line(totalsX, y, pageWidth - marginX, y);
  y += 6;
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(12);
  doc.text("Celková cena:", totalsX, y);
  doc.text(formatCzk(data.totalWithVat, data.currency), pageWidth - marginX, y, { align: "right" });
  y += 10;

  // ---- Notes + footer note ----
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  if (data.notes) {
    const wrapped = doc.splitTextToSize(data.notes, pageWidth - marginX * 2);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 5 + 2;
  }
  if (data.supplier.footerNote) {
    const wrapped = doc.splitTextToSize(data.supplier.footerNote, pageWidth - marginX * 2);
    doc.text(wrapped, marginX, y);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
