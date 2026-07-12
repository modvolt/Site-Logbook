import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJob, getGetJobQueryKey,
  useListTasks, getListTasksQueryKey,
  useListMaterials, getListMaterialsQueryKey,
  useSendJobEmail, useSaveJobSheet, getListAttachmentsQueryKey,
} from "@workspace/api-client-react";
import { ArrowLeft, Printer, PenLine, RotateCcw, Mail, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { JOB_STATUSES, JOB_TYPES } from "@/components/badges";
import { SignaturePad } from "@/components/signature-pad";
import { useToast } from "@/hooks/use-toast";
import { jobSheetPdfBase64 } from "@/lib/job-sheet-pdf";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/lib/brand";
import { loadCompanySettings } from "@/lib/company-settings";
import contractorSignature from "@assets/podpis_firma_1780171718219.jpeg";

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

function fmtKc(n: number): string {
  return `${Math.round(n).toLocaleString("cs-CZ")} Kč`;
}

function typeLabel(type: string): string {
  return JOB_TYPES[type as keyof typeof JOB_TYPES]?.label ?? type;
}

function statusLabel(status: string): string {
  return JOB_STATUSES[status as keyof typeof JOB_STATUSES]?.label ?? status;
}

export default function JobExport() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const [showPrice, setShowPrice] = useState(true);
  const [showTime, setShowTime] = useState(true);
  const [customerSig, setCustomerSig] = useState<string | null>(null);
  const [sigTimestamp, setSigTimestamp] = useState<string | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [company] = useState(() => loadCompanySettings());
  const [pendingSave, setPendingSave] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sendEmail = useSendJobEmail();
  const saveJobSheet = useSaveJobSheet();

  const handleSaveToJob = async () => {
    const element = document.getElementById("zakazkovy-list");
    if (!element) return;
    try {
      const pdfBase64 = await jobSheetPdfBase64(element);
      await saveJobSheet.mutateAsync({ id, data: { pdfBase64, signed: !!customerSig } });
      queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(id) });
      toast({
        title: "Uloženo do zakázky",
        description: "Zakázkový list byl uložen mezi přílohy zakázky.",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Uložení selhalo",
        description: "Zakázkový list se nepodařilo uložit. Zkuste to prosím znovu.",
      });
    }
  };

  const handleSignatureSave = (sig: string) => {
    setCustomerSig(sig);
    setSigTimestamp(new Date().toISOString());
    setPendingSave(true);
  };

  // After a signature is captured, wait for the DOM to render it, then archive
  // the signed sheet to the job automatically.
  useEffect(() => {
    if (!pendingSave || !customerSig) return;
    setPendingSave(false);
    const t = setTimeout(() => { void handleSaveToJob(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSave, customerSig]);

  const contractorName = company.name || BRAND_NAME;
  const contractorLogo = company.logoDataUrl || BRAND_LOGO_URL;
  const contractorSig = company.signatureDataUrl || contractorSignature;

  const { data: job, isLoading } = useGetJob(id, {
    query: { enabled: !!id, queryKey: getGetJobQueryKey(id) },
  });
  const { data: tasks } = useListTasks(id, {
    query: { enabled: !!id, queryKey: getListTasksQueryKey(id) },
  });
  const { data: materials } = useListMaterials(id, {
    query: { enabled: !!id, queryKey: getListMaterialsQueryKey(id) },
  });

  // Pre-populate from a previously captured remote signature (digital signing flow).
  useEffect(() => {
    if (job?.signedAt && job.signatureObjectPath && !customerSig) {
      setCustomerSig(`/api/storage${job.signatureObjectPath}`);
      setSigTimestamp(job.signedAt);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.signedAt, job?.signatureObjectPath]);

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-8 text-center">Zakázka nenalezena</div>;
  }

  const taskList = tasks ?? [];
  const workTasks = taskList.filter((t) => !t.isChangeRequest);
  const changeTasks = taskList.filter((t) => t.isChangeRequest);
  const materialList = materials ?? [];

  const materialsTotal = materialList.reduce((sum, m) => {
    const qty = m.quantity != null ? Number(m.quantity) : 0;
    const ppu = m.pricePerUnit != null ? Number(m.pricePerUnit) : 0;
    return sum + qty * ppu;
  }, 0);

  const workPrice = job.price != null ? Number(job.price) : 0;
  const parking = job.parking != null ? Number(job.parking) : 0;
  const fines = job.fines != null ? Number(job.fines) : 0;
  const transportCost = job.transportCost != null ? Number(job.transportCost) : 0;
  const grandTotal = workPrice + materialsTotal + parking + fines + transportCost;

  const hoursVasek = job.hoursVasek != null ? Number(job.hoursVasek) : 0;
  const hoursJonas = job.hoursJonas != null ? Number(job.hoursJonas) : 0;
  const hoursTotal = hoursVasek + hoursJonas || (job.hoursSpent != null ? Number(job.hoursSpent) : 0);

  const place = job.address || job.clientSite || "";

  const handleSendEmail = async () => {
    const recipient = job.customerEmail?.trim();
    if (!recipient) {
      toast({
        variant: "destructive",
        title: "Chybí e-mail zákazníka",
        description: "Přidejte e-mail u zákazníka a zkuste to znovu.",
      });
      return;
    }
    const element = document.getElementById("zakazkovy-list");
    if (!element) return;
    try {
      const pdfBase64 = await jobSheetPdfBase64(element);
      const result = await sendEmail.mutateAsync({ id, data: { pdfBase64 } });
      toast({
        title: "E-mail odeslán",
        description: `Zakázkový list byl odeslán na ${result.to}.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Odeslání selhalo",
        description: "E-mail se nepodařilo odeslat. Zkuste to prosím znovu.",
      });
    }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 pb-16">
      <style>{PRINT_CSS}</style>

      {/* Toolbar */}
      <div className="no-print sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-3 max-w-3xl mx-auto w-full flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="shrink-0">
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-bold flex-1 min-w-0 truncate">Zakázkový list</h1>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPrice}
              onChange={(e) => setShowPrice(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Zobrazit ceny
          </label>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTime}
              onChange={(e) => setShowTime(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Zobrazit čas
          </label>
          <Button
            variant="outline"
            onClick={handleSendEmail}
            disabled={sendEmail.isPending}
            className="shrink-0"
          >
            {sendEmail.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Mail className="h-4 w-4 mr-2" />
            )}
            Odeslat e-mailem
          </Button>
          <Button
            variant="outline"
            onClick={handleSaveToJob}
            disabled={saveJobSheet.isPending}
            className="shrink-0"
          >
            {saveJobSheet.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Uložit do zakázky
          </Button>
          <Button onClick={() => window.print()} className="shrink-0">
            <Printer className="h-4 w-4 mr-2" /> Tisk / Uložit PDF
          </Button>
        </div>
      </div>

      {/* Document */}
      <div className="max-w-3xl mx-auto w-full p-4 md:p-8">
        <div
          id="zakazkovy-list"
          className="bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10"
          style={{ maxWidth: "210mm" }}
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b-2 border-neutral-900 pb-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Zakázkový list</h2>
              <p className="text-sm text-neutral-600 mt-1">č. {job.id}</p>
            </div>
            <div className="flex flex-col items-end text-right">
              <img
                src={contractorLogo}
                alt={contractorName}
                crossOrigin="anonymous"
                className="h-16 w-auto object-contain"
              />
              <p className="text-xs text-neutral-500 mt-1">
                Vystaveno: {format(new Date(), "d. M. yyyy")}
              </p>
            </div>
          </div>

          {/* Parties */}
          <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Zhotovitel</p>
              <p className="font-semibold">{contractorName}</p>
              {company.info && (
                <p className="text-neutral-600 whitespace-pre-line">{company.info}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Objednatel</p>
              <p className="font-semibold">{job.customerCompanyName || "—"}</p>
              {job.customerPhone && <p className="text-neutral-600">{job.customerPhone}</p>}
            </div>
          </div>

          {/* Job meta */}
          <div className="border border-neutral-300 rounded-md p-4 mb-6 text-sm">
            <p className="text-base font-bold mb-3">{job.title}</p>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4">
              <MetaRow label="Druh" value={typeLabel(job.type)} />
              <MetaRow label="Stav" value={statusLabel(job.status)} />
              <MetaRow label="Datum" value={format(new Date(job.date), "d. M. yyyy")} />
              {showTime && (
                <MetaRow
                  label="Čas"
                  value={job.startTime || job.endTime ? `${job.startTime || "?"} – ${job.endTime || "?"}` : "—"}
                />
              )}
              {place && <MetaRow label="Místo" value={place} className="col-span-2" />}
            </div>
          </div>

          {/* Work performed */}
          <Section title="Provedené práce">
            {workTasks.length === 0 ? (
              <p className="text-sm text-neutral-500">Bez položek.</p>
            ) : (
              <ul className="text-sm space-y-1">
                {workTasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <span className="mt-0.5">{t.done ? "☑" : "☐"}</span>
                    <span>
                      {t.title}
                      {t.description && <span className="text-neutral-600"> — {t.description}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Change requests / vícepráce */}
          {changeTasks.length > 0 && (
            <Section title="Vícepráce">
              <ul className="text-sm space-y-1">
                {changeTasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <span className="mt-0.5">{t.done ? "☑" : "☐"}</span>
                    <span>
                      {t.title}
                      {t.description && <span className="text-neutral-600"> — {t.description}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Materials */}
          {materialList.length > 0 && (
            <Section title="Materiál">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-neutral-300 text-left text-neutral-600">
                    <th className="py-1 pr-2 font-semibold">Položka</th>
                    <th className="py-1 px-2 font-semibold text-right">Množství</th>
                    {showPrice && <th className="py-1 px-2 font-semibold text-right">Cena/j.</th>}
                    {showPrice && <th className="py-1 pl-2 font-semibold text-right">Celkem</th>}
                  </tr>
                </thead>
                <tbody>
                  {materialList.map((m) => {
                    const qty = m.quantity != null ? Number(m.quantity) : null;
                    const ppu = m.pricePerUnit != null ? Number(m.pricePerUnit) : null;
                    const lineTotal = qty != null && ppu != null ? qty * ppu : null;
                    return (
                      <tr key={m.id} className="border-b border-neutral-200">
                        <td className="py-1 pr-2">{m.name}</td>
                        <td className="py-1 px-2 text-right">
                          {qty != null ? `${qty}${m.unit ? " " + m.unit : ""}` : "—"}
                        </td>
                        {showPrice && (
                          <td className="py-1 px-2 text-right">{ppu != null ? fmtKc(ppu) : "—"}</td>
                        )}
                        {showPrice && (
                          <td className="py-1 pl-2 text-right">{lineTotal != null ? fmtKc(lineTotal) : "—"}</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                {showPrice && materialsTotal > 0 && (
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="py-1 pr-2" colSpan={3}>Materiál celkem</td>
                      <td className="py-1 pl-2 text-right">{fmtKc(materialsTotal)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </Section>
          )}

          {/* Hours summary */}
          {showTime && (hoursVasek > 0 || hoursJonas > 0 || hoursTotal > 0) && (
            <Section title="Odpracované hodiny">
              <div className="text-sm grid grid-cols-3 gap-2 max-w-sm">
                {hoursVasek > 0 && <MetaRow label="Vašek" value={`${hoursVasek} h`} />}
                {hoursJonas > 0 && <MetaRow label="Jonáš" value={`${hoursJonas} h`} />}
                <MetaRow label="Celkem" value={`${hoursTotal} h`} />
              </div>
            </Section>
          )}

          {/* Price summary */}
          {showPrice && grandTotal > 0 && (
            <Section title="Cenový souhrn">
              <div className="text-sm space-y-1 max-w-sm ml-auto">
                {workPrice > 0 && <PriceRow label="Práce" value={fmtKc(workPrice)} />}
                {materialsTotal > 0 && <PriceRow label="Materiál" value={fmtKc(materialsTotal)} />}
                {transportCost > 0 && <PriceRow label="Doprava" value={fmtKc(transportCost)} />}
                {parking > 0 && <PriceRow label="Parkování" value={fmtKc(parking)} />}
                {fines > 0 && <PriceRow label="Pokuty" value={fmtKc(fines)} />}
                <div className="flex justify-between border-t-2 border-neutral-900 pt-2 mt-2 text-base font-bold">
                  <span>Celkem</span>
                  <span>{fmtKc(grandTotal)}</span>
                </div>
                <p className="text-xs text-neutral-500 text-right">Ceny jsou uvedeny bez DPH.</p>
              </div>
            </Section>
          )}

          {/* Notes */}
          {job.notes && (
            <Section title="Poznámky">
              <p className="text-sm whitespace-pre-wrap text-neutral-700">{job.notes}</p>
            </Section>
          )}

          {/* Handover */}
          <div className="mt-10 border-t border-neutral-300 pt-6">
            <h3 className="text-sm font-bold uppercase tracking-wide mb-2">
              Potvrzení o předání a převzetí díla
            </h3>
            <p className="text-sm text-neutral-700 mb-8">
              Objednatel svým podpisem potvrzuje, že výše uvedené dílo bylo řádně provedeno,
              předáno a převzato bez vad a nedodělků.
            </p>
            <div className="grid grid-cols-2 gap-10 text-sm">
              <SignatureBlock label="Zhotovitel" imageSrc={contractorSig} />
              <div>
                <div className="h-16 flex items-end justify-center">
                  {customerSig ? (
                    <img
                      src={customerSig}
                      alt="Podpis objednatele"
                      crossOrigin="anonymous"
                      className="max-h-16 object-contain"
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPadOpen(true)}
                      className="no-print mb-1"
                    >
                      <PenLine className="w-4 h-4 mr-2" /> Podepsat
                    </Button>
                  )}
                </div>
                {sigTimestamp && (
                  <p className="text-xs text-neutral-500 text-center mt-0.5">
                    {new Date(sigTimestamp).toLocaleString("cs-CZ")}
                  </p>
                )}
                <div className="border-t border-neutral-700 pt-1 text-neutral-600 flex items-center justify-between">
                  <span>Objednatel</span>
                  {customerSig && (
                    <button
                      type="button"
                      onClick={() => setPadOpen(true)}
                      className="no-print text-xs text-neutral-400 hover:text-neutral-600 flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" /> Přepsat
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-neutral-500 mt-6">
              V ........................................ dne ........................
            </p>
          </div>
        </div>
      </div>

      <SignaturePad
        open={padOpen}
        onOpenChange={setPadOpen}
        onSave={handleSignatureSave}
        title="Podpis objednatele"
      />
    </div>
  );
}

function MetaRow({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <span className="text-neutral-500">{label}: </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-neutral-600">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-bold uppercase tracking-wide border-b border-neutral-300 pb-1 mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SignatureBlock({ label, imageSrc }: { label: string; imageSrc?: string }) {
  return (
    <div>
      <div className="h-16 flex items-end justify-center">
        {imageSrc && <img src={imageSrc} alt={`Podpis – ${label}`} className="max-h-16 object-contain" />}
      </div>
      <div className="border-t border-neutral-700 pt-1 text-neutral-600">{label}</div>
    </div>
  );
}
