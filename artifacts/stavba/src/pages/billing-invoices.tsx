import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useListInvoices,
  useListCustomers,
  getListInvoicesQueryKey,
  useUpdateInvoiceStatus,
  useSendInvoiceReminder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InvoiceStatusBadge, OverdueBadge } from "@/components/badges";
import { fmtKc, fmtDate, overdueDays } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { useBillingListNavigation } from "@/hooks/use-billing-navigation";
import { zipSync } from "fflate";
import {
  ArrowLeft,
  FileText,
  Plus,
  ChevronRight,
  CircleDollarSign,
  BellRing,
  AlertCircle,
  CalendarClock,
  Download,
  Loader2,
} from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "Všechny stavy" },
  { value: "overdue", label: "Po splatnosti" },
  { value: "draft", label: "Koncept" },
  { value: "issued", label: "Vystaveno" },
  { value: "sent", label: "Odesláno" },
  { value: "paid", label: "Zaplaceno" },
  { value: "cancelled", label: "Stornováno" },
];

function readInvoiceStatus(search: string): string {
  const sp = new URLSearchParams(search);
  // Accept both ?status=overdue and ?overdue=true (deep-link from dashboard)
  const param =
    sp.get("status") ?? (sp.get("overdue") === "true" ? "overdue" : null);
  return param && STATUS_OPTIONS.some((o) => o.value === param) ? param : "all";
}

function buildInvoiceSearch(status: string, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("overdue");
  if (status === "all") params.delete("status");
  else params.set("status", status);
  const query = params.toString();
  return query ? `?${query}` : "";
}

type PeriodType = "month" | "year" | "custom";

