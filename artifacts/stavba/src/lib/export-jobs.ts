import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { JOB_TYPES, JOB_STATUSES } from "@/components/badges";
import { registerPdfFonts, PDF_FONT } from "@/lib/pdf-fonts";

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

export async function exportJobsToPdf(
  jobs: Job[],
  options?: {
    from?: string;
    to?: string;
    filename?: string;
    columnKeys?: ExportColumnKey[];
    groupByCustomer?: boolean;
    companyName?: string;
    companyLogoDataUrl?: string;
  }
) {
  const cols = selectColumns(options?.columnKeys);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  // Embed Roboto for Czech diacritics; degrade to built-in helvetica if the
  // font assets cannot be loaded so the export still completes.
  let font = PDF_FONT;
  try {
    await registerPdfFonts(doc);
  } catch {
    font = "helvetica";
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const HEADER_H = 26;

  const NAVY: [number, number, number] = [30, 58, 95];
  const ACCENT: [number, number, number] = [37, 99, 235];
  const ZEBRA: [number, number, number] = [241, 245, 249];
  const SUBTOTAL_BG: [number, number, number] = [219, 234, 254];
  const VICEPRACE_BG: [number, number, number] = [254, 243, 199];

  const companyName = options?.companyName?.trim() ?? "";
  const companyLogo = options?.companyLogoDataUrl ?? "";
  const groupByCustomer = options?.groupByCustomer ?? true;

  const today = new Date().toLocaleDateString("cs-CZ");
  const rangeLabel =
    options?.from || options?.to
      ? `${options?.from ?? "začátek"} – ${options?.to ?? "konec"}`
      : "všechna období";

  const num = (n: number): string => n.toLocaleString("cs-CZ");

  // Running header + footer drawn on every page.
  const drawPageChrome = () => {
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageWidth, HEADER_H, "F");
    doc.setFillColor(...ACCENT);
    doc.rect(0, HEADER_H, pageWidth, 1.2, "F");

    doc.setTextColor(255);
    doc.setFont(font, "bold");
    doc.setFontSize(15);
    doc.text(companyName || "Přehled zakázek", MARGIN, 12);
    doc.setFont(font, "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(203, 213, 225);
    doc.text("Přehled zakázek", MARGIN, 19);

    if (companyLogo) {
      try {
        const fmt = companyLogo.startsWith("data:image/jpeg") ? "JPEG" : "PNG";
        const props = doc.getImageProperties(companyLogo);
        const ratio = props.width / props.height;
        const maxH = 13;
        const maxW = 40;
        let h = maxH;
        let w = h * ratio;
        if (w > maxW) {
          w = maxW;
          h = w / ratio;
        }
        doc.addImage(
          companyLogo,
          fmt,
          pageWidth - MARGIN - w,
          (HEADER_H - h) / 2,
          w,
          h
        );
      } catch {
        // ignore unreadable logo
      }
    }

    const pageNum = doc.getCurrentPageInfo().pageNumber;
    doc.setFont(font, "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(150);
    doc.text(`Vygenerováno ${today}`, MARGIN, pageHeight - 6);
    doc.text(
      `Strana ${pageNum} / {totalPages}`,
      pageWidth - MARGIN,
      pageHeight - 6,
      { align: "right" }
    );
    doc.setTextColor(0);
  };

  // Meta strip + summary table (first page only).
  doc.setFontSize(9);
  doc.setFont(font, "normal");
  doc.setTextColor(90);
  doc.text(
    `Rozsah: ${rangeLabel}    •    Zakázek celkem: ${jobs.length}`,
    MARGIN,
    HEADER_H + 9
  );
  doc.setTextColor(0);

  const standardJobs = jobs.filter((j) => j.type !== "change");
  const vicepraceJobs = jobs.filter((j) => j.type === "change");
  const totAll = calcTotals(jobs);
  const totStd = calcTotals(standardJobs);
  const totVic = calcTotals(vicepraceJobs);

  const dash = (n: number) => (n > 0 ? num(n) : "–");
  const summaryTableData = [
    ["Počet zakázek", String(totAll.count), String(totStd.count), String(totVic.count)],
    ["Hodiny – Vašek", dash(totAll.hoursVasek), dash(totStd.hoursVasek), dash(totVic.hoursVasek)],
    ["Hodiny – Jonáš", dash(totAll.hoursJonas), dash(totStd.hoursJonas), dash(totVic.hoursJonas)],
    ["Cena (Kč)", dash(totAll.price), dash(totStd.price), dash(totVic.price)],
    ["Doprava (km)", dash(totAll.transportKm), dash(totStd.transportKm), dash(totVic.transportKm)],
    ["Doprava (Kč)", dash(totAll.transportCost), dash(totStd.transportCost), dash(totVic.transportCost)],
  ];

  autoTable(doc, {
    startY: HEADER_H + 13,
    head: [["Ukazatel", "Celkem", "Standardní", "Vícepráce"]],
    body: summaryTableData,
    styles: { font, fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: {
      0: { cellWidth: 38 },
      1: { cellWidth: 26, halign: "right", fontStyle: "bold" },
      2: { cellWidth: 28, halign: "right" },
      3: { cellWidth: 28, halign: "right" },
    },
    tableWidth: 120,
    margin: { left: MARGIN, top: HEADER_H + 4, bottom: 12 },
    didDrawPage: drawPageChrome,
  });

  let cursorY =
    (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 8;

  // Build the data columns. When grouping, drop the redundant customer column.
  const dataCols = groupByCustomer
    ? cols.filter((c) => c.key !== "customer")
    : cols;
  const dataHeader = dataCols.map((c) => c.label);
  const columnStyles: Record<number, Record<string, unknown>> = {};
  dataCols.forEach((c, i) => {
    const style: Record<string, unknown> = { cellWidth: c.pdfWidth };
    if (c.pdfAlign) style.halign = c.pdfAlign;
    columnStyles[i] = style;
  });

  const buildRows = (groupJobs: Job[]) =>
    groupJobs.map((job) =>
      dataCols.map((c) => {
        const v = c.value(job);
        return v === "" || v == null ? "" : String(v);
      })
    );

  const buildFoot = (groupJobs: Job[], label: string) => {
    const t = calcTotals(groupJobs);
    return dataCols.map((c, i) => {
      if (i === 0) return label;
      if (c.totalKey) {
        const v = t[c.totalKey];
        return typeof v === "number" && v > 0 ? num(v) : "";
      }
      return "";
    });
  };

  const renderJobsTable = (
    groupJobs: Job[],
    footLabel: string,
    startY: number,
    title?: string
  ) => {
    const rows = buildRows(groupJobs);
    // When a title is supplied (customer grouping), put it in a full-width head
    // row so autoTable repeats it after every page break — it can never be
    // orphaned at the bottom of a page the way a manually drawn band could.
    const head = title
      ? [
          [
            {
              content: title,
              colSpan: dataCols.length,
              styles: {
                fillColor: NAVY,
                textColor: 255,
                halign: "left" as const,
                fontStyle: "bold" as const,
                fontSize: 9,
              },
            },
          ],
          dataHeader,
        ]
      : [dataHeader];
    const titleRows = title ? 1 : 0;
    autoTable(doc, {
      startY,
      head: head as any,
      body: rows,
      foot: [buildFoot(groupJobs, footLabel)],
      styles: { font, fontSize: 7.5, cellPadding: 1.6, overflow: "linebreak" },
      headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: SUBTOTAL_BG, textColor: NAVY, fontStyle: "bold" },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles,
      margin: { left: MARGIN, right: MARGIN, top: HEADER_H + 4, bottom: 12 },
      didDrawPage: drawPageChrome,
      didParseCell: (data: any) => {
        // Keep the column-label head row using the accent colour even though
        // the title head row overrides its own fill.
        if (
          data.section === "head" &&
          titleRows > 0 &&
          data.row.index === 0
        ) {
          data.cell.styles.fillColor = NAVY;
        }
      },
      willDrawCell: (data: any) => {
        if (data.row.section === "body") {
          const job = groupJobs[data.row.index];
          if (job?.type === "change") {
            data.cell.styles.fillColor = VICEPRACE_BG;
          }
        }
      },
    });
    return (
      (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY
    );
  };

  if (groupByCustomer) {
    const groups = new Map<string, Job[]>();
    for (const job of jobs) {
      const key =
        job.customerCompanyName?.trim() ||
        job.clientSite?.trim() ||
        "Bez zákazníka";
      const arr = groups.get(key);
      if (arr) arr.push(job);
      else groups.set(key, [job]);
    }
    const sortedKeys = [...groups.keys()].sort((a, b) =>
      a.localeCompare(b, "cs")
    );

    for (const key of sortedKeys) {
      const groupJobs = groups.get(key)!;
      const t = calcTotals(groupJobs);
      const title = `${key}   •   ${groupJobs.length} zak.${
        t.price > 0 ? `   •   ${num(t.price)} Kč` : ""
      }`;
      cursorY = renderJobsTable(groupJobs, "Mezisoučet", cursorY, title) + 8;
    }
  } else {
    renderJobsTable(jobs, `Celkem: ${jobs.length} zakázek`, cursorY);
  }

  const docWithTotal = doc as unknown as {
    putTotalPages?: (s: string) => void;
  };
  if (typeof docWithTotal.putTotalPages === "function") {
    docWithTotal.putTotalPages("{totalPages}");
  }

  const outFile =
    options?.filename ??
    `zakázky-${new Date().toISOString().split("T")[0]}.pdf`;
  doc.save(outFile);
}
