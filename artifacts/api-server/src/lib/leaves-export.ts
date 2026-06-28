import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";

const PDF_FONT = "Roboto";

export interface LeaveSummaryRow {
  personId: number;
  personName: string;
  year: number;
  vacationDays: number;
  sickDays: number;
  otherDays: number;
  totalDays: number;
}

function registerFonts(doc: jsPDF): void {
  doc.addFileToVFS("Roboto-Regular.ttf", robotoRegular);
  doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", robotoBold);
  doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
}

export function generateLeavesSummaryPdf(rows: LeaveSummaryRow[], year: number): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(16);
  doc.text(`Přehled dovolených – ${year}`, marginX, 20);

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(
    `Vygenerováno: ${new Date().toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "numeric" })}`,
    pageWidth - marginX,
    20,
    { align: "right" },
  );
  doc.setTextColor(0);

  const tableRows = rows.map((r) => [
    r.personName,
    String(r.vacationDays),
    String(r.sickDays),
    String(r.otherDays),
    String(r.totalDays),
  ]);

  const totals = rows.reduce(
    (acc, r) => {
      acc.vacation += r.vacationDays;
      acc.sick += r.sickDays;
      acc.other += r.otherDays;
      acc.total += r.totalDays;
      return acc;
    },
    { vacation: 0, sick: 0, other: 0, total: 0 },
  );

  autoTable(doc, {
    startY: 30,
    head: [["Pracovník", "Dovolená (dny)", "Nemoc (dny)", "Jiné (dny)", "Celkem (dny)"]],
    body: tableRows,
    foot: [["Celkem", String(totals.vacation), String(totals.sick), String(totals.other), String(totals.total)]],
    styles: { font: PDF_FONT, fontStyle: "normal", fontSize: 9, cellPadding: 2.5 },
    headStyles: { font: PDF_FONT, fontStyle: "bold", fillColor: [37, 99, 235], textColor: 255 },
    footStyles: { font: PDF_FONT, fontStyle: "bold", fillColor: [240, 240, 240], textColor: 0 },
    columnStyles: {
      0: { cellWidth: "auto" },
      1: { halign: "center" },
      2: { halign: "center" },
      3: { halign: "center" },
      4: { halign: "center", fontStyle: "bold" },
    },
    margin: { left: marginX, right: marginX },
    showFoot: "lastPage",
  });

  return Buffer.from(doc.output("arraybuffer"));
}

export function generateLeavesSummaryCsv(rows: LeaveSummaryRow[], year: number): string {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines: string[] = [
    `# Přehled dovolených – ${year}`,
    ["Pracovník", "Rok", "Dovolená (dny)", "Nemoc (dny)", "Jiné (dny)", "Celkem (dny)"].map(escape).join(","),
    ...rows.map((r) =>
      [r.personName, r.year, r.vacationDays, r.sickDays, r.otherDays, r.totalDays].map(escape).join(","),
    ),
  ];

  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
