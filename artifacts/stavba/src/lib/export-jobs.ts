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

function calcTotals(jobs: Job[]) {
  return {
    count: jobs.length,
    hoursVasek: jobs.reduce((s, j) => s + (j.hoursVasek ?? 0), 0),
    hoursJonas: jobs.reduce((s, j) => s + (j.hoursJonas ?? 0), 0),
    price: jobs.reduce((s, j) => s + (j.price ?? 0), 0),
    transportKm: jobs.reduce((s, j) => s + (j.transportKm ?? 0), 0),
    transportCost: jobs.reduce((s, j) => s + (j.transportCost ?? 0), 0),
    parking: jobs.reduce((s, j) => s + (j.parking ?? 0), 0),
    fines: jobs.reduce((s, j) => s + (j.fines ?? 0), 0),
  };
}

function fmt(n: number): number | string {
  return n === 0 ? "" : n;
}

export function exportJobsToXlsx(jobs: Job[], filename?: string) {
  const standardJobs = jobs.filter((j) => j.type !== "change");
  const vicepraceJobs = jobs.filter((j) => j.type === "change");

  const totAll = calcTotals(jobs);
  const totStd = calcTotals(standardJobs);
  const totVic = calcTotals(vicepraceJobs);

  const summaryHeaderRow = [
    "Ukazatel",
    "Celkem",
    "Standardní zakázky",
    "Vícepráce",
  ];

  const summaryRows = [
    [
      "Počet zakázek",
      totAll.count,
      totStd.count,
      totVic.count,
    ],
    [
      "Hodiny – Vašek",
      fmt(totAll.hoursVasek),
      fmt(totStd.hoursVasek),
      fmt(totVic.hoursVasek),
    ],
    [
      "Hodiny – Jonáš",
      fmt(totAll.hoursJonas),
      fmt(totStd.hoursJonas),
      fmt(totVic.hoursJonas),
    ],
    [
      "Celkem hodin",
      fmt(totAll.hoursVasek + totAll.hoursJonas),
      fmt(totStd.hoursVasek + totStd.hoursJonas),
      fmt(totVic.hoursVasek + totVic.hoursJonas),
    ],
    [
      "Cena (Kč)",
      fmt(totAll.price),
      fmt(totStd.price),
      fmt(totVic.price),
    ],
    [
      "Doprava (km)",
      fmt(totAll.transportKm),
      fmt(totStd.transportKm),
      fmt(totVic.transportKm),
    ],
    [
      "Doprava (Kč)",
      fmt(totAll.transportCost),
      fmt(totStd.transportCost),
      fmt(totVic.transportCost),
    ],
    [
      "Parkování (Kč)",
      fmt(totAll.parking),
      fmt(totStd.parking),
      fmt(totVic.parking),
    ],
    [
      "Pokuty (Kč)",
      fmt(totAll.fines),
      fmt(totStd.fines),
      fmt(totVic.fines),
    ],
  ];

  const dataHeader = [
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

  const dataRows = jobs.map((job) => {
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

  const totalsRow = [
    `Celkem zakázek: ${jobs.length}`,
    "",
    "",
    "",
    "",
    fmt(totAll.hoursVasek),
    fmt(totAll.hoursJonas),
    fmt(totAll.price),
    fmt(totAll.transportKm),
    fmt(totAll.parking),
    fmt(totAll.fines),
    "",
  ];

  const SUMMARY_TITLE_ROW = 0;
  const SUMMARY_HEADER_ROW = 2;
  const SUMMARY_DATA_START = 3;
  const SUMMARY_DATA_END = SUMMARY_DATA_START + summaryRows.length - 1;
  const GAP_ROW = SUMMARY_DATA_END + 1;
  const DATA_HEADER_ROW = GAP_ROW + 1;

  const aoa: unknown[][] = [
    ["PŘEHLED ZAKÁZEK"],
    [],
    summaryHeaderRow,
    ...summaryRows,
    [],
    dataHeader,
    ...dataRows,
    [],
    totalsRow,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws["!cols"] = COL_WIDTHS.map((w) => ({ wch: w }));

  const DARK = "1E3A5F";
  const ACCENT = "2563EB";
  const LIGHT_BLUE = "DBEAFE";
  const LIGHT_GREY = "F3F4F6";

  const titleCell = ws["A1"];
  if (titleCell) {
    titleCell.s = {
      font: { bold: true, sz: 14, color: { rgb: DARK } },
    };
  }

  for (let c = 0; c < 4; c++) {
    const addr = XLSX.utils.encode_cell({ r: SUMMARY_HEADER_ROW, c });
    if (ws[addr]) {
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: DARK }, patternType: "solid" },
        alignment: { horizontal: c === 0 ? "left" : "center" },
      };
    }
  }

  for (let r = SUMMARY_DATA_START; r <= SUMMARY_DATA_END; r++) {
    const isEven = (r - SUMMARY_DATA_START) % 2 === 0;
    for (let c = 0; c < 4; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) {
        ws[addr].s = {
          fill: {
            fgColor: { rgb: isEven ? LIGHT_BLUE : "FFFFFF" },
            patternType: "solid",
          },
          font: c === 0 ? { bold: false } : { bold: true },
          alignment: { horizontal: c === 0 ? "left" : "center" },
        };
      }
    }
  }

  for (let c = 0; c < dataHeader.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: DATA_HEADER_ROW, c });
    if (ws[addr]) {
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: ACCENT }, patternType: "solid" },
        alignment: { horizontal: "center" },
      };
    }
  }

  const totalRowIndex = DATA_HEADER_ROW + dataRows.length + 1;
  for (let c = 0; c < dataHeader.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: totalRowIndex, c });
    if (ws[addr]) {
      ws[addr].s = {
        font: { bold: true },
        fill: { fgColor: { rgb: LIGHT_GREY }, patternType: "solid" },
      };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Zakázky");

  const summaryAoa: unknown[][] = [
    ["PŘEHLED ZAKÁZEK – SOUHRN"],
    [],
    summaryHeaderRow,
    ...summaryRows,
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  summaryWs["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 22 }, { wch: 14 }];

  const sumTitleCell = summaryWs["A1"];
  if (sumTitleCell) {
    sumTitleCell.s = {
      font: { bold: true, sz: 13, color: { rgb: DARK } },
    };
  }
  for (let c = 0; c < 4; c++) {
    const addr = XLSX.utils.encode_cell({ r: 2, c });
    if (summaryWs[addr]) {
      summaryWs[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: DARK }, patternType: "solid" },
        alignment: { horizontal: c === 0 ? "left" : "center" },
      };
    }
  }
  for (let r = 3; r < 3 + summaryRows.length; r++) {
    const isEven = (r - 3) % 2 === 0;
    for (let c = 0; c < 4; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (summaryWs[addr]) {
        summaryWs[addr].s = {
          fill: {
            fgColor: { rgb: isEven ? LIGHT_BLUE : "FFFFFF" },
            patternType: "solid",
          },
          font: c === 0 ? { bold: false } : { bold: true },
          alignment: { horizontal: c === 0 ? "left" : "center" },
        };
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, summaryWs, "Přehled");

  const today = new Date().toISOString().split("T")[0];
  const outFile = filename ?? `zakázky-${today}.xlsx`;
  XLSX.writeFile(wb, outFile);
}

export function exportJobsToPdf(
  jobs: Job[],
  options?: { from?: string; to?: string; filename?: string }
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  const standardJobs = jobs.filter((j) => j.type !== "change");
  const vicepraceJobs = jobs.filter((j) => j.type === "change");
  const totAll = calcTotals(jobs);
  const totStd = calcTotals(standardJobs);
  const totVic = calcTotals(vicepraceJobs);

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
  doc.text(
    `Datum exportu: ${today}   |   Rozsah: ${rangeLabel}   |   Zakázek celkem: ${jobs.length}`,
    14,
    21
  );
  doc.setTextColor(0);

  const summaryTableData = [
    [
      "Počet zakázek",
      String(totAll.count),
      String(totStd.count),
      String(totVic.count),
    ],
    [
      "Hodiny – Vašek",
      totAll.hoursVasek > 0 ? String(totAll.hoursVasek) : "–",
      totStd.hoursVasek > 0 ? String(totStd.hoursVasek) : "–",
      totVic.hoursVasek > 0 ? String(totVic.hoursVasek) : "–",
    ],
    [
      "Hodiny – Jonáš",
      totAll.hoursJonas > 0 ? String(totAll.hoursJonas) : "–",
      totStd.hoursJonas > 0 ? String(totStd.hoursJonas) : "–",
      totVic.hoursJonas > 0 ? String(totVic.hoursJonas) : "–",
    ],
    [
      "Cena (Kč)",
      totAll.price > 0 ? String(totAll.price) : "–",
      totStd.price > 0 ? String(totStd.price) : "–",
      totVic.price > 0 ? String(totVic.price) : "–",
    ],
    [
      "Doprava (km)",
      totAll.transportKm > 0 ? String(totAll.transportKm) : "–",
      totStd.transportKm > 0 ? String(totStd.transportKm) : "–",
      totVic.transportKm > 0 ? String(totVic.transportKm) : "–",
    ],
    [
      "Doprava (Kč)",
      totAll.transportCost > 0 ? String(totAll.transportCost) : "–",
      totStd.transportCost > 0 ? String(totStd.transportCost) : "–",
      totVic.transportCost > 0 ? String(totVic.transportCost) : "–",
    ],
  ];

  autoTable(doc, {
    startY: 26,
    head: [["Ukazatel", "Celkem", "Standardní zakázky", "Vícepráce"]],
    body: summaryTableData,
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 22, halign: "right", fontStyle: "bold" },
      2: { cellWidth: 30, halign: "right" },
      3: { cellWidth: 22, halign: "right" },
    },
    tableWidth: 110,
    margin: { left: 14 },
  });

  const summaryEndY = (doc as unknown as { lastAutoTable: { finalY: number } })
    .lastAutoTable.finalY + 6;

  const dataHeader = [
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

  const dataRows = jobs.map((job) => {
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
    totAll.hoursVasek > 0 ? String(totAll.hoursVasek) : "",
    totAll.hoursJonas > 0 ? String(totAll.hoursJonas) : "",
    totAll.price > 0 ? String(totAll.price) : "",
    totAll.transportKm > 0 ? String(totAll.transportKm) : "",
    totAll.parking > 0 ? String(totAll.parking) : "",
    totAll.fines > 0 ? String(totAll.fines) : "",
    "",
  ];

  autoTable(doc, {
    startY: summaryEndY,
    head: [dataHeader],
    body: [...dataRows, totalsRow],
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
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
    didParseCell: (data: any) => {
      if (data.row.index === dataRows.length) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.fillColor = [240, 240, 240];
      }
    },
    willDrawCell: (data: any) => {
      if (data.row.section === "body" && data.row.index < dataRows.length) {
        const job = jobs[data.row.index];
        if (job?.type === "change") {
          data.cell.styles.fillColor = [254, 243, 199];
        }
      }
    },
  });

  const outFile =
    options?.filename ??
    `zakázky-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(outFile);
}
