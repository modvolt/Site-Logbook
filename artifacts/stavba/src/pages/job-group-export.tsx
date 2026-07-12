import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/lib/brand";
import { loadCompanySettings } from "@/lib/company-settings";
import { jobSheetPdfBase64 } from "@/lib/job-sheet-pdf";
import {
  fetchJson,
  formatDate,
  formatKc,
  materialLineTotal,
  type JobGroupDetail,
  type GroupMaterial,
} from "@/lib/job-groups-api";

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  #zakazkovy-list, #zakazkovy-list * { visibility: visible !important; }
  #zakazkovy-list { position: absolute; left: 0; top: 0; width: 100%; margin: 0; box-shadow: none !important; }
  .no-print { display: none !important; }
}
`;

function materialText(material: GroupMaterial): string {
  const quantity = material.quantity != null ? material.quantity.toLocaleString("cs-CZ") : "-";
  const unit = material.unit ? ` ${material.unit}` : "";
  return `${material.name} · ${quantity}${unit}`;
}

export default function JobGroupExport() {
  const params = useParams();
  const id = Number(params.id || 0);
  const [showPrice, setShowPrice] = useState(true);
  const [showTime, setShowTime] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [company] = useState(() => loadCompanySettings());

  const { data: group, isLoading } = useQuery({
    queryKey: ["job-groups", id],
    queryFn: () => fetchJson<JobGroupDetail>(`/api/job-groups/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });

  const contractorName = company.name || BRAND_NAME;
  const contractorLogo = company.logoDataUrl || BRAND_LOGO_URL;

  async function handleDownload() {
    const element = document.getElementById("zakazkovy-list");
    if (!element || !group) return;
    setDownloading(true);
    try {
      const pdfBase64 = await jobSheetPdfBase64(element);
      const binary = atob(pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `spolecny-zakazkovy-list-${group.id}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!group) {
    return <div className="p-8 text-center">Akce nenalezena.</div>;
  }

  const totalHours = group.jobs.reduce((sum, job) => sum + (job.hoursSpent ?? 0), 0);
  const materialTotal = group.jobs.reduce(
    (sum, job) => sum + job.materials.reduce((inner, material) => inner + materialLineTotal(material), 0),
    0,
  );

  return (
    <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 pb-16">
      <style>{PRINT_CSS}</style>
      <div className="no-print sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-3 max-w-4xl mx-auto w-full flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/job-groups/${group.id}`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <h1 className="text-lg font-bold flex-1 min-w-0 truncate">Společný zakázkový list</h1>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPrice}
              onChange={(event) => setShowPrice(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Zobrazit ceny
          </label>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTime}
              onChange={(event) => setShowTime(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Zobrazit čas
          </label>
          <Button variant="outline" onClick={handleDownload} disabled={downloading}>
            {downloading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
            PDF
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-2" />
            Tisk
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto w-full p-4 md:p-8">
        <div
          id="zakazkovy-list"
          className="bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10"
          style={{ maxWidth: "210mm" }}
        >
          <div className="flex items-start justify-between border-b-2 border-neutral-900 pb-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Společný zakázkový list</h2>
              <p className="text-sm text-neutral-600 mt-1">Akce č. {group.id}</p>
            </div>
            <div className="flex flex-col items-end text-right">
              <img
                src={contractorLogo}
                alt={contractorName}
                crossOrigin="anonymous"
                className="h-16 w-auto object-contain"
              />
              <p className="text-xs text-neutral-500 mt-1">
                Vystaveno: {new Date().toLocaleDateString("cs-CZ")}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Akce</div>
              <div className="font-semibold text-lg">{group.name}</div>
              <div>{group.address || "-"}</div>
              <div>{formatDate(group.dateFrom)} - {formatDate(group.dateTo)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Zákazník</div>
              <div className="font-semibold">{group.customerCompanyName || "-"}</div>
            </div>
          </div>

          {group.notes && (
            <div className="mb-6 rounded-md border border-neutral-300 p-3 text-sm">
              <div className="font-semibold mb-1">Poznámka</div>
              <div className="whitespace-pre-wrap">{group.notes}</div>
            </div>
          )}

          <div className={`grid gap-3 mb-6 text-sm ${showTime ? "grid-cols-3" : "grid-cols-2"}`}>
            <div className="border border-neutral-300 rounded-md p-3">
              <div className="text-neutral-500">Zakázek</div>
              <div className="text-xl font-semibold">{group.jobs.length}</div>
            </div>
            {showTime && (
              <div className="border border-neutral-300 rounded-md p-3">
                <div className="text-neutral-500">Hodin</div>
                <div className="text-xl font-semibold">{totalHours.toLocaleString("cs-CZ")}</div>
              </div>
            )}
            <div className="border border-neutral-300 rounded-md p-3">
              <div className="text-neutral-500">Materiál</div>
              <div className="text-xl font-semibold">{showPrice ? formatKc(materialTotal) : "-"}</div>
            </div>
          </div>

          <div className="space-y-6">
            {group.jobs.map((job) => {
              const jobMaterialTotal = job.materials.reduce((sum, material) => sum + materialLineTotal(material), 0);
              return (
                <section key={job.id} className="break-inside-avoid border-t border-neutral-300 pt-4">
                  <div className="flex justify-between gap-4 mb-3">
                    <div>
                      <h3 className="font-bold text-lg">#{job.jobNumber ?? job.id} {job.title}</h3>
                      <div className="text-sm text-neutral-600">{formatDate(job.date)} · {job.address || job.clientSite || "-"}</div>
                    </div>
                    <div className="text-right text-sm">
                      {showTime && <div>{(job.hoursSpent ?? 0).toLocaleString("cs-CZ")} h</div>}
                      <div>{showPrice ? formatKc(jobMaterialTotal) : ""}</div>
                    </div>
                  </div>

                  {job.tasks.length > 0 && (
                    <div className="mb-3">
                      <div className="font-semibold text-sm mb-1">Práce</div>
                      <ul className="list-disc pl-5 text-sm space-y-1">
                        {job.tasks.map((task) => (
                          <li key={task.id}>{task.title}{task.description ? ` - ${task.description}` : ""}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {job.materials.length > 0 && (
                    <div>
                      <div className="font-semibold text-sm mb-1">Materiál</div>
                      <table className="w-full text-sm border-collapse">
                        <tbody>
                          {job.materials.map((material) => (
                            <tr key={material.id} className="border-b border-neutral-200">
                              <td className="py-1 pr-2">{materialText(material)}</td>
                              {showPrice && (
                                <td className="py-1 pl-2 text-right whitespace-nowrap">{formatKc(materialLineTotal(material))}</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-10 mt-12 pt-8 text-sm">
            <div>
              <div className="border-t border-neutral-900 pt-2">Za dodavatele</div>
            </div>
            <div>
              <div className="border-t border-neutral-900 pt-2">Za zákazníka</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
