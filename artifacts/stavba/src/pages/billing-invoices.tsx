import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListInvoices,
  getListInvoicesQueryKey,
} from "@workspace/api-client-react";
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
import { InvoiceStatusBadge } from "@/components/badges";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import { ArrowLeft, FileText, Plus, ChevronRight } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "Všechny stavy" },
  { value: "draft", label: "Koncept" },
  { value: "issued", label: "Vystaveno" },
  { value: "sent", label: "Odesláno" },
  { value: "paid", label: "Zaplaceno" },
  { value: "cancelled", label: "Stornováno" },
];

export default function BillingInvoices() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState("all");

  const params = status === "all" ? undefined : { status };
  const { data, isLoading } = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });

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
        ) : data && data.length > 0 ? (
          data.map((inv) => (
            <Card
              key={inv.id}
              className="hover:bg-muted/30 transition-colors cursor-pointer"
              onClick={() => setLocation(`/billing/invoices/${inv.id}`)}
            >
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-base">
                      {inv.invoiceNumber || "Koncept (bez čísla)"}
                    </p>
                    <InvoiceStatusBadge status={inv.status} />
                  </div>
                  <p className="text-sm text-muted-foreground truncate mt-0.5">
                    {inv.customerName || "—"}
                    {inv.issueDate ? ` · ${fmtDate(inv.issueDate)}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold">{fmtKc(inv.totalWithVat)}</div>
                  <div className="text-xs text-muted-foreground">s DPH</div>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 ml-1" />
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <FileText className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Žádné faktury.</p>
            <p className="text-sm mt-1">
              Vytvořte fakturu z nevyfakturovaných zakázek.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
