import { useState, useMemo, useEffect } from "react";
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
  type UnbilledActivity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeBadge } from "@/components/badges";
import { Input } from "@/components/ui/input";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Building2, FileEdit, Inbox, Receipt, Percent } from "lucide-react";

type UnbilledMaterial = UnbilledJob["materials"][number];

/** Material subtotal (purchase price, no markup) for a single job. */
function jobMaterialTotal(job: UnbilledJob): number {
  let total = 0;
  for (const m of job.materials) {
    if (m.quantity != null && m.pricePerUnit != null) total += m.quantity * m.pricePerUnit;
  }
  return total;
}

/** Material subtotal with each line's effective (per-material) markup applied. */
function jobMaterialTotalWithMarkup(
  job: UnbilledJob,
  effectiveMarkupFor: (m: UnbilledMaterial) => number,
): number {
  let total = 0;
  for (const m of job.materials) {
    if (m.quantity == null || m.pricePerUnit == null) continue;
    const base = m.quantity * m.pricePerUnit;
    const mk = effectiveMarkupFor(m);
    total += base * (mk > 0 ? 1 + mk / 100 : 1);
  }
  return total;
}

function jobOrientationalTotal(
  job: UnbilledJob,
  billFine: boolean,
  effectiveMarkupFor: (m: UnbilledMaterial) => number,
): number {
  let total = (job.price ?? 0) + (job.transportCost ?? 0) + (job.parking ?? 0);
  total += jobMaterialTotalWithMarkup(job, effectiveMarkupFor);
  if (billFine) total += job.fines ?? 0;
  return total;
}

/** Material subtotal (purchase price, no markup) for a single activity. */
function activityMaterialTotal(activity: UnbilledActivity): number {
  let total = 0;
  for (const m of activity.materials) {
    if (m.quantity != null && m.pricePerUnit != null) total += m.quantity * m.pricePerUnit;
  }
  return total;
}

/** Material subtotal with each line's effective markup applied, for one activity. */
function activityMaterialTotalWithMarkup(
  activity: UnbilledActivity,
  effectiveMarkupFor: (m: UnbilledMaterial) => number,
): number {
  let total = 0;
  for (const m of activity.materials) {
    if (m.quantity == null || m.pricePerUnit == null) continue;
    const base = m.quantity * m.pricePerUnit;
    const mk = effectiveMarkupFor(m);
    total += base * (mk > 0 ? 1 + mk / 100 : 1);
  }
  return total;
}

function activityExtraWorksTotal(activity: UnbilledActivity): number {
  return activity.extraWorks.reduce((sum, w) => sum + (w.amount ?? 0), 0);
}

