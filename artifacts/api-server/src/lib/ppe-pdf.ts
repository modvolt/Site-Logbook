import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";

const PDF_FONT = "Roboto";

function registerFonts(doc: jsPDF): void {
  doc.addFileToVFS("Roboto-Regular.ttf", robotoRegular);
  doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", robotoBold);
  doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  hlava: "Hlava",
  ruky: "Ruce",
  telo: "Tělo",
  nohy: "Nohy",
  oci: "Oči",
  sluch: "Sluch",
  dychaci: "Dýchací cesty",
  ostatni: "Ostatní",
};

const STATUS_LABELS: Record<string, string> = {
  issued: "Vydáno",
  returned: "Vráceno",
  damaged: "Poškozeno",
  lost: "Ztraceno",
  disposed: "Zlikvidováno",
};

export interface PpeExportRow {
  personNameSnapshot: string;
  ppeNameSnapshot: string;
  category: string;
  quantity: number;
  size: string | null;
  serialNumber: string | null;
  issuedAt: string;
  replaceBy: string | null;
  returnedAt: string | null;
  status: string;
}

export function generatePpePdf(rows: PpeExportRow[], companyName?: string | null): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  registerFonts(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  let y = 16;

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(14);
  doc.text("OOPP – Registr vydaných ochranných pracovních prostředků", marginX, y);
  y += 8;

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  if (companyName) {
    doc.text(companyName, marginX, y);
    y += 5;
  }
  doc.text(`Vytištěno: ${fmtDate(new Date().toISOString().slice(0, 10))}`, marginX, y);
  doc.text(`Počet záznamů: ${rows.length}`, pageWidth - marginX, y, { align: "right" });
  y += 6;

  autoTable(doc, {
    startY: y,
    head: [["Zaměstnanec", "Pomůcka", "Kategorie", "Počet", "Vel.", "Sér. číslo", "Vydáno", "Výměna do", "Vráceno", "Stav"]],
    body: rows.map((r) => [
      r.personNameSnapshot,
      r.ppeNameSnapshot,
      CATEGORY_LABELS[r.category] ?? r.category,
      String(r.quantity),
      r.size ?? "—",
      r.serialNumber ?? "—",
      fmtDate(r.issuedAt),
      fmtDate(r.replaceBy),
      fmtDate(r.returnedAt),
      STATUS_LABELS[r.status] ?? r.status,
    ]),
    styles: {
      font: PDF_FONT,
      fontStyle: "normal",
      fontSize: 8,
    },
    headStyles: {
      font: PDF_FONT,
      fontStyle: "bold",
      fillColor: [30, 64, 175],
      textColor: 255,
      fontSize: 8,
    },
    alternateRowStyles: { fillColor: [245, 247, 255] },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { cellWidth: 38 },
      2: { cellWidth: 24 },
      3: { cellWidth: 12, halign: "center" },
      4: { cellWidth: 14, halign: "center" },
      5: { cellWidth: 26 },
      6: { cellWidth: 22 },
      7: { cellWidth: 22 },
      8: { cellWidth: 22 },
      9: { cellWidth: 20 },
    },
    margin: { left: marginX, right: marginX },
    didDrawPage: (data) => {
      const pgNum = (doc as any).internal.getCurrentPageInfo().pageNumber;
      doc.setFont(PDF_FONT, "normal");
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Strana ${pgNum}`, pageWidth - marginX, doc.internal.pageSize.getHeight() - 8, { align: "right" });
      doc.setTextColor(0);
    },
  });

  return Buffer.from(doc.output("arraybuffer"));
}

export function generatePpeCsv(rows: PpeExportRow[]): string {
  const BOM = "\uFEFF";
  const headers = [
    "Zaměstnanec",
    "Pomůcka",
    "Kategorie",
    "Počet",
    "Velikost",
    "Sériové číslo",
    "Datum výdeje",
    "Výměna do",
    "Datum vrácení",
    "Stav",
  ];

  function escapeCsv(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  const lines: string[] = [headers.map(escapeCsv).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.personNameSnapshot,
        r.ppeNameSnapshot,
        CATEGORY_LABELS[r.category] ?? r.category,
        String(r.quantity),
        r.size ?? "",
        r.serialNumber ?? "",
        r.issuedAt,
        r.replaceBy ?? "",
        r.returnedAt ?? "",
        STATUS_LABELS[r.status] ?? r.status,
      ]
        .map(escapeCsv)
        .join(","),
    );
  }

  return BOM + lines.join("\r\n");
}
