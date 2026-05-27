import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { JOB_TYPES, JOB_STATUSES } from "@/components/badges";

type Job = {
  id: number;
  title: string;
  date: string;
  type: string;
  status: string;
  clientSite?: string | null;
  customerCompanyName?: string | null;
  hoursVasek?: number | null;
  hoursJonas?: number | null;
  hoursSpent?: number | null;
  price?: number | null;
  transportKm?: number | null;
  transportCost?: number | null;
  parking?: number | null;
  fines?: number | null;
  notes?: string | null;
};

const COL_WIDTHS = [30, 12, 20, 15, 25, 10, 10, 12, 8, 10, 10, 40];

export function exportJobsToXlsx(jobs: Job[], filename?: string) {
  const header = [
    "Název zakázky",
    "Datum",
    "Typ",
    "Stav",
    "Zákazník / stavba",
    "Hod. Vašek",
    "Hod. Jonáš",
    "Cena (Kč)",
    "Km",
    "Parkování",
    "Pokuty",
    "Poznámky",
  ];

  const rows = jobs.map((job) => {
    const typeCfg = JOB_TYPES[job.type as keyof typeof JOB_TYPES];
    const statusCfg = JOB_STATUSES[job.status as keyof typeof JOB_STATUSES];
    const customer = job.customerCompanyName || job.clientSite || "";
    const isVicerace = job.type === "change";

    return [
      isVicerace ? `${job.title} [Vícepráce]` : job.title,
      job.date,
      typeCfg?.label ?? job.type,
      statusCfg?.label ?? job.status,
      customer,
      job.hoursVasek ?? "",
      job.hoursJonas ?? "",
      job.price ?? "",
      job.transportKm ?? "",
      job.parking ?? "",
      job.fines ?? "",
      job.notes ?? "",
    ];
  });

  const summaryRow = [
    `Celkem zakázek: ${jobs.length}`,
    "",
    "",
    "",
    "",
    jobs.reduce((s, j) => s + (j.hoursVasek ?? 0), 0) || "",
    jobs.reduce((s, j) => s + (j.hoursJonas ?? 0), 0) || "",
    jobs.reduce((s, j) => s + (j.price ?? 0), 0) || "",
    jobs.reduce((s, j) => s + (j.transportKm ?? 0), 0) || "",
    jobs.reduce((s, j) => s + (j.parking ?? 0), 0) || "",
    jobs.reduce((s, j) => s + (j.fines ?? 0), 0) || "",
    "",
  ];

  const data = [header, ...rows, [], summaryRow];

  const ws = XLSX.utils.aoa_to_sheet(data);

  ws["!cols"] = COL_WIDTHS.map((w) => ({ wch: w }));

  const headerRange = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cellAddr]) {
      ws[cellAddr].s = {
        font: { bold: true },
        fill: { fgColor: { rgb: "1E3A5F" }, patternType: "solid" },
        alignment: { horizontal: "center" },
      };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Zakázky");

  const today = new Date().toISOString().split("T")[0];
  const outFile = filename ?? `zakázky-${today}.xlsx`;
  XLSX.writeFile(wb, outFile);
}

export function exportJobsToPdf(
  jobs: Job[],
  options?: { from?: string; to?: string; filename?: string }
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  const today = new Date().toLocaleDateString("cs-CZ");
  const rangeLabel =
    options?.from || options?.to
      ? `${options?.from ?? "začátek"} – ${options?.to ?? "konec"}`
      : "všechna období";

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Přehled zakázek", 14, 14);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(`Datum exportu: ${today}   |   Rozsah: ${rangeLabel}   |   Zakázek: ${jobs.length}`, 14, 21);
  doc.setTextColor(0);

  const header = [
    "Název zakázky",
    "Datum",
    "Typ",
    "Stav",
    "Zákazník / stavba",
    "Hod. Vašek",
    "Hod. Jonáš",
    "Cena (Kč)",
    "Km",
    "Parkování",
    "Pokuty",
    "Poznámky",
  ];

  const rows = jobs.map((job) => {
    const typeCfg = JOB_TYPES[job.type as keyof typeof JOB_TYPES];
    const statusCfg = JOB_STATUSES[job.status as keyof typeof JOB_STATUSES];
    const customer = job.customerCompanyName || job.clientSite || "";
    const isVicerace = job.type === "change";

    return [
      isVicerace ? `${job.title} [Vícepráce]` : job.title,
      job.date,
      typeCfg?.label ?? job.type,
      statusCfg?.label ?? job.status,
      customer,
      job.hoursVasek != null ? String(job.hoursVasek) : "",
      job.hoursJonas != null ? String(job.hoursJonas) : "",
      job.price != null ? String(job.price) : "",
      job.transportKm != null ? String(job.transportKm) : "",
      job.parking != null ? String(job.parking) : "",
      job.fines != null ? String(job.fines) : "",
      job.notes ?? "",
    ];
  });

  const totalsRow = [
    `Celkem: ${jobs.length}`,
    "",
    "",
    "",
    "",
    String(jobs.reduce((s, j) => s + (j.hoursVasek ?? 0), 0) || ""),
    String(jobs.reduce((s, j) => s + (j.hoursJonas ?? 0), 0) || ""),
    String(jobs.reduce((s, j) => s + (j.price ?? 0), 0) || ""),
    String(jobs.reduce((s, j) => s + (j.transportKm ?? 0), 0) || ""),
    String(jobs.reduce((s, j) => s + (j.parking ?? 0), 0) || ""),
    String(jobs.reduce((s, j) => s + (j.fines ?? 0), 0) || ""),
    "",
  ];

  autoTable(doc, {
    startY: 26,
    head: [header],
    body: [...rows, totalsRow],
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: 18 },
      2: { cellWidth: 22 },
      3: { cellWidth: 18 },
      4: { cellWidth: 30 },
      5: { cellWidth: 14, halign: "right" },
      6: { cellWidth: 14, halign: "right" },
      7: { cellWidth: 16, halign: "right" },
      8: { cellWidth: 10, halign: "right" },
      9: { cellWidth: 16, halign: "right" },
      10: { cellWidth: 13, halign: "right" },
      11: { cellWidth: "auto" },
    },
    didParseCell: (data) => {
      if (data.row.index === rows.length) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.fillColor = [240, 240, 240];
      }
    },
  });

  const outFile =
    options?.filename ??
    `zakázky-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(outFile);
}
