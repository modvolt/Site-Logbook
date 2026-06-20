import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListInvoices,
  getListInvoicesQueryKey,
  useUpdateInvoiceStatus,
  getGetBillingSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ArrowLeft, FileText, Plus, ChevronRight, CircleDollarSign } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "Všechny stavy" },
  { value: "overdue", label: "Po splatnosti" },
  { value: "draft", label: "Koncept" },
  { value: "issued", label: "Vystaveno" },
  { value: "sent", label: "Odesláno" },
  { value: "paid", label: "Zaplaceno" },
  { value: "cancelled", label: "Stornováno" },
];

function initialStatus(): string {
  if (typeof window === "undefined") return "all";
  const param = new URLSearchParams(window.location.search).get("status");
  return param && STATUS_OPTIONS.some((o) => o.value === param) ? param : "all";
}

export default function BillingInvoices() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState(initialStatus);

  // "overdue" is a client-side view over all invoices, not a server status.
  const params = status === "all" || status === "overdue" ? undefined : { status };
  const { data, isLoading } = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });

  const markPaid = useUpdateInvoiceStatus();

  const invoices =
    status === "overdue"
      ? (data ?? []).filter((inv) => overdueDays(inv.dueDate, inv.status) != null)
      : data;

  const handleMarkPaid = (id: number) =>
    markPaid.mutate(
      { id, data: { status: "paid" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
          toast({ title: "Označeno jako zaplaceno" });
        },
        onError: () =>
          toast({ title: "Změna stavu se nezdařila", variant: "destructive" }),
      },
    );

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
        <Button onClick={() => setLocation("/billing/unbilled")} className="h-10">
          <Plus className="h-4 w-4 mr-2" /> Vytvořit fakturu
        </Button>
      </div>

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
        ) : invoices && invoices.length > 0 ? (
          invoices.map((inv) => {
            const overdue = overdueDays(inv.dueDate, inv.status);
            const canMarkPaid = inv.status === "issued" || inv.status === "sent";
            return (
              <Card
                key={inv.id}
                className={`hover:bg-muted/30 transition-colors cursor-pointer ${
                  overdue != null
                    ? "border-red-200 dark:border-red-900/60"
                    : ""
                }`}
                onClick={() => setLocation(`/billing/invoices/${inv.id}`)}
              >
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-base">
                        {inv.invoiceNumber || "Koncept (bez čísla)"}
                      </p>
                      <InvoiceStatusBadge status={inv.status} />
                      {overdue != null && <OverdueBadge days={overdue} />}
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5">
                      {inv.customerName || "—"}
                      {inv.issueDate ? ` · ${fmtDate(inv.issueDate)}` : ""}
                      {inv.dueDate ? ` · splatnost ${fmtDate(inv.dueDate)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <div className="font-bold">{fmtKc(inv.totalWithVat)}</div>
                      <div className="text-xs text-muted-foreground">s DPH</div>
                    </div>
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
            <p>{status === "overdue" ? "Žádné faktury po splatnosti." : "Žádné faktury."}</p>
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
