import { useState, useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetInvoice,
  useRecalculateInvoice,
  useIssueInvoice,
  useCancelInvoice,
  useDeleteInvoice,
  useUpdateInvoiceStatus,
  useSendInvoiceEmail,
  useSendInvoiceReminder,
  getInvoiceReminderPreview,
  downloadInvoicePdf,
  getGetInvoiceQueryKey,
  getListInvoicesQueryKey,
  getGetBillingSummaryQueryKey,
  getListUnbilledCustomersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { InvoiceStatusBadge, OverdueBadge } from "@/components/badges";
import { fmtKc, fmtDate, vatModeLabel, overdueDays } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ExternalLink,
  Pencil,
  RefreshCw,
  FileCheck2,
  Trash2,
  Download,
  Mail,
  Send,
  CircleDollarSign,
  Ban,
  BellRing,
  Loader2,
  AlertCircle,
} from "lucide-react";

export default function BillingInvoiceDetail() {
  const [, params] = useRoute("/billing/invoices/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: inv, isLoading, isError: invError } = useGetInvoice(id, {
    query: { queryKey: getGetInvoiceQueryKey(id), enabled: !!id },
  });

  const recalc = useRecalculateInvoice();
  const issue = useIssueInvoice();
  const cancel = useCancelInvoice();
  const remove = useDeleteInvoice();
  const updateStatus = useUpdateInvoiceStatus();
  const sendEmail = useSendInvoiceEmail();
  const sendReminder = useSendInvoiceReminder();

  const [downloading, setDownloading] = useState(false);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [returnJobs, setReturnJobs] = useState(true);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [paidOpen, setPaidOpen] = useState(false);
  const [paidDate, setPaidDate] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderTo, setReminderTo] = useState("");
  const [reminderSubject, setReminderSubject] = useState("");
  const [reminderMessage, setReminderMessage] = useState("");

  const [issueError, setIssueError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [paidError, setPaidError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);

  useEffect(() => { if (!confirmIssue) setIssueError(null); }, [confirmIssue]);
  useEffect(() => { if (!confirmCancel) setCancelError(null); }, [confirmCancel]);
  useEffect(() => { if (!paidOpen) setPaidError(null); }, [paidOpen]);
  useEffect(() => { if (!emailOpen) setEmailError(null); }, [emailOpen]);
  useEffect(() => { if (!reminderOpen) setReminderError(null); }, [reminderOpen]);

  const invalidateAll = () => {
    invalidateData(queryClient, "billingInvoices", "jobs");
  };

  const handleRecalc = () =>
    recalc.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: "Faktura přepočítána" });
        },
        onError: () => toast({ title: "Přepočet se nezdařil", variant: "destructive" }),
      },
    );

  const handleIssue = () =>
    issue.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateAll();
          setIssueError(null);
          setConfirmIssue(false);
          toast({ title: "Faktura vystavena" });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Vystavení se nezdařilo. Zkuste to prosím znovu.";
          setIssueError(msg);
          toast({ title: "Vystavení se nezdařilo", variant: "destructive" });
        },
      },
    );

  const handleDelete = () =>
    remove.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateData(queryClient, "billingInvoices");
          toast({ title: "Koncept smazán" });
          setLocation("/billing/invoices");
        },
        onError: () => {
          setConfirmDelete(false);
          toast({ title: "Smazání se nezdařilo", variant: "destructive" });
        },
      },
    );

  const handleCancel = () =>
    cancel.mutate(
      { id, data: { returnJobsToDone: returnJobs } },
      {
        onSuccess: () => {
          invalidateAll();
          setCancelError(null);
          setConfirmCancel(false);
          toast({ title: "Faktura stornována" });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Storno se nezdařilo. Zkuste to prosím znovu.";
          setCancelError(msg);
          toast({ title: "Storno se nezdařilo", variant: "destructive" });
        },
      },
    );

  const handleStatus = (status: "sent" | "paid") =>
    updateStatus.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          invalidateAll();
          setStatusError(null);
          toast({ title: status === "paid" ? "Označeno jako zaplaceno" : "Označeno jako odesláno" });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Změna stavu se nezdařila.";
          setStatusError(msg);
          toast({ title: "Změna stavu se nezdařila", variant: "destructive" });
        },
      },
    );

  const openPaid = () => {
    setPaidDate(inv?.paidDate ?? new Date().toISOString().slice(0, 10));
    setPaidAmount(
      inv?.paidAmount != null
        ? String(inv.paidAmount)
        : inv?.totalWithVat != null
          ? String(inv.totalWithVat)
          : "",
    );
    setPaidOpen(true);
  };

  const handleMarkPaid = () => {
    const amountNum = paidAmount.trim() === "" ? null : Number(paidAmount.replace(",", "."));
    if (amountNum != null && (Number.isNaN(amountNum) || amountNum < 0)) {
      setPaidError("Zadejte platnou částku (nezáporné číslo).");
      return;
    }
    setPaidError(null);
    updateStatus.mutate(
      {
        id,
        data: {
          status: "paid",
          paidDate: paidDate || null,
          paidAmount: amountNum,
        },
      },
      {
        onSuccess: () => {
          invalidateAll();
          setPaidOpen(false);
          toast({ title: "Označeno jako zaplaceno" });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Změna stavu se nezdařila. Zkuste to prosím znovu.";
          setPaidError(msg);
          toast({ title: "Změna stavu se nezdařila", variant: "destructive" });
        },
      },
    );
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await downloadInvoicePdf(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${inv?.invoiceNumber || "faktura"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Stažení PDF se nezdařilo", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const openEmail = () => {
    setEmailTo(inv?.customerEmail ?? "");
    setEmailSubject(inv?.invoiceNumber ? `Faktura ${inv.invoiceNumber}` : "Faktura");
    setEmailMessage("");
    setEmailOpen(true);
  };

  const handleSendEmail = () =>
    sendEmail.mutate(
      {
        id,
        data: {
          to: emailTo.trim() || null,
          subject: emailSubject.trim() || null,
          message: emailMessage.trim() || null,
        },
      },
      {
        onSuccess: (res) => {
          invalidateAll();
          if (!res.sent) {
            setEmailError("E-mail se nepodařilo odeslat. Zkontrolujte nastavení SMTP.");
            toast({ title: "E-mail se nepodařilo odeslat", variant: "destructive" });
            return;
          }
          setEmailOpen(false);
          toast({
            title: "E-mail odeslán",
            description: res.to ? `Příjemce: ${res.to}` : undefined,
          });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Odeslání e-mailu se nezdařilo. Zkuste to prosím znovu.";
          setEmailError(msg);
          toast({ title: "Odeslání e-mailu se nezdařilo", variant: "destructive" });
        },
      },
    );

  const openReminder = async () => {
    setReminderTo(inv?.customerEmail ?? "");
    setReminderSubject("");
    setReminderMessage("");
    setReminderOpen(true);
    setReminderLoading(true);
    try {
      const preview = await getInvoiceReminderPreview(id);
      setReminderTo((prev) => prev || preview.to || "");
      setReminderSubject(preview.subject);
      setReminderMessage(preview.message);
    } catch (err) {
      toast({ title: "Náhled upomínky se nepodařilo načíst", description: errMsg(err), variant: "destructive" });
    } finally {
      setReminderLoading(false);
    }
  };

  const handleSendReminder = () =>
    sendReminder.mutate(
      {
        id,
        data: {
          to: reminderTo.trim() || null,
          subject: reminderSubject.trim() || null,
          message: reminderMessage.trim() || null,
        },
      },
      {
        onSuccess: (res) => {
          invalidateAll();
          if (!res.sent) {
            setReminderError("Upomínku se nepodařilo odeslat. Zkontrolujte nastavení SMTP.");
            toast({ title: "Upomínku se nepodařilo odeslat", variant: "destructive" });
            return;
          }
          setReminderOpen(false);
          toast({
            title: "Upomínka odeslána",
            description: res.to ? `Příjemce: ${res.to}` : undefined,
          });
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Odeslání upomínky se nezdařilo. Zkuste to prosím znovu.";
          setReminderError(msg);
          toast({ title: "Odeslání upomínky se nezdařilo", variant: "destructive" });
        },
      },
    );

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (invError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground gap-3">
        <AlertCircle className="h-12 w-12 opacity-30" />
        <p className="font-medium">Nepodařilo se načíst fakturu</p>
        <p className="text-sm">Zkontrolujte připojení nebo zkuste stránku obnovit.</p>
        <Button variant="ghost" onClick={() => setLocation("/billing/invoices")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na faktury
        </Button>
      </div>
    );
  }

  if (!inv) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground gap-3">
        <AlertCircle className="h-12 w-12 opacity-20" />
        <p className="font-medium">Faktura nenalezena.</p>
        <Button variant="ghost" onClick={() => setLocation("/billing/invoices")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na faktury
        </Button>
      </div>
    );
  }

  const isDraft = inv.status === "draft";
  const isActive = inv.status === "issued" || inv.status === "sent" || inv.status === "paid";
  const showVat = inv.totalVat > 0;
  const overdue = overdueDays(inv.dueDate, inv.status);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing/invoices")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Faktury
      </Button>

      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{inv.invoiceNumber || "Koncept faktury"}</h1>
            <InvoiceStatusBadge status={inv.status} />
            {overdue !== null && <OverdueBadge days={overdue} />}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{inv.customerName || "—"}</p>
        </div>
      </div>

      {statusError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{statusError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        {isDraft && (
          <>
            <Button onClick={() => setLocation(`/billing/invoices/${id}/edit`)} className="h-10">
              <Pencil className="h-4 w-4 mr-2" /> Upravit
            </Button>
            <Button variant="outline" onClick={handleRecalc} disabled={recalc.isPending} className="h-10">
              <RefreshCw className={`h-4 w-4 mr-2 ${recalc.isPending ? "animate-spin" : ""}`} /> Přepočítat
            </Button>
            <Button variant="outline" onClick={() => setConfirmIssue(true)} className="h-10">
              <FileCheck2 className="h-4 w-4 mr-2" /> Vystavit
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="h-10 text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4 mr-2" /> Smazat
            </Button>
          </>
        )}
        {isActive && (
          <>
            <Button onClick={handleDownload} disabled={downloading} className="h-10">
              {downloading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Stáhnout PDF
            </Button>
            <Button variant="outline" onClick={openEmail} className="h-10">
              <Mail className="h-4 w-4 mr-2" /> Odeslat e-mailem
            </Button>
            {overdue !== null && (
              <Button variant="outline" onClick={openReminder} className="h-10">
                <BellRing className="h-4 w-4 mr-2" /> Poslat upomínku
              </Button>
            )}
            {inv.status === "issued" && (
              <Button variant="outline" onClick={() => handleStatus("sent")} disabled={updateStatus.isPending} className="h-10">
                <Send className="h-4 w-4 mr-2" /> Označit jako odesláno
              </Button>
            )}
            <Button variant="outline" onClick={openPaid} disabled={updateStatus.isPending} className="h-10">
              <CircleDollarSign className="h-4 w-4 mr-2" />
              {inv.status === "paid" ? "Upravit úhradu" : "Označit jako zaplaceno"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              className="h-10 text-destructive hover:bg-destructive/10"
            >
              <Ban className="h-4 w-4 mr-2" /> Stornovat
            </Button>
          </>
        )}
      </div>

      {/* Header info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2">
              Odběratel
              {inv.customerId != null && (
                <button
                  type="button"
                  onClick={() => setLocation(`/customers/${inv.customerId}`)}
                  className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Otevřít zákazníka
                </button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="font-semibold">{inv.customerName || "—"}</p>
            {inv.customerAddress && <p className="text-muted-foreground">{inv.customerAddress}</p>}
            <div className="flex gap-3 text-muted-foreground flex-wrap">
              {inv.customerIc && <span>IČ: {inv.customerIc}</span>}
              {inv.customerDic && <span>DIČ: {inv.customerDic}</span>}
            </div>
            {inv.customerEmail && <p className="text-muted-foreground">{inv.customerEmail}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Údaje faktury</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1.5">
            <InfoRow label="Datum vystavení" value={fmtDate(inv.issueDate)} />
            <InfoRow label="Datum zd. plnění" value={fmtDate(inv.taxableSupplyDate)} />
            <InfoRow label="Splatnost" value={fmtDate(inv.dueDate)} />
            <InfoRow label="Způsob platby" value={inv.paymentMethod || "—"} />
            <InfoRow label="Variabilní symbol" value={inv.variableSymbol || "—"} />
            <InfoRow label="Režim DPH" value={vatModeLabel(inv.vatModeDefault)} />
            {inv.paidDate && (
              <InfoRow label="Datum úhrady" value={fmtDate(inv.paidDate)} />
            )}
            {inv.paidAmount != null && (
              <InfoRow label="Uhrazeno" value={fmtKc(inv.paidAmount)} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Lines */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Položky</CardTitle>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Popis</TableHead>
                  <TableHead className="text-right">Množství</TableHead>
                  <TableHead className="text-right">Cena/MJ</TableHead>
                  {showVat && <TableHead className="text-right">DPH %</TableHead>}
                  <TableHead className="text-right">Bez DPH</TableHead>
                  {showVat && <TableHead className="text-right">S DPH</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-medium">{line.description}</TableCell>
                    <TableCell className="text-right">
                      {line.quantity}
                      {line.unit ? ` ${line.unit}` : ""}
                    </TableCell>
                    <TableCell className="text-right">{fmtKc(line.unitPriceWithoutVat)}</TableCell>
                    {showVat && (
                      <TableCell className="text-right">{line.vatRate != null ? `${line.vatRate} %` : "—"}</TableCell>
                    )}
                    <TableCell className="text-right">{fmtKc(line.totalWithoutVat)}</TableCell>
                    {showVat && <TableCell className="text-right">{fmtKc(line.totalWithVat)}</TableCell>}
                  </TableRow>
                ))}
                {inv.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={showVat ? 6 : 4} className="text-center text-muted-foreground py-6">
                      Žádné položky.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Totals */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Základ bez DPH</span>
              <span className="font-medium">{fmtKc(inv.subtotalWithoutVat)}</span>
            </div>
            {showVat && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">DPH</span>
                <span className="font-medium">{fmtKc(inv.totalVat)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-1.5 text-base font-bold">
              <span>Celkem</span>
              <span>{fmtKc(inv.totalWithVat)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {inv.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Poznámka</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap text-muted-foreground">{inv.notes}</CardContent>
        </Card>
      )}

      {/* Issue confirm */}
      <AlertDialog open={confirmIssue} onOpenChange={setConfirmIssue}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Vystavit fakturu?</AlertDialogTitle>
            <AlertDialogDescription>
              Faktuře bude přiřazeno číslo, vygeneruje se PDF a navázané zakázky se
              označí jako „Vyfakturováno". Tuto akci nelze vrátit (lze pouze stornovat).
            </AlertDialogDescription>
          </AlertDialogHeader>
          {issueError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{issueError}</span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <AlertDialogAction onClick={handleIssue} disabled={issue.isPending}>
              {issue.isPending ? "Vystavuji…" : "Vystavit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Smazat koncept?</AlertDialogTitle>
            <AlertDialogDescription>
              Koncept faktury bude trvale odstraněn. Navázané zakázky zůstanou
              nevyfakturované.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {remove.isPending ? "Mažu…" : "Smazat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel confirm */}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stornovat fakturu?</AlertDialogTitle>
            <AlertDialogDescription>
              Faktura bude označena jako stornovaná. Tuto akci nelze vrátit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm cursor-pointer py-1">
            <Checkbox checked={returnJobs} onCheckedChange={(v) => setReturnJobs(v === true)} />
            Vrátit navázané zakázky zpět do stavu „Hotovo"
          </label>
          {cancelError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{cancelError}</span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancel.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancel.isPending ? "Stornuji…" : "Stornovat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Payment dialog */}
      <Dialog open={paidOpen} onOpenChange={setPaidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Úhrada faktury</DialogTitle>
            <DialogDescription>
              Zadejte datum a uhrazenou částku. Pro částečnou platbu zadejte
              skutečně přijatou částku.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-sm mb-1 block">Datum úhrady</Label>
              <Input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-sm mb-1 block">Uhrazená částka (Kč)</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={paidAmount}
                onChange={(e) => { setPaidAmount(e.target.value); setPaidError(null); }}
                placeholder={inv.totalWithVat != null ? String(inv.totalWithVat) : ""}
                aria-invalid={!!paidError}
                className={paidError ? "border-destructive focus-visible:ring-destructive" : ""}
              />
              {paidError && (
                <p className="text-destructive text-xs mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  {paidError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPaidOpen(false)}>
              Zrušit
            </Button>
            <Button onClick={handleMarkPaid} disabled={updateStatus.isPending}>
              {updateStatus.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CircleDollarSign className="h-4 w-4 mr-2" />}
              Uložit úhradu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email dialog */}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Odeslat fakturu e-mailem</DialogTitle>
            <DialogDescription>Faktura se odešle jako PDF příloha.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-sm mb-1 block">Příjemce</Label>
              <Input type="email" value={emailTo} onChange={(e) => { setEmailTo(e.target.value); setEmailError(null); }} placeholder="email@firma.cz" />
            </div>
            <div>
              <Label className="text-sm mb-1 block">Předmět</Label>
              <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
            </div>
            <div>
              <Label className="text-sm mb-1 block">Zpráva</Label>
              <Textarea value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} rows={4} />
            </div>
            {emailError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{emailError}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEmailOpen(false)}>
              Zrušit
            </Button>
            <Button onClick={handleSendEmail} disabled={sendEmail.isPending || !emailTo.trim()}>
              {sendEmail.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
              Odeslat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reminder dialog */}
      <Dialog open={reminderOpen} onOpenChange={setReminderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Poslat upomínku</DialogTitle>
            <DialogDescription>
              Upomínka na neuhrazenou fakturu po splatnosti se odešle i s PDF přílohou.
            </DialogDescription>
          </DialogHeader>
          {reminderLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label className="text-sm mb-1 block">Příjemce</Label>
                <Input type="email" value={reminderTo} onChange={(e) => { setReminderTo(e.target.value); setReminderError(null); }} placeholder="email@firma.cz" />
              </div>
              <div>
                <Label className="text-sm mb-1 block">Předmět</Label>
                <Input value={reminderSubject} onChange={(e) => setReminderSubject(e.target.value)} />
              </div>
              <div>
                <Label className="text-sm mb-1 block">Zpráva</Label>
                <Textarea value={reminderMessage} onChange={(e) => setReminderMessage(e.target.value)} rows={6} />
              </div>
              {reminderError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{reminderError}</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReminderOpen(false)}>
              Zrušit
            </Button>
            <Button onClick={handleSendReminder} disabled={sendReminder.isPending || reminderLoading || !reminderTo.trim()}>
              {sendReminder.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BellRing className="h-4 w-4 mr-2" />}
              Odeslat upomínku
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}

function errMsg(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const detail = (data as { detail?: unknown; title?: unknown }).detail ?? (data as { title?: unknown }).title;
      if (typeof detail === "string") return detail;
    }
    if ("message" in err && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
  }
  return undefined;
}
