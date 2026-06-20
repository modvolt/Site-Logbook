import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";
import { formatCzk, num, vatBreakdown, type ComputedLine, type VatMode } from "./invoice-calc";

// jsPDF's built-in fonts are WinAnsi-only and cannot render Czech diacritics
// (ř, š, ě, ů…). We embed Roboto (regular + bold) — bundled into the server as
// base64 by the esbuild `.ttf` loader — and use it for every text + table cell.
const PDF_FONT = "Roboto";

export interface InvoicePdfSupplier {
  name: string;
  ic?: string | null;
  dic?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  bankAccount?: string | null;
  iban?: string | null;
  bic?: string | null;
  footerNote?: string | null;
  vatPayer: boolean;
}

export interface InvoicePdfData {
  invoiceNumber: string;
  status: string;
  customerName?: string | null;
  customerIc?: string | null;
  customerDic?: string | null;
  customerAddress?: string | null;
  customerEmail?: string | null;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  currency: string;
  paymentMethod?: string | null;
  variableSymbol?: string | null;
  constantSymbol?: string | null;
  specificSymbol?: string | null;
  vatModeDefault: VatMode;
  notes?: string | null;
  lines: ReadonlyArray<ComputedLine & { description: string; unit?: string | null }>;
  subtotalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  supplier: InvoicePdfSupplier;
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

const PAYMENT_LABELS: Record<string, string> = {
  bank: "Bankovním převodem",
  cash: "Hotově",
  card: "Platební kartou",
};

function paymentLabel(method?: string | null): string {
  if (!method) return "—";
  return PAYMENT_LABELS[method] ?? method;
}

/**
 * Render a Czech tax-document invoice to a PDF Buffer. Pure (no IO besides
 * building the document in memory); the caller persists the bytes.
 */
export function generateInvoicePdf(data: InvoicePdfData): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);

  const isReverseCharge =
    data.vatModeDefault === "reverse_charge" ||
    data.lines.some((l) => l.vatMode === "reverse_charge");
  const taxDocument = data.supplier.vatPayer && data.vatModeDefault !== "non_vat";

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  let y = 18;

  // ---- Title ----
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(18);
  doc.text(taxDocument ? "FAKTURA – daňový doklad" : "FAKTURA", marginX, y);
  doc.setFontSize(12);
  doc.text(data.invoiceNumber, pageWidth - marginX, y, { align: "right" });
  y += 10;

  // ---- Supplier (left) / Customer (right) blocks ----
  const colRightX = pageWidth / 2 + 4;
  const blockTop = y;

  const supplierLines = [
    data.supplier.name,
    data.supplier.address || "",
    data.supplier.ic ? `IČ: ${data.supplier.ic}` : "",
    data.supplier.dic ? `DIČ: ${data.supplier.dic}` : (taxDocument ? "" : "Neplátce DPH"),
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

  // ---- Dates + payment meta (two columns) ----
  doc.setFontSize(9);
  const metaLeft: Array<[string, string]> = [
    ["Datum vystavení:", formatDate(data.issueDate)],
    ["Datum splatnosti:", formatDate(data.dueDate)],
  ];
  if (taxDocument) {
    metaLeft.splice(1, 0, ["DUZP:", formatDate(data.taxableSupplyDate)]);
  }
  const metaRight: Array<[string, string]> = [
    ["Způsob úhrady:", paymentLabel(data.paymentMethod)],
  ];
  if (data.supplier.bankAccount) metaRight.push(["Bankovní účet:", data.supplier.bankAccount]);
  if (data.supplier.iban) metaRight.push(["IBAN:", data.supplier.iban]);
  if (data.variableSymbol) metaRight.push(["Variabilní symbol:", data.variableSymbol]);
  if (data.constantSymbol) metaRight.push(["Konstantní symbol:", data.constantSymbol]);
  if (data.specificSymbol) metaRight.push(["Specifický symbol:", data.specificSymbol]);

  const metaTop = y;
  let mly = metaTop;
  for (const [label, value] of metaLeft) {
    doc.setFont(PDF_FONT, "bold");
    doc.text(label, marginX, mly);
    doc.setFont(PDF_FONT, "normal");
    doc.text(value, marginX + 34, mly);
    mly += 5;
  }
  let mry = metaTop;
  for (const [label, value] of metaRight) {
    doc.setFont(PDF_FONT, "bold");
    doc.text(label, colRightX, mry);
    doc.setFont(PDF_FONT, "normal");
    doc.text(value, colRightX + 34, mry);
    mry += 5;
  }
  y = Math.max(mly, mry) + 4;

  // ---- Line items table ----
  const showVat = taxDocument && !isReverseCharge;
  const head = showVat
    ? [["Popis", "Množ.", "MJ", "Cena/MJ", "Bez DPH", "DPH %", "DPH", "Celkem"]]
    : [["Popis", "Množ.", "MJ", "Cena/MJ", "Celkem"]];

  const body = data.lines.map((l) => {
    const base = [
      l.description,
      String(num(l.quantity)),
      l.unit ?? "",
      formatCzk(l.unitPriceWithoutVat, data.currency),
    ];
    if (showVat) {
      return [
        ...base,
        formatCzk(l.totalWithoutVat, data.currency),
        l.vatRate != null ? `${num(l.vatRate)} %` : "—",
        formatCzk(l.totalVat, data.currency),
        formatCzk(l.totalWithVat, data.currency),
      ];
    }
    return [...base, formatCzk(l.totalWithoutVat, data.currency)];
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

  // ---- Totals ----
  const totalsX = pageWidth - marginX - 70;
  doc.setFontSize(10);
  if (showVat) {
    const breakdown = vatBreakdown(data.lines as ReadonlyArray<ComputedLine>);
    doc.setFont(PDF_FONT, "normal");
    doc.text("Základ daně:", totalsX, y);
    doc.text(formatCzk(data.subtotalWithoutVat, data.currency), pageWidth - marginX, y, {
      align: "right",
    });
    y += 5;
    for (const b of breakdown) {
      doc.text(`DPH ${b.rate} %:`, totalsX, y);
      doc.text(formatCzk(b.vat, data.currency), pageWidth - marginX, y, { align: "right" });
      y += 5;
    }
  } else {
    doc.setFont(PDF_FONT, "normal");
    doc.text("Mezisoučet:", totalsX, y);
    doc.text(formatCzk(data.subtotalWithoutVat, data.currency), pageWidth - marginX, y, {
      align: "right",
    });
    y += 5;
  }

  doc.setDrawColor(180);
  doc.line(totalsX, y, pageWidth - marginX, y);
  y += 6;
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(12);
  doc.text("Celkem k úhradě:", totalsX, y);
  doc.text(formatCzk(data.totalWithVat, data.currency), pageWidth - marginX, y, {
    align: "right",
  });
  y += 10;

  // ---- Reverse-charge (PDP) legal notice ----
  if (isReverseCharge) {
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(9);
    const note =
      "Daň odvede zákazník. Režim přenesení daňové povinnosti podle § 92e zákona o DPH.";
    const wrapped = doc.splitTextToSize(note, pageWidth - marginX * 2);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 5 + 2;
  }

  // ---- Free-text notes + supplier footer note ----
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
