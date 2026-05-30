import { useState } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import {
  useGetActivity, getGetActivityQueryKey,
  useListActivityMaterials, getListActivityMaterialsQueryKey,
  useListActivityExtraWorks, getListActivityExtraWorksQueryKey,
  useListActivityAttachments, getListActivityAttachmentsQueryKey,
  useListActivityTimeEntries, getListActivityTimeEntriesQueryKey,
  useListCustomers,
} from "@workspace/api-client-react";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/lib/brand";
import { loadCompanySettings } from "@/lib/company-settings";

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  #akce-list, #akce-list * { visibility: visible !important; }
  #akce-list { position: absolute; left: 0; top: 0; width: 100%; margin: 0; box-shadow: none !important; }
  .no-print { display: none !important; }
}
`;

function fmtKc(n: number): string {
  return `${Math.round(n).toLocaleString("cs-CZ")} Kč`;
}

function fmtH(n: number): string {
  return `${Math.round(n * 100) / 100} h`;
}

function getAttachmentUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:")) return url;
  return `/api/storage${url}`;
}

export default function ActivityExport() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const [showPrice, setShowPrice] = useState(true);
  const [showPhotos, setShowPhotos] = useState(true);
  const [company] = useState(() => loadCompanySettings());

  const contractorName = company.name || BRAND_NAME;
  const contractorLogo = company.logoDataUrl || BRAND_LOGO_URL;

  const { data: activity, isLoading } = useGetActivity(id, {
    query: { enabled: !!id, queryKey: getGetActivityQueryKey(id) },
  });
  const { data: materials } = useListActivityMaterials(id, {
    query: { enabled: !!id, queryKey: getListActivityMaterialsQueryKey(id) },
  });
  const { data: extraWorks } = useListActivityExtraWorks(id, {
    query: { enabled: !!id, queryKey: getListActivityExtraWorksQueryKey(id) },
  });
  const { data: attachments } = useListActivityAttachments(id, {
    query: { enabled: !!id, queryKey: getListActivityAttachmentsQueryKey(id) },
  });
  const { data: timeEntries } = useListActivityTimeEntries(id, {
    query: { enabled: !!id, queryKey: getListActivityTimeEntriesQueryKey(id) },
  });
  const { data: customers } = useListCustomers();

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!activity) {
    return <div className="p-8 text-center">Akce nenalezena</div>;
  }

  const customer = customers?.find((c) => c.id === activity.customerId);
  const customerName = activity.customerName || customer?.companyName || "—";

  const materialList = materials ?? [];
  const extraWorkList = extraWorks ?? [];
  const entries = timeEntries ?? [];
  const photos = (attachments ?? []).filter(
    (a) => a.type === "photo" && getAttachmentUrl(a.url),
  );

  const materialsTotal = materialList.reduce((sum, m) => {
    const qty = m.quantity != null ? Number(m.quantity) : 0;
    const ppu = m.pricePerUnit != null ? Number(m.pricePerUnit) : 0;
    return sum + qty * ppu;
  }, 0);

  const extraWorksTotal = extraWorkList.reduce(
    (sum, w) => sum + (w.amount != null ? Number(w.amount) : 0),
    0,
  );

  const grandTotal = materialsTotal + extraWorksTotal;

  const hoursTotal = entries.reduce((sum, e) => sum + (e.hours != null ? Number(e.hours) : 0), 0);
  const legacyHours = activity.hoursSpent != null ? Number(activity.hoursSpent) : 0;
  // Per-person entries are the source of truth once any exist; only fall back to
  // the legacy single hoursSpent value when no per-person entries are recorded.
  const totalHours = entries.length > 0 ? hoursTotal : legacyHours;

  const status = activity.completedAt
    ? "Dokončeno"
    : activity.isArchived
      ? "Archivováno"
      : "Probíhá";

  return (
    <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 pb-16">
      <style>{PRINT_CSS}</style>

      {/* Toolbar */}
      <div className="no-print sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-3 max-w-3xl mx-auto w-full flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="shrink-0">
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-bold flex-1 min-w-0 truncate">Podklad k fakturaci</h1>
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
              checked={showPhotos}
              onChange={(e) => setShowPhotos(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Zobrazit fotky
          </label>
          <Button onClick={() => window.print()} className="shrink-0">
            <Printer className="h-4 w-4 mr-2" /> Tisk / Uložit PDF
          </Button>
        </div>
      </div>

      {/* Document */}
      <div className="max-w-3xl mx-auto w-full p-4 md:p-8">
        <div
          id="akce-list"
          className="bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10"
          style={{ maxWidth: "210mm" }}
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b-2 border-neutral-900 pb-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Podklad k fakturaci</h2>
              <p className="text-sm text-neutral-600 mt-1">Dlouhodobá akce č. {activity.id}</p>
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
              <p className="font-semibold">{customerName}</p>
              {customer?.contactPerson && <p className="text-neutral-600">{customer.contactPerson}</p>}
              {customer?.phone && <p className="text-neutral-600">{customer.phone}</p>}
              {customer?.email && <p className="text-neutral-600">{customer.email}</p>}
              {customer?.ic && <p className="text-neutral-600">IČ: {customer.ic}</p>}
              {customer?.dic && <p className="text-neutral-600">DIČ: {customer.dic}</p>}
            </div>
          </div>

          {/* Activity meta */}
          <div className="border border-neutral-300 rounded-md p-4 mb-6 text-sm">
            <p className="text-base font-bold mb-3">{activity.name}</p>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4">
              <MetaRow label="Druh" value="Dlouhodobá akce" />
              <MetaRow label="Stav" value={status} />
              <MetaRow label="Založeno" value={format(new Date(activity.createdAt), "d. M. yyyy")} />
              {activity.completedAt && (
                <MetaRow label="Dokončeno" value={format(new Date(activity.completedAt), "d. M. yyyy")} />
              )}
            </div>
            {activity.description && (
              <p className="text-neutral-700 whitespace-pre-wrap mt-3 pt-3 border-t border-neutral-200">
                {activity.description}
              </p>
            )}
          </div>

          {/* Hours per employee */}
          {(entries.length > 0 || totalHours > 0) && (
            <Section title="Odpracované hodiny">
              {entries.length > 0 ? (
                <table className="w-full text-sm border-collapse max-w-md">
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-b border-neutral-200">
                        <td className="py-1 pr-2">{e.personName}</td>
                        <td className="py-1 pl-2 text-right font-medium">
                          {fmtH(e.hours != null ? Number(e.hours) : 0)}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="py-1 pr-2">Celkem</td>
                      <td className="py-1 pl-2 text-right">{fmtH(totalHours)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div className="text-sm grid grid-cols-2 gap-2 max-w-xs">
                  <MetaRow label="Celkem" value={fmtH(totalHours)} />
                </div>
              )}
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

          {/* Extra works (vícepráce) */}
          {extraWorkList.length > 0 && (
            <Section title="Vícepráce">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-neutral-300 text-left text-neutral-600">
                    <th className="py-1 pr-2 font-semibold">Popis</th>
                    <th className="py-1 px-2 font-semibold text-right">Hodiny</th>
                    {showPrice && <th className="py-1 pl-2 font-semibold text-right">Cena</th>}
                  </tr>
                </thead>
                <tbody>
                  {extraWorkList.map((w) => (
                    <tr key={w.id} className="border-b border-neutral-200">
                      <td className="py-1 pr-2">
                        {w.description}
                        {w.note && <span className="text-neutral-500"> — {w.note}</span>}
                      </td>
                      <td className="py-1 px-2 text-right">
                        {w.hours != null ? fmtH(Number(w.hours)) : "—"}
                      </td>
                      {showPrice && (
                        <td className="py-1 pl-2 text-right">
                          {w.amount != null ? fmtKc(Number(w.amount)) : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                {showPrice && extraWorksTotal > 0 && (
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="py-1 pr-2" colSpan={2}>Vícepráce celkem</td>
                      <td className="py-1 pl-2 text-right">{fmtKc(extraWorksTotal)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </Section>
          )}

          {/* Price summary */}
          {showPrice && grandTotal > 0 && (
            <Section title="Cenový souhrn">
              <div className="text-sm space-y-1 max-w-sm ml-auto">
                {materialsTotal > 0 && <PriceRow label="Materiál" value={fmtKc(materialsTotal)} />}
                {extraWorksTotal > 0 && <PriceRow label="Vícepráce" value={fmtKc(extraWorksTotal)} />}
                <div className="flex justify-between border-t-2 border-neutral-900 pt-2 mt-2 text-base font-bold">
                  <span>Celkem</span>
                  <span>{fmtKc(grandTotal)}</span>
                </div>
                <p className="text-xs text-neutral-500 text-right">Ceny jsou uvedeny bez DPH.</p>
              </div>
            </Section>
          )}

          {/* Photos */}
          {showPhotos && photos.length > 0 && (
            <Section title="Fotodokumentace">
              <div className="grid grid-cols-2 gap-3">
                {photos.map((p) => (
                  <img
                    key={p.id}
                    src={getAttachmentUrl(p.url)}
                    alt={p.fileName || "Fotka"}
                    crossOrigin="anonymous"
                    className="w-full h-auto rounded-md border border-neutral-200 object-cover"
                  />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
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
