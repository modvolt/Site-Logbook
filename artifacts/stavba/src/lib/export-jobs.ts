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

export type ExportColumnKey =
  | "title"
  | "date"
  | "type"
  | "status"
  | "customer"
  | "hoursVasek"
  | "hoursJonas"
  | "price"
  | "transportKm"
  | "parking"
  | "fines"
  | "notes";

type ColumnDef = {
  key: ExportColumnKey;
  label: string;
  xlsxWidth: number;
  pdfWidth: number | "auto";
  pdfAlign?: "left" | "right" | "center";
  numeric?: boolean;
  totalKey?: keyof ReturnType<typeof calcTotals>;
  value: (job: Job) => string | number;
};

export const EXPORT_COLUMNS: ColumnDef[] = [
  {
    key: "title",
    label: "Název zakázky",
    xlsxWidth: 30,
    pdfWidth: 40,
    value: (j) => (j.type === "change" ? `${j.title} [Vícepráce]` : j.title),
  },
  {
    key: "date",
    label: "Datum",
    xlsxWidth: 12,
    pdfWidth: 18,
    value: (j) => j.date,
  },
  {
    key: "type",
    label: "Typ",
    xlsxWidth: 20,
    pdfWidth: 22,
    value: (j) =>
      JOB_TYPES[j.type as keyof typeof JOB_TYPES]?.label ?? j.type,
  },
  {
    key: "status",
    label: "Stav",
    xlsxWidth: 15,
    pdfWidth: 18,
    value: (j) =>
      JOB_STATUSES[j.status as keyof typeof JOB_STATUSES]?.label ?? j.status,
  },
  {
    key: "customer",
    label: "Zákazník / stavba",
    xlsxWidth: 25,
    pdfWidth: 30,
    value: (j) => j.customerCompanyName || j.clientSite || "",
  },
  {
    key: "hoursVasek",
    label: "Hod. Vašek",
    xlsxWidth: 10,
    pdfWidth: 14,
    pdfAlign: "right",
    numeric: true,
    totalKey: "hoursVasek",
    value: (j) => j.hoursVasek ?? "",
  },
  {
    key: "hoursJonas",
    label: "Hod. Jonáš",
    xlsxWidth: 10,
    pdfWidth: 14,
    pdfAlign: "right",
    numeric: true,
    totalKey: "hoursJonas",
    value: (j) => j.hoursJonas ?? "",
  },
  {
    key: "price",
    label: "Cena (Kč)",
    xlsxWidth: 12,
    pdfWidth: 16,
    pdfAlign: "right",
    numeric: true,
    totalKey: "price",
    value: (j) => j.price ?? "",
  },
  {
    key: "transportKm",
    label: "Km",
    xlsxWidth: 8,
    pdfWidth: 10,
    pdfAlign: "right",
    numeric: true,
    totalKey: "transportKm",
    value: (j) => j.transportKm ?? "",
  },
  {
    key: "parking",
    label: "Parkování",
    xlsxWidth: 10,
    pdfWidth: 16,
    pdfAlign: "right",
    numeric: true,
    totalKey: "parking",
    value: (j) => j.parking ?? "",
  },
  {
    key: "fines",
    label: "Pokuty",
    xlsxWidth: 10,
    pdfWidth: 13,
    pdfAlign: "right",
    numeric: true,
    totalKey: "fines",
    value: (j) => j.fines ?? "",
  },
  {
    key: "notes",
    label: "Poznámky",
    xlsxWidth: 40,
    pdfWidth: "auto",
    value: (j) => j.notes ?? "",
  },
];

export const DEFAULT_EXPORT_COLUMNS: ExportColumnKey[] = EXPORT_COLUMNS.map(
  (c) => c.key
);

function selectColumns(keys?: ExportColumnKey[]): ColumnDef[] {
  if (!keys || keys.length === 0) return EXPORT_COLUMNS;
  const set = new Set(keys);
  return EXPORT_COLUMNS.filter((c) => set.has(c.key));
}

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

