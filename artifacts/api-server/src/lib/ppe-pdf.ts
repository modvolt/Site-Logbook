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
  employeeConfirmedAt?: string | null;
  signatureBuffer?: Buffer | null;
}

export function generatePpePdf(rows: PpeExportRow[], companyName?: string | null): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  registerFonts(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
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
    head: [["Zaměstnanec", "Pomůcka", "Kategorie", "Počet", "Vel.", "Sér. číslo", "Vydáno", "Výměna do", "Vráceno", "Stav", "Potvrzeno"]],
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
      r.employeeConfirmedAt ? `✓ ${fmtDate(r.employeeConfirmedAt)}` : "—",
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
      0: { cellWidth: 28 },
      1: { cellWidth: 34 },
      2: { cellWidth: 22 },
      3: { cellWidth: 11, halign: "center" },
      4: { cellWidth: 12, halign: "center" },
      5: { cellWidth: 24 },
      6: { cellWidth: 20 },
      7: { cellWidth: 20 },
      8: { cellWidth: 20 },
      9: { cellWidth: 18 },
      10: { cellWidth: 28 },
    },
    margin: { left: marginX, right: marginX },
    didDrawPage: (data) => {
      const pgNum = (doc as any).internal.getCurrentPageInfo().pageNumber;
      doc.setFont(PDF_FONT, "normal");
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Strana ${pgNum}`, pageWidth - marginX, pageHeight - 8, { align: "right" });
      doc.setTextColor(0);
    },
  });

  // Append signatures page if any row has a signature
  const signedRows = rows.filter((r) => r.signatureBuffer && r.employeeConfirmedAt);
  if (signedRows.length > 0) {
    doc.addPage();
    doc.setFont(PDF_FONT, "bold");
    doc.setFontSize(12);
    doc.text("Podpisy zaměstnanců", marginX, 16);

    let sigY = 26;
    const sigW = 70;
    const sigH = 25;
    const colGap = 10;
    const cols = 3;
    let col = 0;

    for (const r of signedRows) {
      if (!r.signatureBuffer) continue;
      const x = marginX + col * (sigW + colGap);

      doc.setFont(PDF_FONT, "bold");
      doc.setFontSize(8);
      doc.text(r.personNameSnapshot, x, sigY);
      doc.setFont(PDF_FONT, "normal");
      doc.setFontSize(7);
      doc.text(`${r.ppeNameSnapshot} — vydáno ${fmtDate(r.issuedAt)}`, x, sigY + 4);
      doc.text(`Podepsáno: ${fmtDate(r.employeeConfirmedAt)}`, x, sigY + 8);

      try {
        const base64 = r.signatureBuffer.toString("base64");
        doc.addImage(`data:image/png;base64,${base64}`, "PNG", x, sigY + 10, sigW, sigH);
      } catch {
        doc.setFontSize(7);
        doc.text("[Podpis nelze zobrazit]", x, sigY + 14);
      }

      doc.setDrawColor(200);
      doc.rect(x, sigY - 2, sigW, sigH + 14);
      doc.setDrawColor(0);

      col++;
      if (col >= cols) {
        col = 0;
        sigY += sigH + 20;
        if (sigY > pageHeight - 40) {
          doc.addPage();
          doc.setFont(PDF_FONT, "bold");
          doc.setFontSize(12);
          doc.text("Podpisy zaměstnanců (pokračování)", marginX, 16);
          sigY = 26;
        }
      }
    }

    // Page number for signatures page(s)
    const totalPages = (doc as any).internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFont(PDF_FONT, "normal");
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Strana ${p}`, pageWidth - marginX, pageHeight - 8, { align: "right" });
      doc.setTextColor(0);
    }
  }

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
    "Potvrzeno zaměstnancem",
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
        r.employeeConfirmedAt ? fmtDate(r.employeeConfirmedAt) : "",
      ]
        .map(escapeCsv)
        .join(","),
    );
  }

  return BOM + lines.join("\r\n");
}
