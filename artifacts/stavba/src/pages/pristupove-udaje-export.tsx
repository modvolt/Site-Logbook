import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import {
  useListCustomers,
  useListCustomerSites, getListCustomerSitesQueryKey,
  useListDeviceCredentials, getListDeviceCredentialsQueryKey,
  useSendCredentialsEmail,
  useAuditCredentialExport,
  type DeviceCredential,
  type NetworkDevice,
} from "@workspace/api-client-react";
import { ArrowLeft, Printer, Mail, Loader2, Eye, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { jobSheetPdfBase64 } from "@/lib/job-sheet-pdf";
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

  /* Secret rows/cells hidden by default; shown only when checkbox was checked */
  .secret-row { display: none !important; }
  .print-include-secrets .secret-row { display: table-row !important; }
  .secret-cell { display: none !important; }
  .print-include-secrets .secret-cell { display: table-cell !important; }

  /* Print-only elements are hidden on screen, shown only in print */
  .print-only { display: inline !important; }
  /* Screen-only elements are always hidden in print */
  .screen-only { display: none !important; }
}
`;

const NO_SITE = "__none__";

export default function PristupoveUdajeExport() {
  const params = useParams();
  const customerId = parseInt(params.id || "0", 10);
  const [company] = useState(() => loadCompanySettings());
  const [secretsRevealed, setSecretsRevealed] = useState(false);
  const [includeSecretsPrint, setIncludeSecretsPrint] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendRecipients, setSendRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState("");
  const [sendToError, setSendToError] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const sendEmail = useSendCredentialsEmail();
  const auditExport = useAuditCredentialExport();

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

  useEffect(() => {
    if (!customerId) return;
    auditExport.mutate({ customerId });
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

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

  const handleIncludeSecretsChange = (checked: boolean) => {
    setIncludeSecretsPrint(checked);
    if (!checked) setSecretsRevealed(false);
  };

  const handleRevealSecrets = () => {
    setSecretsRevealed(true);
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const defaultSubject = "Přístupové údaje";
  const defaultBody = (companyName: string | undefined) =>
    `Dobrý den${companyName ? `, ${companyName}` : ""},\n\n` +
    `v příloze zasíláme přehled přístupových údajů k Vašim zařízením.\n\n` +
    `Tento dokument obsahuje citlivé údaje, uchovávejte jej prosím bezpečně.\n\n` +
    `S pozdravem,\nModvolt s.r.o.`;

  const handleOpenSendDialog = () => {
    const initial = customer?.email?.trim() ?? "";
    setSendRecipients(initial ? [initial] : []);
    setRecipientInput("");
    setSendToError("");
    setEmailSubject(defaultSubject);
    setEmailBody(defaultBody(customer?.companyName));
    setSendDialogOpen(true);
  };

  const commitRecipientInput = (): boolean => {
    const val = recipientInput.trim().replace(/,+$/, "");
    if (!val) return true;
    if (!EMAIL_RE.test(val)) {
      setSendToError(`Neplatná e-mailová adresa: ${val}`);
      return false;
    }
    if (!sendRecipients.includes(val)) {
      setSendRecipients((prev) => [...prev, val]);
    }
    setRecipientInput("");
    setSendToError("");
    return true;
  };

  const handleRecipientKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      e.preventDefault();
      commitRecipientInput();
    } else if (e.key === "Backspace" && recipientInput === "" && sendRecipients.length > 0) {
      setSendRecipients((prev) => prev.slice(0, -1));
    }
  };

  const handleRemoveRecipient = (addr: string) => {
    setSendRecipients((prev) => prev.filter((a) => a !== addr));
  };

  const handleConfirmSend = async () => {
    const ok = commitRecipientInput();
    if (!ok) return;

    const recipients = [...sendRecipients];
    if (recipientInput.trim()) {
      const val = recipientInput.trim().replace(/,+$/, "");
      if (val && !recipients.includes(val)) recipients.push(val);
    }

    if (recipients.length === 0) {
      setSendToError("Zadejte alespoň jednu e-mailovou adresu.");
      return;
    }

    const invalid = recipients.find((a) => !EMAIL_RE.test(a));
    if (invalid) {
      setSendToError(`Neplatná e-mailová adresa: ${invalid}`);
      return;
    }

    setSendToError("");
    const element = document.getElementById("pristupy-list");
    if (!element) return;
    try {
      const pdfBase64 = await jobSheetPdfBase64(element);
      const result = await sendEmail.mutateAsync({
        id: customerId,
        data: {
          pdfBase64,
          to: recipients,
          subject: emailSubject.trim() || undefined,
          message: emailBody.trim() || undefined,
        },
      });
      setSendDialogOpen(false);
      toast({
        title: "E-mail odeslán",
        description: `Přístupové údaje byly odeslány na ${result.to}.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Odeslání selhalo",
        description: "E-mail se nepodařilo odeslat. Zkuste to prosím znovu.",
      });
    }
  };

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

          {/* Include secrets in print checkbox */}
          <label className="flex items-center gap-2 cursor-pointer shrink-0 select-none text-sm">
            <Checkbox
              checked={includeSecretsPrint}
              onCheckedChange={(v) => handleIncludeSecretsChange(!!v)}
            />
            Tisknout hesla a PINy
          </label>

          {includeSecretsPrint && !secretsRevealed && (
            <Button
              variant="outline"
              onClick={handleRevealSecrets}
              className="shrink-0"
            >
              <Eye className="h-4 w-4 mr-2" />
              Zobrazit hesla a PINy
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleOpenSendDialog}
            disabled={sendEmail.isPending}
            className="shrink-0"
          >
            <Mail className="h-4 w-4 mr-2" />
            Odeslat e-mailem
          </Button>
          <Button onClick={() => window.print()} className="shrink-0">
            <Printer className="h-4 w-4 mr-2" /> Tisk / Uložit PDF
          </Button>
        </div>

        {/* Security notice bar */}
        <div className="px-3 pb-2 max-w-3xl mx-auto w-full">
          <div className="flex items-start gap-2 p-2 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded text-xs text-blue-700 dark:text-blue-300">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Otevření exportu bylo zaznamenáno do záznamu změn.
              {!includeSecretsPrint && (
                <span>
                  {" "}Hesla a PINy nejsou zahrnuty v tisku — zaškrtněte „Tisknout hesla a PINy" pro jejich vložení.
                </span>
              )}
              {includeSecretsPrint && !secretsRevealed && (
                <span>
                  {" "}Hesla a PINy budou zahrnuta v tisku. Na obrazovce jsou skryta — klikněte na „Zobrazit hesla a PINy" pro zobrazení.
                </span>
              )}
              {includeSecretsPrint && secretsRevealed && (
                <span>
                  {" "}Hesla a PINy jsou zobrazena a budou zahrnuta v tisku.
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Send email dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Odeslat přístupové údaje e-mailem</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="send-to">
                Komu (e-mail)
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  — oddělte čárkou nebo stiskněte Enter pro více adres
                </span>
              </Label>
              {/* Multi-chip recipient field */}
              <div
                className="flex flex-wrap gap-1.5 min-h-10 px-3 py-2 rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 cursor-text"
                onClick={() => recipientInputRef.current?.focus()}
              >
                {sendRecipients.map((addr) => (
                  <span
                    key={addr}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary border border-primary/20 max-w-[220px]"
                  >
                    <span className="truncate">{addr}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleRemoveRecipient(addr); }}
                      className="shrink-0 rounded-full hover:bg-primary/20 p-0.5 transition-colors"
                      aria-label={`Odebrat ${addr}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  id="send-to"
                  ref={recipientInputRef}
                  type="email"
                  inputMode="email"
                  placeholder={sendRecipients.length === 0 ? "adresa@example.com" : "Přidat adresu…"}
                  value={recipientInput}
                  onChange={(e) => {
                    setRecipientInput(e.target.value);
                    if (sendToError) setSendToError("");
                    if (e.target.value.endsWith(",")) {
                      setRecipientInput(e.target.value.slice(0, -1));
                      commitRecipientInput();
                    }
                  }}
                  onKeyDown={handleRecipientKeyDown}
                  onBlur={commitRecipientInput}
                  autoFocus
                  className="flex-1 min-w-[140px] border-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground py-0.5"
                />
              </div>
              {sendToError && (
                <p className="text-sm text-destructive">{sendToError}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-subject">Předmět</Label>
              <Input
                id="email-subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Předmět e-mailu"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-body">Zpráva</Label>
              <Textarea
                id="email-body"
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                rows={8}
                placeholder="Text e-mailu"
                className="resize-y font-mono text-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              PDF s přístupovými údaji bude přiloženo jako příloha.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendDialogOpen(false)}
              disabled={sendEmail.isPending}
            >
              Zrušit
            </Button>
            <Button onClick={handleConfirmSend} disabled={sendEmail.isPending}>
              {sendEmail.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              Odeslat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document */}
      <div className="max-w-3xl mx-auto w-full p-4 md:p-8">
        <div
          id="pristupy-list"
          className={`bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10${includeSecretsPrint ? " print-include-secrets" : ""}`}
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
                      <CredBlock
                        key={c.id}
                        c={c}
                        secretsRevealed={secretsRevealed}
                        includeSecretsPrint={includeSecretsPrint}
                      />
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

function CredBlock({
  c,
  secretsRevealed,
  includeSecretsPrint,
}: {
  c: DeviceCredential;
  secretsRevealed: boolean;
  includeSecretsPrint: boolean;
}) {
  const MASK = "••••••••";

  const publicRows: { label: string; value: string }[] = [];
  const secretRows: { label: string; value: string; masked: string }[] = [];

  if (c.ipAddress) publicRows.push({ label: "IP adresa", value: c.ipAddress });
  if (c.serialNumber) publicRows.push({ label: "Sériové číslo", value: c.serialNumber });
  if (c.email) publicRows.push({ label: "E-mail", value: c.email });
  if (c.username) publicRows.push({ label: "Uživatel", value: c.username });
  if (c.password) secretRows.push({ label: "Heslo", value: c.password, masked: MASK });
  if (c.pin) secretRows.push({ label: "PIN", value: c.pin, masked: "••••" });

  return (
    <div className="border border-neutral-300 rounded-md p-4 break-inside-avoid">
      <p className="text-base font-bold mb-2">{c.type || "Zařízení"}</p>
      {(publicRows.length > 0 || secretRows.length > 0) && (
        <table className="w-full text-sm border-collapse">
          <tbody>
            {publicRows.map((r) => (
              <tr key={r.label} className="border-b border-neutral-200 last:border-0">
                <td className="py-1 pr-4 text-neutral-500 align-top w-32">{r.label}</td>
                <td className="py-1 font-medium break-all">{r.value}</td>
              </tr>
            ))}
            {secretRows.map((r) => (
              <tr
                key={r.label}
                className={`border-b border-neutral-200 last:border-0 secret-row${!includeSecretsPrint ? " hidden" : ""}`}
              >
                <td className="py-1 pr-4 text-neutral-500 align-top w-32">{r.label}</td>
                <td className="py-1 font-medium font-mono break-all">
                  {/* Screen: masked until admin reveals */}
                  <span className="screen-only">
                    {secretsRevealed
                      ? r.value
                      : <span className="text-neutral-400 tracking-widest">{r.masked}</span>
                    }
                  </span>
                  {/* Print: always the real value (hidden on screen via display:none) */}
                  <span className="print-only" style={{ display: "none" }}>{r.value}</span>
                </td>
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
                <th className={`py-1 pr-4 font-semibold secret-cell${!includeSecretsPrint ? " hidden" : ""}`}>PIN</th>
                <th className="py-1 font-semibold">Karty</th>
              </tr>
            </thead>
            <tbody>
              {c.users.map((u) => (
                <tr key={u.id} className="border-b border-neutral-200 last:border-0">
                  <td className="py-1 pr-4">{u.name || "—"}</td>
                  <td className={`py-1 pr-4 font-medium font-mono secret-cell${!includeSecretsPrint ? " hidden" : ""}`}>
                    {/* Screen: masked until admin reveals */}
                    <span className="screen-only">
                      {u.pin
                        ? secretsRevealed
                          ? u.pin
                          : <span className="text-neutral-400 tracking-widest">••••</span>
                        : "—"
                      }
                    </span>
                    {/* Print: always the real value */}
                    <span className="print-only" style={{ display: "none" }}>
                      {u.pin || "—"}
                    </span>
                  </td>
                  <td className="py-1 break-all">
                    {u.cards.length > 0 ? u.cards.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.networkTopology && (c.networkTopology as NetworkDevice[]).length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
            Topologie sítě
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-neutral-600">
                <th className="py-1 pr-4 font-semibold">Typ</th>
                <th className="py-1 pr-4 font-semibold">Název</th>
                <th className="py-1 pr-4 font-semibold">IP adresa</th>
                <th className="py-1 font-semibold">Počet</th>
              </tr>
            </thead>
            <tbody>
              {(c.networkTopology as NetworkDevice[]).map((dev) => (
                <>
                  <tr key={dev.id} className="border-b border-neutral-200">
                    <td className="py-1 pr-4 text-neutral-500">{dev.deviceType}</td>
                    <td className="py-1 pr-4 font-medium">{dev.name || "—"}</td>
                    <td className="py-1 pr-4 font-mono">{dev.ipAddress || "—"}</td>
                    <td className="py-1">{dev.quantity}</td>
                  </tr>
                  {dev.ports.length > 0 && (
                    <tr key={`${dev.id}-ports`} className="border-b border-neutral-200 bg-neutral-50">
                      <td colSpan={4} className="py-1 pl-4 pr-2">
                        <table className="w-full text-xs">
                          <tbody>
                            {dev.ports.map((port) => (
                              <tr key={port.id}>
                                <td className="pr-3 py-0.5 font-mono text-neutral-500 w-12">{port.portNumber}</td>
                                <td className="pr-3 py-0.5">{port.name}</td>
                                <td className="py-0.5 text-neutral-500">{port.connectedDevice}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                  {dev.note && (
                    <tr key={`${dev.id}-note`} className="border-b border-neutral-200">
                      <td colSpan={4} className="py-0.5 pl-4 text-xs text-neutral-500 italic">{dev.note}</td>
                    </tr>
                  )}
                </>
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
