import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import {
  useListCustomers,
  useListCustomerSites, getListCustomerSitesQueryKey,
  useListDeviceCredentials, getListDeviceCredentialsQueryKey,
  type DeviceCredential,
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
  #pristupy-list, #pristupy-list * { visibility: visible !important; }
  #pristupy-list { position: absolute; left: 0; top: 0; width: 100%; margin: 0; box-shadow: none !important; }
  .no-print { display: none !important; }
}
`;

const NO_SITE = "__none__";

export default function PristupoveUdajeExport() {
  const params = useParams();
  const customerId = parseInt(params.id || "0", 10);
  const [company] = useState(() => loadCompanySettings());

  const contractorName = company.name || BRAND_NAME;
  const contractorLogo = company.logoDataUrl || BRAND_LOGO_URL;

  const { data: customers, isLoading: loadingCustomers } = useListCustomers();
  const { data: sites } = useListCustomerSites(customerId, {
    query: {
      enabled: !!customerId,
      queryKey: getListCustomerSitesQueryKey(customerId),
    },
  });
  const { data: credentials, isLoading: loadingCreds } = useListDeviceCredentials(
    customerId,
    {
      query: {
        enabled: !!customerId,
        queryKey: getListDeviceCredentialsQueryKey(customerId),
      },
    },
  );

  const customer = customers?.find((c) => c.id === customerId);

  const siteName = (siteId: number | null | undefined) =>
    sites?.find((s) => s.id === siteId)?.name;

  const grouped = useMemo(() => {
    const groups = new Map<string, DeviceCredential[]>();
    for (const c of credentials ?? []) {
      const key = c.siteId ? String(c.siteId) : NO_SITE;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return groups;
  }, [credentials]);

  const orderedKeys = useMemo(() => {
    const keys = Array.from(grouped.keys());
    keys.sort((a, b) => {
      if (a === NO_SITE) return 1;
      if (b === NO_SITE) return -1;
      return (siteName(parseInt(a, 10)) || "").localeCompare(
        siteName(parseInt(b, 10)) || "",
      );
    });
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, sites]);

  if (loadingCustomers || loadingCreds) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!customer) {
    return <div className="p-8 text-center">Zákazník nenalezen</div>;
  }

  return (
    <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 pb-16">
      <style>{PRINT_CSS}</style>

      {/* Toolbar */}
      <div className="no-print sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-3 max-w-3xl mx-auto w-full flex items-center gap-3 flex-wrap">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.history.back()}
            className="shrink-0"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-bold flex-1 min-w-0 truncate">
            Přístupové údaje – export
          </h1>
          <Button onClick={() => window.print()} className="shrink-0">
            <Printer className="h-4 w-4 mr-2" /> Tisk / Uložit PDF
          </Button>
        </div>
      </div>

      {/* Document */}
      <div className="max-w-3xl mx-auto w-full p-4 md:p-8">
        <div
          id="pristupy-list"
          className="bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10"
          style={{ maxWidth: "210mm" }}
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b-2 border-neutral-900 pb-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Přístupové údaje</h2>
              <p className="text-sm text-neutral-600 mt-1">
                Přehled přihlašovacích údajů k zařízením
              </p>
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
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
                Zhotovitel
              </p>
              <p className="font-semibold">{contractorName}</p>
              {company.info && (
                <p className="text-neutral-600 whitespace-pre-line">{company.info}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
                Zákazník
              </p>
              <p className="font-semibold">{customer.companyName}</p>
              {customer.contactPerson && (
                <p className="text-neutral-600">{customer.contactPerson}</p>
              )}
              {customer.phone && <p className="text-neutral-600">{customer.phone}</p>}
              {customer.email && <p className="text-neutral-600">{customer.email}</p>}
              {customer.ic && <p className="text-neutral-600">IČ: {customer.ic}</p>}
              {customer.dic && <p className="text-neutral-600">DIČ: {customer.dic}</p>}
            </div>
          </div>

          {/* Credentials grouped by site */}
          {orderedKeys.length === 0 ? (
            <p className="text-sm text-neutral-600">
              Pro tohoto zákazníka nejsou uloženy žádné přístupové údaje.
            </p>
          ) : (
            orderedKeys.map((key) => {
              const list = grouped.get(key) ?? [];
              const label =
                key === NO_SITE
                  ? "Bez lokality"
                  : siteName(parseInt(key, 10)) || "Neznámá lokalita";
              return (
                <div key={key} className="mb-6 break-inside-avoid">
                  <h3 className="text-sm font-bold uppercase tracking-wide border-b border-neutral-300 pb-1 mb-3">
                    {label}
                  </h3>
                  <div className="space-y-4">
                    {list.map((c) => (
                      <CredBlock key={c.id} c={c} />
                    ))}
                  </div>
                </div>
              );
            })
          )}

          <p className="text-xs text-neutral-500 border-t border-neutral-300 pt-3 mt-8">
            Tento dokument obsahuje citlivé přístupové údaje. Uchovávejte jej
            bezpečně.
          </p>
        </div>
      </div>
    </div>
  );
}

function CredBlock({ c }: { c: DeviceCredential }) {
  const rows: { label: string; value: string }[] = [];
  if (c.ipAddress) rows.push({ label: "IP adresa", value: c.ipAddress });
  if (c.serialNumber) rows.push({ label: "Sériové číslo", value: c.serialNumber });
  if (c.username) rows.push({ label: "Uživatel", value: c.username });
  if (c.password) rows.push({ label: "Heslo", value: c.password });
  if (c.pin) rows.push({ label: "PIN", value: c.pin });
  if (c.email) rows.push({ label: "E-mail", value: c.email });

  return (
    <div className="border border-neutral-300 rounded-md p-4 break-inside-avoid">
      <p className="text-base font-bold mb-2">{c.type || "Zařízení"}</p>
      {rows.length > 0 && (
        <table className="w-full text-sm border-collapse">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-neutral-200 last:border-0">
                <td className="py-1 pr-4 text-neutral-500 align-top w-32">{r.label}</td>
                <td className="py-1 font-medium break-all">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.users && c.users.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
            Uživatelé
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-neutral-600">
                <th className="py-1 pr-4 font-semibold">Jméno</th>
                <th className="py-1 pr-4 font-semibold">PIN</th>
                <th className="py-1 font-semibold">Karty</th>
              </tr>
            </thead>
            <tbody>
              {c.users.map((u) => (
                <tr key={u.id} className="border-b border-neutral-200 last:border-0">
                  <td className="py-1 pr-4">{u.name || "—"}</td>
                  <td className="py-1 pr-4 font-medium">{u.pin || "—"}</td>
                  <td className="py-1 break-all">
                    {u.cards.length > 0 ? u.cards.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.note && (
        <p className="text-sm text-neutral-700 whitespace-pre-wrap mt-3 pt-2 border-t border-neutral-200">
          {c.note}
        </p>
      )}
    </div>
  );
}
