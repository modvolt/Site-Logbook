import { useState, useEffect, useRef } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetQuote,
  useGetQuoteEvidence,
  getGetQuoteEvidenceQueryKey,
  downloadQuotePdfFile,
  useCreateQuote,
  useUpdateQuote,
  useDeleteQuote,
  useSendQuoteEmail,
  useAcceptQuote,
  useRejectQuote,
  useExpireQuote,
  useReopenQuoteRevision,
  useConvertQuoteToJob,
  useListCustomers,
  getGetQuoteQueryKey,
  getListQuotesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QuoteStatusBadge } from "@/components/quote-status-badge";
import { fmtKc, fmtDate, VAT_RATE_OPTIONS } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import {
  computeQuoteFormTotals,
  createQuoteFormRow,
  formatQuoteInput,
  hasInvalidQuoteMargin,
  marginPercentFromPrices,
  parseQuoteNumber,
  unitPriceFromMargin,
  validateQuoteFormRows,
  type QuoteFormRow,
  type QuoteFormTotals,
  type QuoteRowType,
} from "@/lib/quote-calculations";
import {
  ArrowLeft,
  Save,
  Trash2,
  Send,
  Check,
  X,
  AlertCircle,
  Plus,
  Pencil,
  Building2,
  Download,
  Briefcase,
  RotateCcw,
  Copy,
  Link,
  ChevronDown,
  ChevronUp,
  Heading2,
  Minus,
  LockKeyhole,
  PackagePlus,
} from "lucide-react";

function marginTone(margin: number | null): string {
  if (margin == null) return "text-muted-foreground";
  if (margin < 0) return "text-red-700 dark:text-red-400";
  if (margin === 0) return "text-muted-foreground";
  return "text-emerald-700 dark:text-emerald-400";
}

function QuoteRowActions({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11 sm:h-8 sm:w-8"
        onClick={() => onMove(index - 1)}
        disabled={index === 0}
        title="Posunout nahoru"
        aria-label="Posunout řádek nahoru"
      >
        <ChevronUp className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11 sm:h-8 sm:w-8"
        onClick={() => onMove(index + 1)}
        disabled={index === count - 1}
        title="Posunout dolů"
        aria-label="Posunout řádek dolů"
      >
        <ChevronDown className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11 text-destructive hover:bg-destructive/10 sm:h-8 sm:w-8"
        onClick={onRemove}
        title="Odstranit řádek"
        aria-label="Odstranit řádek"
      >
        <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
      </Button>
    </div>
  );
}

function QuoteTotalsSummary({ totals }: { totals: QuoteFormTotals }) {
  return (
    <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <div className="flex items-start gap-2.5 text-left">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Interní marže nabídky
          </p>
          {totals.marginComplete ? (
            <>
              <p
                className={`mt-0.5 text-lg font-semibold ${marginTone(totals.marginAmount)}`}
              >
                {fmtKc(totals.marginAmount ?? 0)} ·{" "}
                {totals.marginPercent?.toLocaleString("cs-CZ", {
                  maximumFractionDigits: 2,
                }) ?? "—"}{" "}
                %
              </p>
              <p className="text-xs text-muted-foreground">
                Nákup celkem {fmtKc(totals.totalPurchaseCost)} bez DPH
              </p>
            </>
          ) : (
            <>
              <p className="mt-0.5 text-sm font-medium">Doplňte nákupní ceny</p>
              <p className="text-xs text-muted-foreground">
                Vyplněno {totals.costedItemCount} z {totals.financialItemCount}{" "}
                cenových položek. Chybějící cena se nepočítá jako nula.
              </p>
            </>
          )}
        </div>
      </div>
      <div className="space-y-1 text-right text-sm sm:border-l sm:pl-6">
        <div className="text-muted-foreground">
          Celkem bez DPH: {fmtKc(totals.subtotalWithoutVat)}
        </div>
        <div className="text-muted-foreground">
          DPH: {fmtKc(totals.totalVat)}
        </div>
        <div className="text-lg font-bold">
          Celkem: {fmtKc(totals.totalWithVat)}
        </div>
      </div>
    </div>
  );
}

function extractError(err: unknown): string {
  const msg =
    (err as any)?.response?.data?.error ??
    (err as any)?.data?.error ??
    (err as any)?.message;
  return typeof msg === "string" ? msg : "Neočekávaná chyba.";
}

function todayLocalIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export default function QuoteDetail() {
  const [loc, setLocation] = useLocation();
  const [matchDetail, paramsDetail] = useRoute<{ id: string }>("/quotes/:id");
  const isNew = !matchDetail || paramsDetail?.id === "new";
  const id = isNew ? null : parseInt(paramsDetail?.id ?? "0", 10);
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const customerIdFromUrl = searchParams?.get("customerId") ?? "";

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const downloadLock = useRef(false);
  const sendLock = useRef(false);
  const sendKey = useRef(crypto.randomUUID());
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(isNew);
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState<string>(customerIdFromUrl);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<QuoteFormRow[]>([createQuoteFormRow()]);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [plannedDate, setPlannedDate] = useState(todayLocalIso);
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");

  const {
    data: quote,
    isLoading: loadingQuote,
    isError: quoteFailed,
    error: quoteError,
    refetch: refetchQuote,
    isFetching: refreshingQuote,
  } = useGetQuote(id!, {
    query: {
      queryKey: getGetQuoteQueryKey(id!),
      enabled: id != null && id > 0,
    },
  });

  const { data: evidence, refetch: refetchEvidence } = useGetQuoteEvidence(
    id!,
    {
      query: {
        queryKey: getGetQuoteEvidenceQueryKey(id!),
        enabled: id != null && id > 0,
      },
    },
  );

  const { data: customers } = useListCustomers();

  const createQuote = useCreateQuote();
  const updateQuote = useUpdateQuote();
  const deleteQuote = useDeleteQuote();
  const sendEmail = useSendQuoteEmail({
    request: { headers: { "Idempotency-Key": sendKey.current } },
    mutation: { retry: false },
  });
  const acceptQuote = useAcceptQuote();
  const rejectQuote = useRejectQuote();
  const expireQuote = useExpireQuote();
  const reopenRevision = useReopenQuoteRevision();
  const convertToJob = useConvertQuoteToJob();

  useEffect(() => {
    if (quote && !isNew) {
      setTitle(quote.title);
      setCustomerId(quote.customerId ? String(quote.customerId) : "");
      setValidUntil(quote.validUntil ?? "");
      setNotes(quote.notes ?? "");
      setItems(
        quote.items.length > 0
          ? quote.items.map((i) => {
              const rowType = (i.rowType ?? "item") as QuoteRowType;
              const purchaseUnitPrice =
                i.purchaseUnitPrice != null ? String(i.purchaseUnitPrice) : "";
              const unitPrice = String(i.unitPrice);
              const purchase = parseQuoteNumber(purchaseUnitPrice);
              const sale = parseQuoteNumber(unitPrice);
              const margin =
                purchase != null && sale != null
                  ? marginPercentFromPrices(purchase, sale)
                  : null;
              return {
                clientId: `quote-item-${i.id}`,
                rowType,
                description: i.description,
                quantity: rowType === "item" ? String(i.quantity) : "",
                unit: rowType === "item" ? (i.unit ?? "") : "",
                unitPrice: rowType === "item" ? unitPrice : "",
                purchaseUnitPrice: rowType === "item" ? purchaseUnitPrice : "",
                marginPercent: margin != null ? formatQuoteInput(margin) : "",
                vatRate:
                  rowType === "item"
                    ? i.vatRate != null
                      ? String(i.vatRate)
                      : "21"
                    : "",
              };
            })
          : [createQuoteFormRow()],
      );
    }
  }, [quote, isNew]);

  const buildPayload = () => ({
    title: title.trim(),
    customerId: customerId ? parseInt(customerId, 10) : null,
    validUntil: validUntil || null,
    notes: notes.trim() || null,
    items: items.map((i, idx) =>
      i.rowType === "item"
        ? {
            rowType: i.rowType,
            description: i.description.trim(),
            quantity: parseQuoteNumber(i.quantity) ?? 1,
            unit: i.unit.trim() || null,
            unitPrice: parseQuoteNumber(i.unitPrice) ?? 0,
            purchaseUnitPrice: parseQuoteNumber(i.purchaseUnitPrice),
            vatRate: i.vatRate === "pdp" ? 0 : parseQuoteNumber(i.vatRate),
            position: idx,
          }
        : {
            rowType: i.rowType,
            description: i.rowType === "spacer" ? "" : i.description.trim(),
            position: idx,
          },
    ),
  });

  const invalidate = () => {
    void refetchEvidence();
    invalidateData(queryClient, "quotes");
    if (id)
      queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(id) });
  };

  const handleSave = () => {
    if (!title.trim()) {
      toast({ title: "Název nabídky je povinný.", variant: "destructive" });
      return;
    }
    const rowError = validateQuoteFormRows(items);
    if (rowError) {
      toast({ title: rowError, variant: "destructive" });
      return;
    }
    const payload = buildPayload();
    if (isNew) {
      createQuote.mutate(
        { data: payload },
        {
          onSuccess: (created) => {
            invalidate();
            toast({ title: "Nabídka vytvořena." });
            setLocation(`/quotes/${created.id}`);
          },
          onError: (err) =>
            toast({ title: extractError(err), variant: "destructive" }),
        },
      );
    } else {
      updateQuote.mutate(
        { id: id!, data: payload },
        {
          onSuccess: () => {
            invalidate();
            setEditing(false);
            toast({ title: "Nabídka uložena." });
          },
          onError: (err) =>
            toast({ title: extractError(err), variant: "destructive" }),
        },
      );
    }
  };

  const handleDelete = () => {
    deleteQuote.mutate(
      { id: id! },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Nabídka smazána." });
          setLocation("/quotes");
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );
  };

  const handleSend = () => {
    if (sendLock.current) return;
    sendLock.current = true;
    sendEmail.mutate(
      {
        id: id!,
        data: {
          to: sendTo.trim() || null,
          subject: sendSubject.trim() || null,
          message: sendMessage.trim() || null,
        },
      },
      {
        onSuccess: (r) => {
          setSendDialogOpen(false);
          invalidate();
          toast({ title: `SMTP server přijal nabídku pro ${r.to}` });
        },
        onError: (err) => {
          setSendDialogOpen(false);
          invalidate();
          toast({ title: extractError(err), variant: "destructive" });
        },
      },
    );
  };

  const handleAccept = () =>
    acceptQuote.mutate(
      { id: id! },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Nabídka přijata." });
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleReject = () =>
    rejectQuote.mutate(
      { id: id! },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Nabídka odmítnuta." });
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleExpire = () =>
    expireQuote.mutate(
      { id: id! },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Nabídka označena jako expirovaná." });
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleReopenRevision = () => {
    const reason = revisionReason.trim();
    if (reason.length < 3) {
      toast({
        title: "Uveďte důvod opravy (alespoň 3 znaky).",
        variant: "destructive",
      });
      return;
    }
    reopenRevision.mutate(
      { id: id!, data: { reason } },
      {
        onSuccess: (result) => {
          setRevisionDialogOpen(false);
          setRevisionReason("");
          setEditing(true);
          invalidate();
          toast({
            title: `Původní verze ${result.supersededVersion} byla zachována.`,
            description:
              "Nabídka je znovu koncept a lze vytvořit opravenou verzi.",
          });
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );
  };

  const handleConvertToJob = () =>
    convertToJob.mutate(
      { id: id!, data: { plannedDate } },
      {
        onSuccess: (result) => {
          setConvertDialogOpen(false);
          invalidate();
          invalidateData(queryClient, "jobs");
          queryClient.invalidateQueries({ queryKey: ["job-groups"] });
          toast({
            title: "Akce zakázek vytvořena.",
            description: `První zakázka #${result.jobId} je naplánována na ${fmtDate(plannedDate)}.`,
          });
          setLocation(`/job-groups/${result.jobGroupId}`);
        },
        onError: (err) =>
          toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleDownloadPdf = async (version?: number) => {
    if (downloadLock.current || !id) return;
    if (editing && version == null) {
      toast({
        title: "Nejprve uložte úpravy nabídky.",
        description: "PDF obsahuje uložená data. Použijte tlačítko Uložit.",
        variant: "destructive",
      });
      return;
    }
    downloadLock.current = true;
    setDownloading(true);
    try {
      const blob = await downloadQuotePdfFile(id, version);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nabidka-${(quote?.quoteNumber ?? String(id)).replace(/[^a-zA-Z0-9_.-]+/g, "-")}${version == null ? "" : `-v${version}`}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast({ title: extractError(err), variant: "destructive" });
    } finally {
      downloadLock.current = false;
      setDownloading(false);
    }
  };

  const addItem = (rowType: QuoteRowType = "item") =>
    setItems((prev) => [...prev, createQuoteFormRow(rowType)]);
  const removeItem = (i: number) =>
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  const updateItem = (i: number, field: keyof QuoteFormRow, value: string) =>
    setItems((prev) =>
      prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)),
    );
  const moveItem = (from: number, to: number) =>
    setItems((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  const updatePurchaseUnitPrice = (i: number, value: string) =>
    setItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== i) return item;
        const purchase = parseQuoteNumber(value);
        if (purchase == null)
          return { ...item, purchaseUnitPrice: value, marginPercent: "" };
        const currentMargin = parseQuoteNumber(item.marginPercent);
        const currentSale = parseQuoteNumber(item.unitPrice);
        if (
          item.purchaseUnitPrice.trim() !== "" &&
          currentMargin != null &&
          currentMargin >= -100
        ) {
          const sale = unitPriceFromMargin(purchase, currentMargin);
          return {
            ...item,
            purchaseUnitPrice: value,
            unitPrice: sale != null ? formatQuoteInput(sale) : item.unitPrice,
          };
        }
        const margin =
          currentSale != null
            ? marginPercentFromPrices(purchase, currentSale)
            : null;
        return {
          ...item,
          purchaseUnitPrice: value,
          marginPercent: margin != null ? formatQuoteInput(margin) : "",
        };
      }),
    );
  const updateMarginPercent = (i: number, value: string) =>
    setItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== i) return item;
        const purchase = parseQuoteNumber(item.purchaseUnitPrice);
        const margin = parseQuoteNumber(value);
        const sale =
          purchase != null && margin != null
            ? unitPriceFromMargin(purchase, margin)
            : null;
        return {
          ...item,
          marginPercent: value,
          // Never leave a stale selling price beside an impossible margin.
          unitPrice: sale != null ? formatQuoteInput(sale) : "",
        };
      }),
    );
  const updateUnitPrice = (i: number, value: string) =>
    setItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== i) return item;
        const purchase = parseQuoteNumber(item.purchaseUnitPrice);
        const sale = parseQuoteNumber(value);
        const margin =
          purchase != null && sale != null
            ? marginPercentFromPrices(purchase, sale)
            : null;
        return {
          ...item,
          unitPrice: value,
          marginPercent: margin != null ? formatQuoteInput(margin) : "",
        };
      }),
    );

  const totals = computeQuoteFormTotals(items);

  if (!isNew && loadingQuote) {
    return (
      <div className="p-4 max-w-3xl mx-auto space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (!isNew && (quoteFailed || !quote)) {
    return (
      <div className="mx-auto max-w-xl p-4">
        <Card>
          <CardContent className="flex flex-col items-center px-6 py-10 text-center">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-lg font-semibold">
              Nabídku se nepodařilo načíst
            </h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {quoteFailed
                ? extractError(quoteError)
                : "Nabídka nebyla nalezena nebo k ní nemáte přístup."}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => setLocation("/quotes")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Zpět na nabídky
              </Button>
              {id != null && id > 0 && (
                <Button
                  onClick={() => void refetchQuote()}
                  disabled={refreshingQuote}
                >
                  Zkusit znovu
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isDraft = !quote || quote.status === "draft";
  const canSend = quote && ["draft", "sent"].includes(quote.status);
  const canAccept = quote?.status === "sent";
  const canReject = quote?.status === "sent";
  const canExpire = quote?.status === "sent";
  const canReopenRevision =
    quote &&
    quote.status !== "draft" &&
    !quote.convertedToJobId &&
    !quote.convertedToInvoiceId;
  const canConvert =
    quote &&
    quote.status === "accepted" &&
    !quote.convertedToJobId &&
    !quote.convertedToJobGroupId;
  const canDelete = quote?.status === "draft";
  const canEdit = !quote || quote.status === "draft";

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/quotes")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold">
                {isNew ? "Nová nabídka" : (quote?.title ?? "Nabídka")}
              </h1>
              {quote && <QuoteStatusBadge status={quote.status} />}
            </div>
            {quote?.quoteNumber && (
              <p className="text-sm text-muted-foreground font-mono">
                {quote.quoteNumber}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!isNew && canEdit && !editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4 mr-1" /> Upravit
            </Button>
          )}
          {!isNew && quote && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDownloadPdf()}
              disabled={downloading}
              aria-busy={downloading}
            >
              <Download className="h-4 w-4 mr-1" />{" "}
              {downloading ? "Připravuji PDF…" : "Stáhnout PDF"}
            </Button>
          )}
          {!isNew && evidence && evidence.versions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={downloading}>
                  Archiv PDF <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {evidence.versions.map((version) => (
                  <DropdownMenuItem
                    key={version.id}
                    onClick={() => void handleDownloadPdf(version.version)}
                  >
                    Verze {version.version} · {fmtDate(version.createdAt)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!isNew && canSend && (
            <Button
              disabled={sendEmail.isPending}
              variant="outline"
              size="sm"
              onClick={() => {
                if (editing) {
                  toast({
                    title: "Nejprve uložte úpravy nabídky.",
                    variant: "destructive",
                  });
                  return;
                }
                sendKey.current = crypto.randomUUID();
                sendLock.current = false;
                setSendTo(quote?.customerEmail ?? "");
                setSendDialogOpen(true);
              }}
            >
              <Send className="h-4 w-4 mr-1" /> Odeslat
            </Button>
          )}
          {!isNew && canAccept && (
            <Button
              variant="outline"
              size="sm"
              className="text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-800"
              onClick={handleAccept}
              disabled={acceptQuote.isPending}
            >
              <Check className="h-4 w-4 mr-1" /> Přijata
            </Button>
          )}
          {!isNew && canReject && (
            <Button
              variant="outline"
              size="sm"
              className="text-red-700 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800"
              onClick={handleReject}
              disabled={rejectQuote.isPending}
            >
              <X className="h-4 w-4 mr-1" /> Odmítnuta
            </Button>
          )}
          {!isNew && canExpire && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExpire}
              disabled={expireQuote.isPending}
            >
              <AlertCircle className="h-4 w-4 mr-1" /> Expirovat
            </Button>
          )}
          {!isNew && canReopenRevision && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRevisionReason("");
                setRevisionDialogOpen(true);
              }}
              disabled={reopenRevision.isPending}
            >
              <RotateCcw className="h-4 w-4 mr-1" /> Opravit verzí
            </Button>
          )}
          {!isNew && canConvert && (
            <Button
              size="sm"
              onClick={() => {
                setPlannedDate(todayLocalIso());
                setConvertDialogOpen(true);
              }}
              disabled={convertToJob.isPending}
            >
              <Briefcase className="h-4 w-4 mr-1" /> Zahájit realizaci
            </Button>
          )}
          {!isNew && canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Converted notice */}
      {quote?.convertedToJobId && (
        <Card className="border-green-200 bg-green-50 dark:bg-green-950/20">
          <CardContent className="py-3 px-4 text-sm text-green-800 dark:text-green-300 flex items-center gap-2 flex-wrap">
            <Briefcase className="h-4 w-4" />
            Nabídka je realizována jako{" "}
            {quote.convertedToJobGroupId && (
              <button
                className="underline font-medium"
                onClick={() =>
                  setLocation(`/job-groups/${quote.convertedToJobGroupId}`)
                }
              >
                akce #{quote.convertedToJobGroupId}
              </button>
            )}
            {quote.convertedToJobGroupId && " a "}
            <button
              className="underline font-medium"
              onClick={() => setLocation(`/jobs/${quote.convertedToJobId}`)}
            >
              zakázku #{quote.convertedToJobId}
            </button>
          </CardContent>
        </Card>
      )}

      {/* Form / View */}
      {editing || isNew ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Základní údaje</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Název nabídky *</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Název projektu / popis prací"
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Zákazník</Label>
                <Select
                  value={customerId === "" ? "__none__" : customerId}
                  onValueChange={(v) =>
                    setCustomerId(v === "__none__" ? "" : v)
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Vyberte zákazníka" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— bez zákazníka —</SelectItem>
                    {(customers ?? []).map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.companyName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Platná do</Label>
                <Input
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  className="mt-1 w-48"
                />
              </div>
              <div>
                <Label>Poznámka</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Podmínky nabídky, poznámky pro zákazníka…"
                  className="mt-1"
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>

          {/* Items */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">
                    Položky a členění nabídky
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nákupní ceny a marže jsou interní. Zákazník je neuvidí v
                    odkazu ani v PDF.
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="self-start shrink-0"
                    >
                      <Plus className="mr-1 h-4 w-4" /> Přidat
                      <ChevronDown className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => addItem("item")}>
                      <PackagePlus className="mr-2 h-4 w-4" /> Cenová položka
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => addItem("section")}>
                      <Heading2 className="mr-2 h-4 w-4" /> Nadpis systému /
                      sekce
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => addItem("spacer")}>
                      <Minus className="mr-2 h-4 w-4" /> Prázdná mezera
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    Nabídka zatím nemá žádné řádky. Přidejte cenovou položku
                    nebo nadpis sekce.
                  </div>
                )}
                {items.map((item, idx) =>
                  item.rowType === "item" ? (
                    <div
                      key={item.clientId}
                      className="rounded-md border p-3 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          Cenová položka
                        </span>
                        <QuoteRowActions
                          index={idx}
                          count={items.length}
                          onMove={(to) => moveItem(idx, to)}
                          onRemove={() => removeItem(idx)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Popis položky *</Label>
                        <Input
                          value={item.description}
                          onChange={(e) =>
                            updateItem(idx, "description", e.target.value)
                          }
                          placeholder="Např. střídač, montáž nebo revize"
                          className="mt-0.5 h-9 text-sm"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                        <div>
                          <Label className="text-xs">Množ.</Label>
                          <Input
                            inputMode="decimal"
                            value={item.quantity}
                            onChange={(e) =>
                              updateItem(idx, "quantity", e.target.value)
                            }
                            className="mt-0.5 h-9 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">MJ</Label>
                          <Input
                            value={item.unit}
                            onChange={(e) =>
                              updateItem(idx, "unit", e.target.value)
                            }
                            placeholder="ks"
                            className="mt-0.5 h-9 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="flex items-center gap-1 text-xs">
                            Nákup/MJ{" "}
                            <LockKeyhole className="h-3 w-3 text-muted-foreground" />
                          </Label>
                          <Input
                            inputMode="decimal"
                            value={item.purchaseUnitPrice}
                            onChange={(e) =>
                              updatePurchaseUnitPrice(idx, e.target.value)
                            }
                            placeholder="Nevyplněno"
                            className="mt-0.5 h-9 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="flex items-center gap-1 text-xs">
                            Marže %{" "}
                            <LockKeyhole className="h-3 w-3 text-muted-foreground" />
                          </Label>
                          <Input
                            inputMode="decimal"
                            value={item.marginPercent}
                            onChange={(e) =>
                              updateMarginPercent(idx, e.target.value)
                            }
                            placeholder={
                              item.purchaseUnitPrice.trim() === ""
                                ? "Nejprve nákup"
                                : "—"
                            }
                            disabled={
                              parseQuoteNumber(item.purchaseUnitPrice) == null
                            }
                            aria-invalid={hasInvalidQuoteMargin(item)}
                            className="mt-0.5 h-9 text-sm"
                          />
                          {hasInvalidQuoteMargin(item) && (
                            <p className="mt-1 text-xs text-destructive">
                              Marže musí být alespoň −100 %.
                            </p>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs">Prodej/MJ</Label>
                          <Input
                            inputMode="decimal"
                            value={item.unitPrice}
                            onChange={(e) =>
                              updateUnitPrice(idx, e.target.value)
                            }
                            className="mt-0.5 h-9 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Sazba DPH</Label>
                          <Select
                            value={
                              item.vatRate === "pdp" || item.vatRate === "0"
                                ? "pdp"
                                : item.vatRate === "12"
                                  ? "12"
                                  : "21"
                            }
                            onValueChange={(v) => updateItem(idx, "vatRate", v)}
                          >
                            <SelectTrigger className="mt-0.5 h-9 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {VAT_RATE_OPTIONS.map((opt) => {
                                const val =
                                  opt.vatMode === "reverse_charge"
                                    ? "pdp"
                                    : String(opt.vatRate);
                                return (
                                  <SelectItem key={val} value={val}>
                                    {opt.label}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  ) : item.rowType === "section" ? (
                    <div
                      key={item.clientId}
                      className="rounded-md bg-muted/70 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <Heading2 className="h-4 w-4" /> Nadpis sekce
                        </span>
                        <QuoteRowActions
                          index={idx}
                          count={items.length}
                          onMove={(to) => moveItem(idx, to)}
                          onRemove={() => removeItem(idx)}
                        />
                      </div>
                      <div className="mt-2">
                        <Label className="text-xs">
                          Nadpis systému / sekce *
                        </Label>
                        <Input
                          value={item.description}
                          onChange={(e) =>
                            updateItem(idx, "description", e.target.value)
                          }
                          placeholder="Např. Fotovoltaický systém 10 kWp"
                          className="mt-0.5 h-9 bg-background text-sm font-medium"
                        />
                      </div>
                    </div>
                  ) : (
                    <div
                      key={item.clientId}
                      className="flex min-h-12 items-center gap-2 rounded-md border border-dashed px-3"
                    >
                      <Minus className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                        <span className="sm:hidden">Prázdná mezera</span>
                        <span className="hidden sm:inline">
                          Prázdná mezera v zákaznické nabídce
                        </span>
                      </span>
                      <QuoteRowActions
                        index={idx}
                        count={items.length}
                        onMove={(to) => moveItem(idx, to)}
                        onRemove={() => removeItem(idx)}
                      />
                    </div>
                  ),
                )}
              </div>

              {/* Totals preview */}
              <QuoteTotalsSummary totals={totals} />
            </CardContent>
          </Card>

          <div className="flex gap-2 justify-end">
            {!isNew && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(false);
                }}
              >
                Zrušit
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={createQuote.isPending || updateQuote.isPending}
            >
              <Save className="h-4 w-4 mr-1" />
              {isNew ? "Vytvořit nabídku" : "Uložit změny"}
            </Button>
          </div>
        </div>
      ) : (
        /* Read-only view */
        quote && (
          <div className="space-y-4">
            <Card>
              <CardContent className="py-4 px-4 space-y-3">
                {quote.customerCompanyName && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <button
                      className="font-medium underline text-foreground"
                      onClick={() =>
                        setLocation(`/customers/${quote.customerId}`)
                      }
                    >
                      {quote.customerCompanyName}
                    </button>
                  </div>
                )}
                {quote.validUntil && (
                  <div className="text-sm text-muted-foreground">
                    Platná do:{" "}
                    <span className="text-foreground font-medium">
                      {fmtDate(quote.validUntil)}
                    </span>
                  </div>
                )}
                {quote.notes && (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {quote.notes}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">Položky</CardTitle>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <LockKeyhole className="h-3.5 w-3.5" /> Nákup a marže jsou
                    interní
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-0">
                <div className="hidden overflow-x-auto md:block">
                  <Table className="min-w-[880px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Popis</TableHead>
                        <TableHead className="w-16 text-right">Množ.</TableHead>
                        <TableHead className="w-12">MJ</TableHead>
                        <TableHead className="w-24 text-right">
                          Nákup/MJ
                        </TableHead>
                        <TableHead className="w-24 text-right">
                          Prodej/MJ
                        </TableHead>
                        <TableHead className="w-20 text-right">Marže</TableHead>
                        <TableHead className="w-16 text-right">DPH</TableHead>
                        <TableHead className="w-28 text-right">
                          Celkem
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {quote.items.map((item) => {
                        const rowType = item.rowType ?? "item";
                        if (rowType === "section") {
                          return (
                            <TableRow
                              key={item.id}
                              className="bg-muted/70 hover:bg-muted/70"
                            >
                              <TableCell
                                colSpan={8}
                                className="py-3 font-semibold"
                              >
                                {item.description}
                              </TableCell>
                            </TableRow>
                          );
                        }
                        if (rowType === "spacer") {
                          return (
                            <TableRow
                              key={item.id}
                              className="h-7 border-0 hover:bg-transparent"
                            >
                              <TableCell colSpan={8} className="p-0" />
                            </TableRow>
                          );
                        }
                        const quantity = Number(item.quantity);
                        const unitPrice = Number(item.unitPrice);
                        const purchaseUnitPrice =
                          item.purchaseUnitPrice != null
                            ? Number(item.purchaseUnitPrice)
                            : null;
                        const margin =
                          purchaseUnitPrice != null
                            ? marginPercentFromPrices(
                                purchaseUnitPrice,
                                unitPrice,
                              )
                            : null;
                        const vatRate =
                          item.vatRate != null ? Number(item.vatRate) : 0;
                        const base =
                          Math.round(quantity * unitPrice * 100) / 100;
                        const vat =
                          Math.round(base * (vatRate / 100) * 100) / 100;
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="font-medium">
                              {item.description}
                            </TableCell>
                            <TableCell className="text-right">
                              {quantity}
                            </TableCell>
                            <TableCell>{item.unit ?? ""}</TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {purchaseUnitPrice != null
                                ? fmtKc(purchaseUnitPrice)
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {fmtKc(unitPrice)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium ${marginTone(margin)}`}
                            >
                              {margin != null
                                ? `${margin.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} %`
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {vatRate === 0
                                ? "PDP"
                                : item.vatRate != null
                                  ? `${vatRate} %`
                                  : "—"}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {fmtKc(base + vat)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="md:hidden">
                  {quote.items.map((item) => {
                    const rowType = item.rowType ?? "item";
                    if (rowType === "section") {
                      return (
                        <div
                          key={item.id}
                          className="border-t bg-muted/70 px-4 py-3 font-semibold"
                        >
                          {item.description}
                        </div>
                      );
                    }
                    if (rowType === "spacer") {
                      return (
                        <div
                          key={item.id}
                          className="h-6 border-t"
                          aria-hidden="true"
                        />
                      );
                    }
                    const quantity = Number(item.quantity);
                    const unitPrice = Number(item.unitPrice);
                    const purchaseUnitPrice =
                      item.purchaseUnitPrice != null
                        ? Number(item.purchaseUnitPrice)
                        : null;
                    const margin =
                      purchaseUnitPrice != null
                        ? marginPercentFromPrices(purchaseUnitPrice, unitPrice)
                        : null;
                    const vatRate =
                      item.vatRate != null ? Number(item.vatRate) : 0;
                    const base = Math.round(quantity * unitPrice * 100) / 100;
                    const vat = Math.round(base * (vatRate / 100) * 100) / 100;
                    return (
                      <div
                        key={item.id}
                        className="space-y-2 border-t px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="font-medium">{item.description}</p>
                          <p className="shrink-0 font-semibold">
                            {fmtKc(base + vat)}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <span className="text-muted-foreground">
                            {quantity} {item.unit ?? ""} × {fmtKc(unitPrice)}
                          </span>
                          <span className="text-right text-muted-foreground">
                            DPH {vatRate === 0 ? "PDP" : `${vatRate} %`}
                          </span>
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <LockKeyhole className="h-3 w-3" /> Nákup{" "}
                            {purchaseUnitPrice != null
                              ? fmtKc(purchaseUnitPrice)
                              : "—"}
                          </span>
                          <span
                            className={`text-right font-medium ${marginTone(margin)}`}
                          >
                            Marže{" "}
                            {margin != null
                              ? `${margin.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} %`
                              : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="px-4 pb-4">
                  <QuoteTotalsSummary totals={totals} />
                </div>
              </CardContent>
            </Card>
          </div>
        )
      )}

      {/* Delete dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Smazat nabídku?</AlertDialogTitle>
            <AlertDialogDescription>
              Nabídka bude trvale smazána. Tuto akci nelze vrátit zpět.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Smazat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conversion dialog */}
      <Dialog open={convertDialogOpen} onOpenChange={setConvertDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zahájit realizaci nabídky</DialogTitle>
            <DialogDescription>
              Vznikne akce zakázek a její první pracovní termín. Když se práce
              protáhne, přidáte další výjezd nebo zakázku do stejné akce.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="quote-planned-date">První plánovaný termín</Label>
            <Input
              id="quote-planned-date"
              type="date"
              value={plannedDate}
              onChange={(event) => setPlannedDate(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConvertDialogOpen(false)}
            >
              Zrušit
            </Button>
            <Button
              onClick={handleConvertToJob}
              disabled={convertToJob.isPending || !plannedDate}
            >
              <Briefcase className="h-4 w-4 mr-1" />
              {convertToJob.isPending ? "Vytvářím…" : "Vytvořit akci"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revisionDialogOpen} onOpenChange={setRevisionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vytvořit opravenou verzi</DialogTitle>
            <DialogDescription>
              Odeslaná verze, její PDF, otisky a historie rozhodnutí zůstanou
              beze změny. Nabídka se otevře jako nový koncept.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="quote-revision-reason">Důvod opravy *</Label>
            <Textarea
              id="quote-revision-reason"
              value={revisionReason}
              onChange={(event) => setRevisionReason(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Např. změna rozsahu prací po dohodě se zákazníkem"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevisionDialogOpen(false)}
            >
              Zrušit
            </Button>
            <Button
              onClick={handleReopenRevision}
              disabled={
                reopenRevision.isPending || revisionReason.trim().length < 3
              }
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              {reopenRevision.isPending
                ? "Otevírám…"
                : "Zachovat a otevřít opravu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send email dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Odeslat nabídku e-mailem</DialogTitle>
            <DialogDescription>
              PDF nabídky bude vygenerováno a odesláno zákazníkovi. Stav nabídky
              se změní na „Odeslaná".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>E-mail příjemce *</Label>
              <Input
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="zakaznik@example.com"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Předmět (volitelné)</Label>
              <Input
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder={`Cenová nabídka ${quote?.quoteNumber ?? ""}`}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Zpráva (volitelné)</Label>
              <Textarea
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
                placeholder="Dobrý den, v příloze zasíláme cenovou nabídku…"
                rows={3}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendDialogOpen(false)}>
              Zrušit
            </Button>
            <Button
              onClick={handleSend}
              disabled={sendEmail.isPending || !sendTo.trim()}
            >
              <Send className="h-4 w-4 mr-1" />
              {sendEmail.isPending ? "Odesílám…" : "Odeslat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
