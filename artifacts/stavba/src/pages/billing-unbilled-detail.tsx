import { useState, useMemo } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetUnbilledCustomerDetail,
  useGetBillingSettings,
  useCreateInvoice,
  getGetUnbilledCustomerDetailQueryKey,
  getGetBillingSettingsQueryKey,
  getListUnbilledCustomersQueryKey,
  getGetBillingSummaryQueryKey,
  getListInvoicesQueryKey,
  useListApprovedCostLines,
  getListApprovedCostLinesQueryKey,
  type UnbilledJob,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeBadge } from "@/components/badges";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Building2, FileEdit, Inbox, Receipt } from "lucide-react";

function jobOrientationalTotal(job: UnbilledJob, billFine: boolean): number {
  let total = (job.price ?? 0) + (job.transportCost ?? 0) + (job.parking ?? 0);
  for (const m of job.materials) {
    if (m.quantity != null && m.pricePerUnit != null) total += m.quantity * m.pricePerUnit;
  }
  if (billFine) total += job.fines ?? 0;
  return total;
}

export default function BillingUnbilledDetail() {
  const [, params] = useRoute("/billing/unbilled/:customerId");
  const customerId = Number(params?.customerId);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useGetUnbilledCustomerDetail(customerId, {
    query: { queryKey: getGetUnbilledCustomerDetailQueryKey(customerId), enabled: !!customerId },
  });
  const { data: settings } = useGetBillingSettings({
    query: { queryKey: getGetBillingSettingsQueryKey() },
  });
  const createInvoice = useCreateInvoice();

  const { data: approvedLines } = useListApprovedCostLines(
    { customerId },
    {
      query: {
        queryKey: getListApprovedCostLinesQueryKey({ customerId }),
        enabled: !!customerId,
      },
    },
  );

  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [fines, setFines] = useState<Record<number, boolean>>({});

  const jobs = data?.jobs ?? [];
  const costLines = approvedLines ?? [];
  const costLinesTotal = useMemo(
    () => costLines.reduce((sum, l) => sum + (l.totalWithoutVat ?? 0), 0),
    [costLines],
  );

  // Default: all jobs selected once data loads.
  const allSelected = jobs.length > 0 && jobs.every((j) => selected[j.id] ?? true);
  const isChecked = (id: number) => selected[id] ?? true;

  const toggleAll = (value: boolean) => {
    const next: Record<number, boolean> = {};
    for (const j of jobs) next[j.id] = value;
    setSelected(next);
  };

  const chosenJobIds = useMemo(
    () => jobs.filter((j) => isChecked(j.id)).map((j) => j.id),
    [jobs, selected],
  );

  const estimatedTotal = useMemo(
    () =>
      jobs
        .filter((j) => isChecked(j.id))
        .reduce((sum, j) => sum + jobOrientationalTotal(j, !!fines[j.id]), 0),
    [jobs, selected, fines],
  );

  const handleCreate = () => {
    if (chosenJobIds.length === 0 && costLines.length === 0) return;
    const billFineJobIds = jobs
      .filter((j) => isChecked(j.id) && fines[j.id] && (j.fines ?? 0) > 0)
      .map((j) => j.id);
    const costLineInputs = costLines.map((line) => ({
      description: line.description,
      quantity: line.quantity ?? undefined,
      unit: line.unit ?? undefined,
      unitPriceWithoutVat: line.unitPriceWithoutVat ?? undefined,
      vatRate: line.vatRate ?? undefined,
      sourceType: "billing_document_line" as const,
      sourceId: line.id,
    }));
    createInvoice.mutate(
      {
        data: {
          customerId,
          jobIds: chosenJobIds,
          billFineJobIds,
          vatModeDefault: settings?.vatModeDefault ?? "standard",
          ...(costLineInputs.length > 0 ? { lines: costLineInputs } : {}),
        },
      },
      {
        onSuccess: (invoice) => {
          queryClient.invalidateQueries({ queryKey: getListUnbilledCustomersQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetUnbilledCustomerDetailQueryKey(customerId),
          });
          queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
          toast({ title: "Koncept faktury vytvořen" });
          setLocation(`/billing/invoices/${invoice.id}/edit`);
        },
        onError: () =>
          toast({ title: "Nepodařilo se vytvořit koncept", variant: "destructive" }),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-3">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Zákazník nenalezen nebo nemá nevyfakturované zakázky.
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing/unbilled")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Nevyfakturované zakázky
      </Button>

      <div className="flex items-center gap-3 mb-4">
        <div className="bg-primary/10 p-2.5 rounded-full text-primary shrink-0">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{data.companyName}</h1>
          <div className="text-sm text-muted-foreground flex flex-wrap gap-x-3">
            {data.ic && <span>IČ: {data.ic}</span>}
            {data.dic && <span>DIČ: {data.dic}</span>}
            {data.email && <span>{data.email}</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(v) => toggleAll(v === true)}
          />
          Vybrat vše
        </label>
        <span className="text-sm text-muted-foreground">
          Vybráno: {chosenJobIds.length} z {jobs.length}
        </span>
      </div>

      <div className="space-y-3 mb-6">
        {jobs.map((job) => {
          const checked = isChecked(job.id);
          return (
            <Card key={job.id} className={checked ? "border-primary/40" : "opacity-70"}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    className="mt-1"
                    checked={checked}
                    onCheckedChange={(v) =>
                      setSelected((p) => ({ ...p, [job.id]: v === true }))
                    }
                  />
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => setSelected((p) => ({ ...p, [job.id]: !checked }))}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold truncate">{job.title}</p>
                      {job.type && <TypeBadge type={job.type} />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{fmtDate(job.date)}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 mt-2 text-sm">
                      <PriceItem label="Práce" value={job.price} />
                      <PriceItem label="Doprava" value={job.transportCost} />
                      <PriceItem label="Parkování" value={job.parking} />
                      {(job.fines ?? 0) > 0 && (
                        <PriceItem label="Pokuty" value={job.fines} muted={!fines[job.id]} />
                      )}
                    </div>
                    {job.materials.length > 0 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Materiál:{" "}
                        {job.materials
                          .map(
                            (m) =>
                              `${m.name}${m.quantity != null ? ` (${m.quantity}${m.unit ? " " + m.unit : ""})` : ""}`,
                          )
                          .join(", ")}
                      </div>
                    )}
                    {(job.fines ?? 0) > 0 && (
                      <label
                        className="flex items-center gap-2 mt-2 text-sm cursor-pointer w-fit"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={!!fines[job.id]}
                          onCheckedChange={(v) =>
                            setFines((p) => ({ ...p, [job.id]: v === true }))
                          }
                        />
                        Účtovat pokutu ({fmtKc(job.fines, 0)})
                      </label>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold">
                      {fmtKc(jobOrientationalTotal(job, !!fines[job.id]), 0)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {costLines.length > 0 && (
        <Card className="mb-6 border-emerald-300 bg-emerald-50/60 dark:bg-emerald-900/15">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
              <Inbox className="h-4 w-4" />
              Schválené nákladové položky k přefakturaci
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Tyto položky ze schválených přijatých dokladů se automaticky přidají
              do nového konceptu faktury.
            </p>
            <div className="space-y-2">
              {costLines.map((line) => (
                <div
                  key={line.id}
                  className="flex items-start justify-between gap-3 text-sm border-b border-emerald-200/50 dark:border-emerald-800/40 pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{line.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {line.supplierName || "Neznámý dodavatel"}
                      {line.documentNumber ? ` · ${line.documentNumber}` : ""}
                      {" · "}
                      {line.quantity}
                      {line.unit ? ` ${line.unit}` : ""} ×{" "}
                      {fmtKc(line.unitPriceWithoutVat, 2)}
                    </p>
                  </div>
                  <div className="font-semibold shrink-0">
                    {fmtKc(line.totalWithoutVat, 2)}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between items-center mt-3 pt-2 border-t border-emerald-200/60 dark:border-emerald-800/50 text-sm">
              <span className="text-muted-foreground">Náklady celkem bez DPH</span>
              <span className="font-bold">{fmtKc(costLinesTotal, 2)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="sticky bottom-4 border-primary/30 bg-primary/5 backdrop-blur">
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Receipt className="h-3.5 w-3.5" /> Orientační celkem bez DPH
            </div>
            <div className="text-xl font-bold">
              {fmtKc(estimatedTotal + costLinesTotal, 0)}
            </div>
          </div>
          <Button
            onClick={handleCreate}
            disabled={
              (chosenJobIds.length === 0 && costLines.length === 0) ||
              createInvoice.isPending
            }
            className="h-11"
          >
            <FileEdit className="h-4 w-4 mr-2" />
            Vytvořit koncept faktury
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function PriceItem({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number | null | undefined;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "opacity-50 line-through" : ""}>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium">{fmtKc(value, 0)}</span>
    </div>
  );
}