function activityOrientationalTotal(
  activity: UnbilledActivity,
  effectiveMarkupFor: (m: UnbilledMaterial) => number,
): number {
  return (
    activityExtraWorksTotal(activity) +
    activityMaterialTotalWithMarkup(activity, effectiveMarkupFor)
  );
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
  const [selectedActivities, setSelectedActivities] = useState<Record<number, boolean>>({});
  const [fines, setFines] = useState<Record<number, boolean>>({});
  // Material markup (%) — prefilled with the saved default once settings load,
  // editable per invoice. Empty string is treated as 0 (no markup).
  const [markup, setMarkup] = useState<string>("");
  const [markupTouched, setMarkupTouched] = useState(false);
  // Per-material markup overrides (highest priority), keyed by a namespaced
  // `${sourceType}:${id}` key. Job materials and activity materials are separate
  // tables with colliding ids, so the namespace keeps their overrides distinct.
  // Stored as raw strings; an absent/blank entry means "use category → default".
  const [materialMarkup, setMaterialMarkup] = useState<Record<string, string>>({});

  type MaterialSource = "material" | "activity_material";
  const omKey = (sourceType: MaterialSource, id: number) => `${sourceType}:${id}`;

  useEffect(() => {
    if (!markupTouched && settings) {
      setMarkup(String(settings.materialMarkupPercent ?? 0));
    }
  }, [settings, markupTouched]);

  const markupPercent = useMemo(() => {
    const n = Number(markup);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [markup]);

  // Resolve the effective markup for a single material line:
  // per-line override → category default → invoice default. A blank/invalid
  // override falls through; an explicit 0 (override or category) wins.
  const effectiveMarkupFor = (sourceType: MaterialSource, m: UnbilledMaterial): number => {
    const ov = materialMarkup[omKey(sourceType, m.id)];
    if (ov !== undefined && ov.trim() !== "") {
      const n = Number(ov);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    if (m.categoryMarkupPercent != null && m.categoryMarkupPercent >= 0) {
      return m.categoryMarkupPercent;
    }
    return markupPercent;
  };

  // The label/source shown next to each material's markup input.
  const markupSourceFor = (
    sourceType: MaterialSource,
    m: UnbilledMaterial,
  ): "override" | "category" | "default" => {
    const ov = materialMarkup[omKey(sourceType, m.id)];
    if (ov !== undefined && ov.trim() !== "") {
      const n = Number(ov);
      if (Number.isFinite(n) && n >= 0) return "override";
    }
    if (m.categoryMarkupPercent != null && m.categoryMarkupPercent >= 0) return "category";
    return "default";
  };

  // Namespaced resolvers passed to the per-job / per-activity total helpers,
  // which call them as `(m) => number`.
  const jobMarkupFor = (m: UnbilledMaterial) => effectiveMarkupFor("material", m);
  const activityMarkupFor = (m: UnbilledMaterial) =>
    effectiveMarkupFor("activity_material", m);

  const jobs = data?.jobs ?? [];
  const activities = data?.activities ?? [];
  const costLines = approvedLines ?? [];
  const costLinesTotal = useMemo(
    () => costLines.reduce((sum, l) => sum + (l.totalWithoutVat ?? 0), 0),
    [costLines],
  );

  // Default: all jobs + activities selected once data loads.
  const allSelected =
    jobs.length + activities.length > 0 &&
    jobs.every((j) => selected[j.id] ?? true) &&
    activities.every((a) => selectedActivities[a.id] ?? true);
  const isChecked = (id: number) => selected[id] ?? true;
  const isActivityChecked = (id: number) => selectedActivities[id] ?? true;

  const toggleAll = (value: boolean) => {
    const nextJobs: Record<number, boolean> = {};
    for (const j of jobs) nextJobs[j.id] = value;
    setSelected(nextJobs);
    const nextActivities: Record<number, boolean> = {};
    for (const a of activities) nextActivities[a.id] = value;
    setSelectedActivities(nextActivities);
  };

  const chosenJobIds = useMemo(
    () => jobs.filter((j) => isChecked(j.id)).map((j) => j.id),
    [jobs, selected],
  );

  const chosenActivityIds = useMemo(
    () => activities.filter((a) => isActivityChecked(a.id)).map((a) => a.id),
    [activities, selectedActivities],
  );

  const estimatedTotal = useMemo(
    () =>
      jobs
        .filter((j) => isChecked(j.id))
        .reduce((sum, j) => sum + jobOrientationalTotal(j, !!fines[j.id], jobMarkupFor), 0) +
      activities
        .filter((a) => isActivityChecked(a.id))
        .reduce((sum, a) => sum + activityOrientationalTotal(a, activityMarkupFor), 0),
    [jobs, activities, selected, selectedActivities, fines, markupPercent, materialMarkup],
  );

  // Material purchase-price base across selected jobs + activities, plus markup.
  const selectedMaterialBase = useMemo(
    () =>
      jobs
        .filter((j) => isChecked(j.id))
        .reduce((sum, j) => sum + jobMaterialTotal(j), 0) +
      activities
        .filter((a) => isActivityChecked(a.id))
        .reduce((sum, a) => sum + activityMaterialTotal(a), 0),
    [jobs, activities, selected, selectedActivities],
  );
  // Total markup added across all selected materials (each at its effective %).
  const markupAmount = useMemo(
    () =>
      jobs
        .filter((j) => isChecked(j.id))
        .reduce(
          (sum, j) =>
            sum + (jobMaterialTotalWithMarkup(j, jobMarkupFor) - jobMaterialTotal(j)),
          0,
        ) +
      activities
        .filter((a) => isActivityChecked(a.id))
        .reduce(
          (sum, a) =>
            sum +
            (activityMaterialTotalWithMarkup(a, activityMarkupFor) - activityMaterialTotal(a)),
          0,
        ),
    [jobs, activities, selected, selectedActivities, markupPercent, materialMarkup],
  );

  const handleCreate = () => {
    if (
      chosenJobIds.length === 0 &&
      chosenActivityIds.length === 0 &&
      costLines.length === 0
    )
      return;
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
    // Send only explicit per-line overrides; the category default and the
    // invoice default are resolved server-side. (Materials on unselected jobs
    // or activities are ignored.)
    const selectedJobIds = new Set(chosenJobIds);
    const selectedActivityIds = new Set(chosenActivityIds);
    const materialMarkupOverrides: {
      materialId: number;
      markupPercent: number;
      sourceType: MaterialSource;
    }[] = [];
    const collectOverride = (sourceType: MaterialSource, id: number) => {
      const ov = materialMarkup[omKey(sourceType, id)];
      if (ov === undefined || ov.trim() === "") return;
      const n = Number(ov);
      if (Number.isFinite(n) && n >= 0) {
        materialMarkupOverrides.push({ materialId: id, markupPercent: n, sourceType });
      }
    };
    for (const job of jobs) {
      if (!selectedJobIds.has(job.id)) continue;
      for (const m of job.materials) collectOverride("material", m.id);
    }
    for (const activity of activities) {
      if (!selectedActivityIds.has(activity.id)) continue;
      for (const m of activity.materials) collectOverride("activity_material", m.id);
    }
    createInvoice.mutate(
      {
        data: {
          customerId,
          jobIds: chosenJobIds,
          ...(chosenActivityIds.length > 0 ? { activityIds: chosenActivityIds } : {}),
          billFineJobIds,
          materialMarkupPercent: markupPercent,
          ...(materialMarkupOverrides.length > 0 ? { materialMarkupOverrides } : {}),
          vatModeDefault: settings?.vatModeDefault ?? "standard",
          ...(costLineInputs.length > 0 ? { lines: costLineInputs } : {}),
        },
      },
      {
        onSuccess: (invoice) => {
          invalidateData(queryClient, "billingInvoices");
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
          Vybráno: {chosenJobIds.length + chosenActivityIds.length} z{" "}
          {jobs.length + activities.length}
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
                      <div
                        className="mt-2 space-y-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-xs font-medium text-muted-foreground">
                          Materiál – přirážka
                        </p>
                        {job.materials.map((m) => {
                          const source = markupSourceFor("material", m);
                          const eff = effectiveMarkupFor("material", m);
                          const mkKey = omKey("material", m.id);
                          return (
                            <div
                              key={m.id}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span className="flex-1 min-w-0 truncate">
                                {m.name}
                                {m.quantity != null
                                  ? ` (${m.quantity}${m.unit ? " " + m.unit : ""})`
                                  : ""}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  source === "override"
                                    ? "bg-primary/15 text-primary"
                                    : source === "category"
                                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                      : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {source === "override"
                                  ? "vlastní"
                                  : source === "category"
                                    ? "kategorie"
                                    : "výchozí"}
                              </span>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={
                                  materialMarkup[mkKey] !== undefined
                                    ? materialMarkup[mkKey]
                                    : String(eff)
                                }
                                onChange={(e) =>
                                  setMaterialMarkup((p) => ({
                                    ...p,
                                    [mkKey]: e.target.value,
                                  }))
                                }
                                className="h-7 w-[72px] text-xs"
                              />
                              <span className="text-muted-foreground">%</span>
                              {materialMarkup[mkKey] !== undefined && (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground underline"
                                  onClick={() =>
                                    setMaterialMarkup((p) => {
                                      const next = { ...p };
                                      delete next[mkKey];
                                      return next;
                                    })
                                  }
                                >
                                  zpět
                                </button>
                              )}
                            </div>
                          );
                        })}
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
                      {fmtKc(
                        jobOrientationalTotal(job, !!fines[job.id], jobMarkupFor),
                        0,
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {activities.map((activity) => {
          const checked = isActivityChecked(activity.id);
          return (
            <Card
              key={`activity-${activity.id}`}
              className={checked ? "border-primary/40" : "opacity-70"}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    className="mt-1"
                    checked={checked}
                    onCheckedChange={(v) =>
                      setSelectedActivities((p) => ({ ...p, [activity.id]: v === true }))
                    }
                  />
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() =>
                      setSelectedActivities((p) => ({ ...p, [activity.id]: !checked }))
                    }
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold truncate">{activity.name}</p>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">
                        akce
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {fmtDate(activity.completedAt)}
                    </p>
                    {activity.extraWorks.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 mt-2 text-sm">
                        {activity.extraWorks.map((w) => (
                          <div key={w.id}>
                            <span className="text-muted-foreground">{w.description}: </span>
                            <span className="font-medium">{fmtKc(w.amount, 0)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {activity.materials.length > 0 && (
                      <div
                        className="mt-2 space-y-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-xs font-medium text-muted-foreground">
                          Materiál – přirážka
                        </p>
                        {activity.materials.map((m) => {
                          const source = markupSourceFor("activity_material", m);
                          const eff = effectiveMarkupFor("activity_material", m);
                          const mkKey = omKey("activity_material", m.id);
                          return (
                            <div key={m.id} className="flex items-center gap-2 text-xs">
                              <span className="flex-1 min-w-0 truncate">
                                {m.name}
                                {m.quantity != null
                                  ? ` (${m.quantity}${m.unit ? " " + m.unit : ""})`
                                  : ""}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  source === "override"
                                    ? "bg-primary/15 text-primary"
                                    : source === "category"
                                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                      : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {source === "override"
                                  ? "vlastní"
                                  : source === "category"
                                    ? "kategorie"
                                    : "výchozí"}
                              </span>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={
                                  materialMarkup[mkKey] !== undefined
                                    ? materialMarkup[mkKey]
                                    : String(eff)
                                }
                                onChange={(e) =>
                                  setMaterialMarkup((p) => ({
                                    ...p,
                                    [mkKey]: e.target.value,
                                  }))
                                }
                                className="h-7 w-[72px] text-xs"
                              />
                              <span className="text-muted-foreground">%</span>
                              {materialMarkup[mkKey] !== undefined && (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground underline"
                                  onClick={() =>
                                    setMaterialMarkup((p) => {
                                      const next = { ...p };
                                      delete next[mkKey];
                                      return next;
                                    })
                                  }
                                >
                                  zpět
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold">
                      {fmtKc(activityOrientationalTotal(activity, activityMarkupFor), 0)}
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

      {selectedMaterialBase > 0 && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2 text-sm font-semibold">
              <Percent className="h-4 w-4" />
              Přirážka na materiál
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-muted-foreground">Výchozí přirážka</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={markup}
                onChange={(e) => {
                  setMarkupTouched(true);
                  setMarkup(e.target.value);
                }}
                className="max-w-[120px]"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Materiál (nákupní cena)</span>
                <span>{fmtKc(selectedMaterialBase, 2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Přirážka celkem</span>
                <span className={markupAmount > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}>
                  {markupAmount > 0 ? "+ " : ""}
                  {fmtKc(markupAmount, 2)}
                </span>
              </div>
              <div className="flex justify-between font-semibold pt-1 border-t">
                <span>Materiál k fakturaci</span>
                <span>{fmtKc(selectedMaterialBase + markupAmount, 2)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Výchozí přirážka platí pro materiál bez vlastní přirážky nebo
              přirážky podle kategorie. Přirážku lze upravit u každé položky výše
              (<span className="font-medium">vlastní</span> →{" "}
              <span className="font-medium">kategorie</span> →{" "}
              <span className="font-medium">výchozí</span>). Přičte se pouze
              k materiálu – práce, doprava ani pokuty se nemění.
            </p>
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
              (chosenJobIds.length === 0 &&
                chosenActivityIds.length === 0 &&
                costLines.length === 0) ||
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
