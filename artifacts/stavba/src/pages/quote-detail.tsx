import { useState, useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetQuote,
  useCreateQuote,
  useUpdateQuote,
  useDeleteQuote,
  useSendQuoteEmail,
  useAcceptQuote,
  useRejectQuote,
  useExpireQuote,
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
import { QuoteStatusBadge } from "@/components/quote-status-badge";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";

interface ItemForm {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: string;
}

const emptyItem: ItemForm = {
  description: "",
  quantity: "1",
  unit: "ks",
  unitPrice: "0",
  vatRate: "21",
};

function parseNum(s: string): number | null {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function computeTotals(items: ItemForm[], vatPayer = true) {
  let subtotalWithoutVat = 0;
  let totalVat = 0;
  for (const item of items) {
    const qty = parseNum(item.quantity) ?? 1;
    const unitPrice = parseNum(item.unitPrice) ?? 0;
    const vatRate = parseNum(item.vatRate) ?? 0;
    const base = Math.round(qty * unitPrice * 100) / 100;
    const vat = vatPayer ? Math.round(base * (vatRate / 100) * 100) / 100 : 0;
    subtotalWithoutVat += base;
    totalVat += vat;
  }
  subtotalWithoutVat = Math.round(subtotalWithoutVat * 100) / 100;
  totalVat = Math.round(totalVat * 100) / 100;
  return { subtotalWithoutVat, totalVat, totalWithVat: Math.round((subtotalWithoutVat + totalVat) * 100) / 100 };
}

function extractError(err: unknown): string {
  const msg = (err as any)?.response?.data?.error ?? (err as any)?.data?.error ?? (err as any)?.message;
  return typeof msg === "string" ? msg : "Neočekávaná chyba.";
}

export default function QuoteDetail() {
  const [loc, setLocation] = useLocation();
  const [matchDetail, paramsDetail] = useRoute<{ id: string }>("/quotes/:id");
  const isNew = !matchDetail || paramsDetail?.id === "new";
  const id = isNew ? null : parseInt(paramsDetail?.id ?? "0", 10);
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const customerIdFromUrl = searchParams?.get("customerId") ?? "";

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(isNew);
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState<string>(customerIdFromUrl);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemForm[]>([{ ...emptyItem }]);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");

  const { data: quote, isLoading: loadingQuote } = useGetQuote(id!, {
    query: { queryKey: getGetQuoteQueryKey(id!), enabled: id != null && id > 0 },
  });

  const { data: customers } = useListCustomers();

  const createQuote = useCreateQuote();
  const updateQuote = useUpdateQuote();
  const deleteQuote = useDeleteQuote();
  const sendEmail = useSendQuoteEmail();
  const acceptQuote = useAcceptQuote();
  const rejectQuote = useRejectQuote();
  const expireQuote = useExpireQuote();
  const convertToJob = useConvertQuoteToJob();

  useEffect(() => {
    if (quote && !isNew) {
      setTitle(quote.title);
      setCustomerId(quote.customerId ? String(quote.customerId) : "");
      setValidUntil(quote.validUntil ?? "");
      setNotes(quote.notes ?? "");
      setItems(
        quote.items.length > 0
          ? quote.items.map((i) => ({
              description: i.description,
              quantity: String(i.quantity),
              unit: i.unit ?? "",
              unitPrice: String(i.unitPrice),
              vatRate: i.vatRate != null ? String(i.vatRate) : "21",
            }))
          : [{ ...emptyItem }],
      );
    }
  }, [quote, isNew]);

  const buildPayload = () => ({
    title: title.trim(),
    customerId: customerId ? parseInt(customerId, 10) : null,
    validUntil: validUntil || null,
    notes: notes.trim() || null,
    items: items
      .filter((i) => i.description.trim())
      .map((i, idx) => ({
        description: i.description.trim(),
        quantity: parseNum(i.quantity) ?? 1,
        unit: i.unit.trim() || null,
        unitPrice: parseNum(i.unitPrice) ?? 0,
        vatRate: parseNum(i.vatRate),
        position: idx,
      })),
  });

  const invalidate = () => {
    invalidateData(queryClient, "quotes");
    if (id) queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(id) });
  };

  const handleSave = () => {
    if (!title.trim()) {
      toast({ title: "Název nabídky je povinný.", variant: "destructive" });
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
          onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
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
          onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
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
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );
  };

  const handleSend = () => {
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
          toast({ title: `Nabídka odeslána na ${r.to}` });
        },
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );
  };

  const handleAccept = () =>
    acceptQuote.mutate(
      { id: id! },
      {
        onSuccess: () => { invalidate(); toast({ title: "Nabídka přijata." }); },
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleReject = () =>
    rejectQuote.mutate(
      { id: id! },
      {
        onSuccess: () => { invalidate(); toast({ title: "Nabídka odmítnuta." }); },
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleExpire = () =>
    expireQuote.mutate(
      { id: id! },
      {
        onSuccess: () => { invalidate(); toast({ title: "Nabídka označena jako expirovaná." }); },
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleConvertToJob = () =>
    convertToJob.mutate(
      { id: id! },
      {
        onSuccess: (result) => {
          invalidate();
          invalidateData(queryClient, "jobs");
          toast({ title: "Zakázka vytvořena.", description: `Zakázka #${result.jobId}` });
          setLocation(`/jobs/${result.jobId}`);
        },
        onError: (err) => toast({ title: extractError(err), variant: "destructive" }),
      },
    );

  const handleDownloadPdf = () => {
    window.open(`/api/quotes/${id}/pdf`, "_blank");
  };

  const addItem = () => setItems((prev) => [...prev, { ...emptyItem }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const updateItem = (i: number, field: keyof ItemForm, value: string) =>
    setItems((prev) => prev.map((item, idx) => idx === i ? { ...item, [field]: value } : item));

  const totals = computeTotals(items);

  if (!isNew && loadingQuote) {
    return (
      <div className="p-4 max-w-3xl mx-auto space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  const isDraft = !quote || quote.status === "draft";
  const canSend = quote && ["draft", "sent"].includes(quote.status);
  const canAccept = quote && ["sent", "draft"].includes(quote.status);
  const canReject = quote && ["sent", "draft"].includes(quote.status);
  const canExpire = quote && ["sent", "draft"].includes(quote.status);
  const canConvert = quote && quote.status === "accepted" && !quote.convertedToJobId;
  const canDelete = quote && ["draft", "rejected", "expired"].includes(quote.status);
  const canEdit = !quote || quote.status === "draft";

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/quotes")}>
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
              <p className="text-sm text-muted-foreground font-mono">{quote.quoteNumber}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!isNew && canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-1" /> Upravit
            </Button>
          )}
          {!isNew && quote?.pdfObjectPath && (
            <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
              <Download className="h-4 w-4 mr-1" /> PDF
            </Button>
          )}
          {!isNew && canSend && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
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
            <Button variant="ghost" size="sm" onClick={handleExpire} disabled={expireQuote.isPending}>
              <AlertCircle className="h-4 w-4 mr-1" /> Expirovat
            </Button>
          )}
          {!isNew && canConvert && (
            <Button
              size="sm"
              onClick={handleConvertToJob}
              disabled={convertToJob.isPending}
            >
              <Briefcase className="h-4 w-4 mr-1" /> Převést na zakázku
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
          <CardContent className="py-3 px-4 text-sm text-green-800 dark:text-green-300 flex items-center gap-2">
            <Briefcase className="h-4 w-4" />
            Nabídka byla převedena na{" "}
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
      {(editing || isNew) ? (
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
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Vyberte zákazníka" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— bez zákazníka —</SelectItem>
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
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Položky</CardTitle>
                <Button size="sm" variant="outline" onClick={addItem}>
                  <Plus className="h-4 w-4 mr-1" /> Přidat
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {items.map((item, idx) => (
                  <div key={idx} className="border rounded-md p-3 space-y-2 relative">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <Label className="text-xs">Popis *</Label>
                        <Input
                          value={item.description}
                          onChange={(e) => updateItem(idx, "description", e.target.value)}
                          placeholder="Popis položky"
                          className="mt-0.5 h-8 text-sm"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 mt-5 text-destructive"
                        onClick={() => removeItem(idx)}
                        disabled={items.length === 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <Label className="text-xs">Množ.</Label>
                        <Input
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, "quantity", e.target.value)}
                          className="mt-0.5 h-8 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">MJ</Label>
                        <Input
                          value={item.unit}
                          onChange={(e) => updateItem(idx, "unit", e.target.value)}
                          placeholder="ks"
                          className="mt-0.5 h-8 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Cena/MJ (Kč)</Label>
                        <Input
                          value={item.unitPrice}
                          onChange={(e) => updateItem(idx, "unitPrice", e.target.value)}
                          className="mt-0.5 h-8 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">DPH %</Label>
                        <Input
                          value={item.vatRate}
                          onChange={(e) => updateItem(idx, "vatRate", e.target.value)}
                          placeholder="21"
                          className="mt-0.5 h-8 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Totals preview */}
              <div className="mt-4 text-right space-y-1 text-sm">
                <div className="text-muted-foreground">Celkem bez DPH: {fmtKc(totals.subtotalWithoutVat)}</div>
                <div className="text-muted-foreground">DPH: {fmtKc(totals.totalVat)}</div>
                <div className="font-semibold text-base">Celkem: {fmtKc(totals.totalWithVat)}</div>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2 justify-end">
            {!isNew && (
              <Button variant="outline" onClick={() => { setEditing(false); }}>
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
                      onClick={() => setLocation(`/customers/${quote.customerId}`)}
                    >
                      {quote.customerCompanyName}
                    </button>
                  </div>
                )}
                {quote.validUntil && (
                  <div className="text-sm text-muted-foreground">
                    Platná do: <span className="text-foreground font-medium">{fmtDate(quote.validUntil)}</span>
                  </div>
                )}
                {quote.notes && (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">{quote.notes}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Položky</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Popis</TableHead>
                      <TableHead className="text-right w-16">Množ.</TableHead>
                      <TableHead className="w-12">MJ</TableHead>
                      <TableHead className="text-right w-24">Cena/MJ</TableHead>
                      <TableHead className="text-right w-16">DPH %</TableHead>
                      <TableHead className="text-right w-28">Celkem</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quote.items.map((item) => {
                      const qty = Number(item.quantity);
                      const up = Number(item.unitPrice);
                      const vr = item.vatRate != null ? Number(item.vatRate) : 0;
                      const base = Math.round(qty * up * 100) / 100;
                      const vat = Math.round(base * (vr / 100) * 100) / 100;
                      const total = Math.round((base + vat) * 100) / 100;
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.description}</TableCell>
                          <TableCell className="text-right">{qty}</TableCell>
                          <TableCell>{item.unit ?? ""}</TableCell>
                          <TableCell className="text-right">{fmtKc(up)}</TableCell>
                          <TableCell className="text-right">{item.vatRate != null ? `${vr} %` : "—"}</TableCell>
                          <TableCell className="text-right font-medium">{fmtKc(total)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="px-4 py-3 text-right space-y-1 text-sm border-t">
                  {(() => {
                    const t = computeTotals(
                      quote.items.map((i) => ({
                        description: i.description,
                        quantity: String(i.quantity),
                        unit: i.unit ?? "",
                        unitPrice: String(i.unitPrice),
                        vatRate: i.vatRate != null ? String(i.vatRate) : "21",
                      })),
                    );
                    return (
                      <>
                        <div className="text-muted-foreground">Bez DPH: {fmtKc(t.subtotalWithoutVat)}</div>
                        <div className="text-muted-foreground">DPH: {fmtKc(t.totalVat)}</div>
                        <div className="font-bold text-base">Celkem: {fmtKc(t.totalWithVat)}</div>
                      </>
                    );
                  })()}
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

      {/* Send email dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Odeslat nabídku e-mailem</DialogTitle>
            <DialogDescription>
              PDF nabídky bude vygenerováno a odesláno zákazníkovi. Stav nabídky se změní na „Odeslaná".
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
            <Button onClick={handleSend} disabled={sendEmail.isPending || !sendTo.trim()}>
              <Send className="h-4 w-4 mr-1" />
              {sendEmail.isPending ? "Odesílám…" : "Odeslat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