export function exportJobsToXlsx(
  jobs: Job[],
  filename?: string,
  columnKeys?: ExportColumnKey[]
) {
  const cols = selectColumns(columnKeys);

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
    ["Počet zakázek", totAll.count, totStd.count, totVic.count],
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
    ["Cena (Kč)", fmt(totAll.price), fmt(totStd.price), fmt(totVic.price)],
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
    ["Pokuty (Kč)", fmt(totAll.fines), fmt(totStd.fines), fmt(totVic.fines)],
  ];

  const dataHeader = cols.map((c) => c.label);
  const dataRows = jobs.map((job) => cols.map((c) => c.value(job)));
  const totalsRow = cols.map((c, i) => {
    if (i === 0) return `Celkem zakázek: ${jobs.length}`;
    if (c.totalKey) {
      const v = totAll[c.totalKey];
      return typeof v === "number" ? fmt(v) : "";
    }
    return "";
  });

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

  ws["!cols"] = cols.map((c) => ({ wch: c.xlsxWidth }));

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
  options?: {
    from?: string;
    to?: string;
    filename?: string;
    columnKeys?: ExportColumnKey[];
    companyName?: string;
    companyLogoDataUrl?: string;
  }
) {
  const cols = selectColumns(options?.columnKeys);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  const companyName = options?.companyName?.trim() ?? "";
  const companyLogo = options?.companyLogoDataUrl ?? "";

  let headerBottomY = 10;
  const LOGO_MAX_W = 28;
  const LOGO_MAX_H = 16;
  let logoBottomY = 10;
  if (companyLogo) {
    try {
      const fmt = companyLogo.startsWith("data:image/jpeg") ? "JPEG" : "PNG";
      const props = doc.getImageProperties(companyLogo);
      const ratio = props.width / props.height;
      let w = LOGO_MAX_W;
      let h = w / ratio;
      if (h > LOGO_MAX_H) {
        h = LOGO_MAX_H;
        w = h * ratio;
      }
      const x = pageWidth - 14 - w;
      const y = 10;
      doc.addImage(companyLogo, fmt, x, y, w, h);
      logoBottomY = y + h;
    } catch {
      // ignore unreadable logo
    }
  }

  if (companyName) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 58, 95);
    doc.text(companyName, 14, 9);
    doc.setTextColor(0);
    headerBottomY = Math.max(headerBottomY, 11);
  }
  headerBottomY = Math.max(headerBottomY, logoBottomY);

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

  const titleY = Math.max(14, headerBottomY + 4);
  const metaY = titleY + 7;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Přehled zakázek", 14, titleY);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(
    `Datum exportu: ${today}   |   Rozsah: ${rangeLabel}   |   Zakázek celkem: ${jobs.length}`,
    14,
    metaY
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
    startY: metaY + 5,
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

  const summaryEndY =
    (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 6;

  const dataHeader = cols.map((c) => c.label);

  const dataRows = jobs.map((job) =>
    cols.map((c) => {
      const v = c.value(job);
      return v === "" || v == null ? "" : String(v);
    })
  );

  const totalsRow = cols.map((c, i) => {
    if (i === 0) return `Celkem: ${jobs.length}`;
    if (c.totalKey) {
      const v = totAll[c.totalKey];
      return typeof v === "number" && v > 0 ? String(v) : "";
    }
    return "";
  });

  const columnStyles: Record<number, Record<string, unknown>> = {};
  cols.forEach((c, i) => {
    const style: Record<string, unknown> = { cellWidth: c.pdfWidth };
    if (c.pdfAlign) style.halign = c.pdfAlign;
    columnStyles[i] = style;
  });

  autoTable(doc, {
    startY: summaryEndY,
    head: [dataHeader],
    body: [...dataRows, totalsRow],
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    columnStyles,
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