type BulkInvoice = {
  id: number;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  pdfObjectPath?: string | null;
};

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export default function BillingInvoices() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = readInvoiceStatus(search);
  const today = new Date();
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [periodType, setPeriodType] = useState<PeriodType>("month");
  const [month, setMonth] = useState(localDateValue(today).slice(0, 7));
  const [year, setYear] = useState(String(today.getFullYear()));
  const [dateFrom, setDateFrom] = useState(`${today.getFullYear()}-01-01`);
  const [dateTo, setDateTo] = useState(localDateValue(today));
  const [customerId, setCustomerId] = useState("all");
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const { data: customers } = useListCustomers();

  // "overdue" is a client-side view over all invoices, not a server status.
  const params =
    status === "all" || status === "overdue" ? undefined : { status };
  const { data, isLoading, isError } = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });
  const { openDetail } = useBillingListNavigation(!isLoading);

  const setStatus = (nextStatus: string) => {
    setLocation(`/billing/invoices${buildInvoiceSearch(nextStatus, search)}`, {
      replace: true,
    });
  };

  const markPaid = useUpdateInvoiceStatus();
  const sendReminder = useSendInvoiceReminder();

  const invoices =
    status === "overdue"
      ? (data ?? []).filter(
          (inv) => overdueDays(inv.dueDate, inv.status) != null,
        )
      : data;

  const handleMarkPaid = (id: number) =>
    markPaid.mutate(
      { id, data: { status: "paid" } },
      {
        onSuccess: () => {
          invalidateData(queryClient, "billingInvoices");
          toast({ title: "Označeno jako zaplaceno" });
        },
        onError: () =>
          toast({ title: "Změna stavu se nezdařila", variant: "destructive" }),
      },
    );

  const handleSendReminder = (id: number) =>
    sendReminder.mutate(
      { id, data: { to: null, subject: null, message: null } },
      {
        onSuccess: (res) => {
          invalidateData(queryClient, "billingInvoices");
          toast({
            title: res.sent
              ? "Upomínka odeslána"
              : "Upomínku se nepodařilo odeslat",
            description: res.to ? `Příjemce: ${res.to}` : undefined,
            variant: res.sent ? undefined : "destructive",
          });
        },
        onError: () =>
          toast({
            title: "Odeslání upomínky se nezdařilo",
            variant: "destructive",
          }),
      },
    );

  const selectedRange = (): {
    from: string;
    to: string;
    label: string;
  } | null => {
    if (periodType === "month") {
      if (!/^\d{4}-\d{2}$/.test(month)) return null;
      const [selectedYear, selectedMonth] = month.split("-").map(Number);
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      return {
        from: `${month}-01`,
        to: `${month}-${String(lastDay).padStart(2, "0")}`,
        label: month,
      };
    }
    if (periodType === "year") {
      if (!/^\d{4}$/.test(year)) return null;
      return { from: `${year}-01-01`, to: `${year}-12-31`, label: year };
    }
    if (!dateFrom || !dateTo || dateFrom > dateTo) return null;
    return { from: dateFrom, to: dateTo, label: `${dateFrom}_${dateTo}` };
  };

  const handleBulkDownload = async () => {
    const range = selectedRange();
    if (!range) {
      toast({
        title: "Zkontrolujte zadané období",
        description: "Datum od nesmí být později než datum do.",
        variant: "destructive",
      });
      return;
    }

    setDownloadProgress("Vyhledávám faktury…");
    try {
      const query =
        customerId === "all"
          ? ""
          : `?customerId=${encodeURIComponent(customerId)}`;
      const listResponse = await fetch(`/api/billing/invoices${query}`);
      if (!listResponse.ok) throw new Error("Načtení faktur selhalo.");
      const allInvoices = (await listResponse.json()) as BulkInvoice[];
      const matching = allInvoices.filter(
        (invoice) =>
          invoice.pdfObjectPath &&
          invoice.issueDate &&
          invoice.issueDate >= range.from &&
          invoice.issueDate <= range.to,
      );

      if (matching.length === 0) {
        toast({
          title: "Žádné faktury ke stažení",
          description:
            "Ve vybraném období nejsou vystavené faktury s dostupným PDF.",
        });
        return;
      }

      const files: Record<string, Uint8Array> = {};
      for (let index = 0; index < matching.length; index += 1) {
        const invoice = matching[index];
        setDownloadProgress(`Stahuji ${index + 1} z ${matching.length}…`);
        const pdfResponse = await fetch(
          `/api/billing/invoices/${invoice.id}/pdf`,
        );
        if (!pdfResponse.ok) {
          throw new Error(
            `PDF faktury ${invoice.invoiceNumber ?? invoice.id} se nepodařilo stáhnout.`,
          );
        }
        const number =
          safeFilename(invoice.invoiceNumber ?? String(invoice.id)) ||
          String(invoice.id);
        files[`faktura-${number}-${invoice.id}.pdf`] = new Uint8Array(
          await pdfResponse.arrayBuffer(),
        );
      }

      setDownloadProgress("Vytvářím ZIP archiv…");
      const zipped = Uint8Array.from(zipSync(files, { level: 6 }));
      const url = URL.createObjectURL(
        new Blob([zipped.buffer], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      const customer = customers?.find(
        (item) => String(item.id) === customerId,
      );
      const customerSuffix = customer
        ? `-${safeFilename(customer.companyName)}`
        : "";
      link.href = url;
      link.download = `faktury-${range.label}${customerSuffix}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setDownloadOpen(false);
      toast({
        title: `Staženo ${matching.length} PDF`,
        description: "Faktury jsou uložené v jednom ZIP archivu.",
      });
    } catch (error) {
      toast({
        title: "Stažení faktur se nezdařilo",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDownloadProgress(null);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Fakturace
      </Button>

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Faktury</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="h-10"
            onClick={() => setDownloadOpen(true)}
            title="Stáhnout faktury za období"
          >
            <Download className="h-4 w-4 mr-2" /> Stáhnout
          </Button>
          <Button
            onClick={() => openDetail("/billing/unbilled")}
            className="h-10"
          >
            <Plus className="h-4 w-4 mr-2" /> Vytvořit fakturu
          </Button>
        </div>
      </div>

      <Dialog
        open={downloadOpen}
        onOpenChange={(open) => {
          if (!downloadProgress) setDownloadOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stáhnout faktury</DialogTitle>
            <DialogDescription>
              Vyberte období a případně jednoho odběratele. Vystavené faktury se
              stáhnou jako PDF v ZIP archivu.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invoice-download-period">Období</Label>
              <Select
                value={periodType}
                onValueChange={(value) => setPeriodType(value as PeriodType)}
              >
                <SelectTrigger id="invoice-download-period" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Měsíc</SelectItem>
                  <SelectItem value="year">Rok</SelectItem>
                  <SelectItem value="custom">Vlastní období</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {periodType === "month" && (
              <div className="space-y-2">
                <Label htmlFor="invoice-download-month">Měsíc</Label>
                <Input
                  id="invoice-download-month"
                  type="month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                />
              </div>
            )}
            {periodType === "year" && (
              <div className="space-y-2">
                <Label htmlFor="invoice-download-year">Rok</Label>
                <Input
                  id="invoice-download-year"
                  type="number"
                  min="2000"
                  max="2100"
                  inputMode="numeric"
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                />
              </div>
            )}
            {periodType === "custom" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="invoice-download-from">Od</Label>
                  <Input
                    id="invoice-download-from"
                    type="date"
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoice-download-to">Do</Label>
                  <Input
                    id="invoice-download-to"
                    type="date"
                    value={dateTo}
                    onChange={(event) => setDateTo(event.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="invoice-download-customer">Odběratel</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="invoice-download-customer" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Všichni odběratelé</SelectItem>
                  {(customers ?? []).map((customer) => (
                    <SelectItem key={customer.id} value={String(customer.id)}>
                      {customer.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={downloadProgress != null}
              onClick={() => setDownloadOpen(false)}
            >
              Zrušit
            </Button>
            <Button
              disabled={downloadProgress != null}
              onClick={handleBulkDownload}
            >
              {downloadProgress ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {downloadProgress ?? "Stáhnout faktury"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mb-6 max-w-xs">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <AlertCircle className="h-10 w-10 opacity-30" />
            <p className="font-medium">Nepodařilo se načíst faktury</p>
            <p className="text-sm">
              Zkontrolujte připojení nebo zkuste stránku obnovit.
            </p>
          </div>
        ) : invoices && invoices.length > 0 ? (
          invoices.map((inv) => {
            const overdue = overdueDays(inv.dueDate, inv.status);
            const canMarkPaid =
              inv.status === "issued" || inv.status === "sent";
            return (
              <Card
                key={inv.id}
                className={`overflow-hidden ${
                  overdue != null ? "border-red-200 dark:border-red-900/60" : ""
                }`}
              >
                <CardContent className="p-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => openDetail(`/billing/invoices/${inv.id}`)}
                    className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                    aria-label={`Otevřít fakturu ${inv.invoiceNumber || "koncept"}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-base">
                        {inv.invoiceNumber || "Koncept (bez čísla)"}
                      </p>
                      <InvoiceStatusBadge status={inv.status} />
                      {overdue != null && <OverdueBadge days={overdue} />}
                      {inv.recurringTemplateId != null && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                          <CalendarClock className="h-3 w-3" /> Paušál
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5">
                      {inv.customerName || "—"}
                      {inv.issueDate ? ` · ${fmtDate(inv.issueDate)}` : ""}
                      {inv.dueDate
                        ? ` · splatnost ${fmtDate(inv.dueDate)}`
                        : ""}
                    </p>
                    {inv.sourceJobs && inv.sourceJobs.length > 0 && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {inv.sourceJobs
                          .map((j) =>
                            j.jobNumber != null
                              ? `#${j.jobNumber} ${j.title}`
                              : j.title,
                          )
                          .join(", ")}
                      </p>
                    )}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openDetail(`/billing/invoices/${inv.id}`)}
                      className="text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                    >
                      <div className="font-bold">{fmtKc(inv.totalWithVat)}</div>
                      <div className="text-xs text-muted-foreground">s DPH</div>
                    </button>
                    {overdue != null && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 text-amber-700 border-amber-200 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-300 dark:border-amber-900 dark:hover:bg-amber-950/40"
                        disabled={sendReminder.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSendReminder(inv.id);
                        }}
                      >
                        <BellRing className="h-4 w-4 mr-1" />
                        Upomínka
                      </Button>
                    )}
                    {canMarkPaid && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 text-green-700 border-green-200 hover:bg-green-50 hover:text-green-800 dark:text-green-300 dark:border-green-900 dark:hover:bg-green-950/40"
                        disabled={markPaid.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMarkPaid(inv.id);
                        }}
                      >
                        <CircleDollarSign className="h-4 w-4 mr-1" />
                        Zaplaceno
                      </Button>
                    )}
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <FileText className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>
              {status === "overdue"
                ? "Žádné faktury po splatnosti."
                : "Žádné faktury."}
            </p>
            <p className="text-sm mt-1">
              {status === "overdue"
                ? "Skvělá práce, vše je uhrazeno včas."
                : "Vytvořte fakturu z nevyfakturovaných zakázek."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
