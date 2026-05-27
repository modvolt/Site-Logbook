import * as XLSX from "xlsx";
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
