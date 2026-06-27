import { useState, useEffect, useRef } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useParams, useLocation } from "wouter";
import {
  useGetActivity, getGetActivityQueryKey,
  useUpdateActivity, useDeleteActivity,
  useStartActivityTimer, useStopActivityTimer,
  useListActivityMaterials, getListActivityMaterialsQueryKey,
  useCreateActivityMaterial, useUpdateActivityMaterial, useDeleteActivityMaterial,
  useListActivityAttachments, getListActivityAttachmentsQueryKey,
  useCreateActivityAttachment, useDeleteActivityAttachment,
  useListActivityExtraWorks, getListActivityExtraWorksQueryKey,
  useCreateActivityExtraWork, useUpdateActivityExtraWork, useDeleteActivityExtraWork,
  useListWarehouseItems, getListWarehouseItemsQueryKey,
  useGetWarehouseActivityMarginTrend, getGetWarehouseActivityMarginTrendQueryKey,
  useListCustomers, getGetMyStatsQueryKey,
  useListActivityTimeEntries, getListActivityTimeEntriesQueryKey,
  useCreateActivityTimeEntry, useStartActivityTimeEntry, useStopActivityTimeEntry,
  useUpdateActivityTimeEntry, useDeleteActivityTimeEntry,
  useListPeople, getListPeopleQueryKey,
} from "@workspace/api-client-react";
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { TimeEntriesSection } from "@/components/time-entries-section";
import { useUpload } from "@workspace/object-storage-web";
import { UploadProgressBar } from "@/components/upload-progress-bar";
import { AttachmentViewer } from "@/components/attachment-viewer";
import { FileDropZone } from "@/components/file-drop-zone";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Autocomplete } from "@/components/autocomplete";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Hammer, Clock, Play, Square, Trash2, Plus, Save, Edit3, X,
  ShoppingCart, Archive, ArchiveRestore, Camera, PlusCircle, CheckCircle2, RotateCcw, FileText, Download,
  Receipt, FileImage, Banknote, RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { debugLog } from "@/lib/pwa";
import { prepareImageFile } from "@/lib/prepare-image";
import { invalidateData } from "@/lib/query-invalidation";
import { DecimalInput, parseDecimal, decimalError } from "@/components/decimal-input";

function getAttachmentUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:")) return url;
  return `/api/storage${url}`;
}

type TrendPoint = {
  period: string;
  cumulativeSaleValue: number;
  cumulativeCostValue: number;
  cumulativeMarginPct?: number | null;
};

function formatWeek(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
  } catch {
    return iso;
  }
}

function MarginTrendChart({ points }: { points: TrendPoint[] }) {
  const hasNegative = points.some((p) => (p.cumulativeMarginPct ?? 0) < 0);
  const chartData = points.map((p) => ({
    period: formatWeek(p.period),
    marze: p.cumulativeMarginPct,
  }));

  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <p className="text-xs text-muted-foreground mb-2">Vývoj kumulativní marže po týdnech</p>
      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="activityMarginGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={hasNegative ? "rgb(239 68 68)" : "rgb(16 185 129)"} stopOpacity={0.25} />
              <stop offset="95%" stopColor={hasNegative ? "rgb(239 68 68)" : "rgb(16 185 129)"} stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
          <XAxis dataKey="period" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
          <Tooltip
            formatter={(v) => {
              const n = v as number | null | undefined;
              return n != null ? [`${n.toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} %`, "Marže"] : ["—", "Marže"];
            }}
            labelFormatter={(l) => `Týden od ${l}`}
            contentStyle={{ fontSize: 11 }}
          />
          <ReferenceLine y={0} stroke="rgb(239 68 68)" strokeDasharray="4 2" strokeWidth={1} />
          <Area
            type="monotone"
            dataKey="marze"
            stroke={hasNegative ? "rgb(239 68 68)" : "rgb(16 185 129)"}
            strokeWidth={2}
            fill="url(#activityMarginGrad)"
            dot={{ r: 3, fill: hasNegative ? "rgb(239 68 68)" : "rgb(16 185 129)", strokeWidth: 0 }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

async function downloadAttachment(src: string, fileName: string) {
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation: revoking immediately can cancel the download in some
    // WebKit/Safari builds (relevant for iOS users).
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    window.open(src, "_blank");
  }
}

function useTimer(startedAt: string | null | undefined) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

function fmtElapsed(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function fmtH(n: number | null | undefined) {
  if (n == null) return "0 h";
  return `${Math.round(Number(n) * 100) / 100} h`;
}

export default function ActivityDetail() {
  const { openConfirm: openConfirmActivity, dialogProps: dialogPropsActivity } = useConfirmDialog();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const detailKey = getGetActivityQueryKey(id);
  const matsKey = getListActivityMaterialsQueryKey(id);

  const { data: activity, isLoading, isRefetching, isError: activityError, refetch } = useGetActivity(id, { query: { queryKey: detailKey, enabled: Number.isFinite(id) } });
  const { data: materials } = useListActivityMaterials(id, { query: { queryKey: matsKey, enabled: Number.isFinite(id) } });
  const { data: customers } = useListCustomers();

  const updateActivity = useUpdateActivity();
  const deleteActivity = useDeleteActivity();
  const startTimer = useStartActivityTimer();
  const stopTimer = useStopActivityTimer();
  const createMaterial = useCreateActivityMaterial();
  const updateMaterial = useUpdateActivityMaterial();
  const deleteMaterial = useDeleteActivityMaterial();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", customerId: "" as string });
  const initialized = useRef(false);

  useEffect(() => {
    if (activity && !initialized.current) {
      setForm({
        name: activity.name,
        description: activity.description ?? "",
        customerId: activity.customerId ? String(activity.customerId) : "",
      });
      initialized.current = true;
    }
  }, [activity]);

  const elapsed = useTimer(activity?.timerStartedAt);

  const invalidate = () => {
    invalidateData(queryClient, "activities", "warehouse");
  };

  if (isLoading || isRefetching) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (activityError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground gap-3">
        <Hammer className="h-12 w-12 opacity-20" />
        <p className="font-medium">Nepodařilo se načíst aktivitu</p>
        <p className="text-sm">Zkontrolujte připojení a zkuste to znovu.</p>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" /> Zkusit znovu
        </Button>
        <Button variant="ghost" onClick={() => setLocation("/activities")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na aktivity
        </Button>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground gap-3">
        <Hammer className="h-12 w-12 opacity-20" />
        <p className="font-medium">Aktivita nenalezena</p>
        <Button variant="ghost" onClick={() => setLocation("/activities")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na aktivity
        </Button>
      </div>
    );
  }

  const running = !!activity.timerStartedAt;

  const handleStartStop = () => {
    if (running) {
      stopTimer.mutate({ id }, {
        onSuccess: () => {
          invalidate();
          toast({ title: "Časovač zastaven, čas uložen" });
        },
      });
    } else {
      startTimer.mutate({ id }, {
        onSuccess: () => {
          invalidate();
          toast({ title: "Časovač spuštěn" });
        },
      });
    }
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    updateActivity.mutate(
      {
        id,
        data: {
          name: form.name.trim(),
          description: form.description.trim() || null,
          customerId: form.customerId ? Number(form.customerId) : null,
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
          invalidate();
          toast({ title: "Uloženo" });
        },
      },
    );
  };

  const handleDelete = () => {
    openConfirmActivity({ title: `Smazat akci „${activity.name}"?`, description: "Smažou se i materiály." }, () => {
      deleteActivity.mutate({ id }, {
        onSuccess: () => {
          invalidateData(queryClient, "activities", "warehouse");
          toast({ title: "Akce smazána" });
          setLocation("/activities");
        },
      });
    });
  };

  const handleToggleArchive = () => {
    updateActivity.mutate(
      { id, data: { isArchived: !activity.isArchived } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: activity.isArchived ? "Obnoveno" : "Archivováno" });
        },
      },
    );
  };

  const completed = !!activity.completedAt;

  const finishComplete = () => {
    updateActivity.mutate(
      { id, data: { completedAt: new Date().toISOString() } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Akce dokončena" });
        },
      },
    );
  };

  const handleToggleComplete = () => {
    if (completed) {
      updateActivity.mutate(
        { id, data: { completedAt: null } },
        {
          onSuccess: () => {
            invalidate();
            toast({ title: "Akce znovu otevřena" });
          },
        },
      );
      return;
    }
    if (running) {
      stopTimer.mutate({ id }, { onSuccess: () => { invalidate(); finishComplete(); } });
    } else {
      finishComplete();
    }
  };

  const handleBillingStatus = (value: "" | "billable" | "not_billable") => {
    updateActivity.mutate(
      { id, data: { billingStatus: value || null } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Fakturační stav uložen" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      },
    );
  };

  const billingStatusLabel: Record<string, string> = {
    billable: "K fakturaci",
    billed: "Vyfakturováno",
    not_billable: "Nefakturovat",
  };

  // The real billed state comes from the invoice link, not the cosmetic
  // billingStatus. A legacy/cosmetic "billed" value is treated as unset for the
  // editable intent control so the dropdown can't contradict the invoice link.
  const trulyBilled = activity.billedInvoiceId != null;
  const intentStatus = activity.billingStatus === "billed" ? "" : (activity.billingStatus ?? "");

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/activities")}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Zpět
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {can("write") && (
            <>
              <Button
                variant={completed ? "outline" : "default"}
                size="sm"
                onClick={handleToggleComplete}
                className={completed ? "" : "bg-emerald-500 hover:bg-emerald-600"}
                disabled={updateActivity.isPending || stopTimer.isPending}
              >
                {completed ? <><RotateCcw className="h-4 w-4 mr-1.5" /> Znovu otevřít</> : <><CheckCircle2 className="h-4 w-4 mr-1.5" /> Dokončit</>}
              </Button>
              <Button variant="ghost" size="icon" onClick={handleToggleArchive} title={activity.isArchived ? "Obnovit" : "Archivovat"}>
                {activity.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="text-rose-500" onClick={handleDelete}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {completed && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          Dokončeno {new Date(activity.completedAt!).toLocaleDateString("cs-CZ")}
        </div>
      )}

      {/* Stav akce panel */}
      <Card>
        <CardContent className="p-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Stav akce</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> Čas celkem
              </div>
              <div className="font-semibold text-base">{fmtH(activity.hoursSpent)}</div>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Hammer className="h-3.5 w-3.5" /> Materiál
              </div>
              <div className="font-semibold text-base">
                {activity.materialsTotalCost > 0
                  ? `${Math.round(activity.materialsTotalCost).toLocaleString("cs-CZ")} Kč`
                  : "—"}
              </div>
            </div>
            {(activity.extraWorksTotalAmount > 0 || activity.extraWorksTotalHours > 0) && (
              <div className="rounded-lg bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <PlusCircle className="h-3.5 w-3.5" /> Vícepráce
                </div>
                <div className="font-semibold text-base text-sm space-y-0.5">
                  {activity.extraWorksTotalHours > 0 && (
                    <div>{Math.round(activity.extraWorksTotalHours * 100) / 100} h</div>
                  )}
                  {activity.extraWorksTotalAmount > 0 && (
                    <div>{Math.round(activity.extraWorksTotalAmount).toLocaleString("cs-CZ")} Kč</div>
                  )}
                </div>
              </div>
            )}
            {activity.attachmentsCount > 0 && (
              <div className="rounded-lg bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Receipt className="h-3.5 w-3.5" /> Doklady
                </div>
                <div className="font-semibold text-base">{activity.attachmentsCount}</div>
              </div>
            )}
            {activity.photosCount > 0 && (
              <div className="rounded-lg bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Camera className="h-3.5 w-3.5" /> Fotky
                </div>
                <div className="font-semibold text-base">{activity.photosCount}</div>
              </div>
            )}
          </div>

          {/* Billing status. The real billed state is driven by the invoice
              link (billedInvoiceId); the manual dropdown only carries the
              editable intent flags (billable / not_billable). "Vyfakturováno"
              is no longer a manual choice, so the cosmetic status can never
              contradict the authoritative invoice link. */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
              <Banknote className="h-4 w-4" /> Fakturace:
            </div>
            {trulyBilled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 px-2 py-0.5 text-xs font-medium shrink-0">
                <Receipt className="h-3.5 w-3.5" /> Vyfakturováno
              </span>
            ) : can("write") ? (
              <>
                <select
                  className="flex-1 h-9 rounded-md border bg-background px-3 text-sm"
                  value={intentStatus}
                  onChange={(e) => handleBillingStatus(e.target.value as "" | "billable" | "not_billable")}
                  disabled={updateActivity.isPending}
                >
                  <option value="">— Nenastaveno —</option>
                  <option value="billable">K fakturaci</option>
                  <option value="not_billable">Nefakturovat</option>
                </select>
                {intentStatus === "billable" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 text-xs font-medium shrink-0">
                    K fakturaci
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm font-medium">
                {intentStatus ? billingStatusLabel[intentStatus] ?? intentStatus : "Nenastaveno"}
              </span>
            )}
          </div>

          {/* Actual invoice link (admin-only): billed = linked to a non-cancelled
              invoice via invoice_source_links, independent of the cosmetic billingStatus. */}
          {can("manageUsers") && activity.billedInvoiceId != null && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
                <Receipt className="h-4 w-4" /> Faktura:
              </div>
              <button
                type="button"
                onClick={() => setLocation(`/billing/invoices/${activity.billedInvoiceId}`)}
                className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 px-2 py-0.5 text-xs font-medium hover:underline shrink-0"
              >
                Vyfakturováno
                {activity.billedInvoiceNumber
                  ? ` · ${activity.billedInvoiceNumber}`
                  : activity.billedInvoiceStatus === "draft"
                    ? " · koncept"
                    : ""}
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          {editing ? (
            <>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Název akce" />
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} placeholder="Popis" />
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
              >
                <option value="">— Bez zákazníka —</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <Button onClick={handleSave}><Save className="h-4 w-4 mr-1" /> Uložit</Button>
                <Button variant="ghost" onClick={() => { setEditing(false); initialized.current = false; }}>
                  <X className="h-4 w-4 mr-1" /> Zrušit
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-xl font-bold flex items-center gap-2">
                  <Hammer className="h-5 w-5 text-orange-500" /> {activity.name}
                </h1>
                {can("write") && (
                  <Button variant="ghost" size="icon" onClick={() => setEditing(true)}>
                    <Edit3 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {activity.customerName && (
                <p className="text-sm text-muted-foreground">{activity.customerName}</p>
              )}
              {activity.description && (
                <p className="text-sm whitespace-pre-wrap">{activity.description}</p>
              )}
              {activity.createdByUserName && (
                <p className="text-xs text-muted-foreground">Založil: {activity.createdByUserName}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Button
        variant="outline"
        onClick={() => setLocation(`/activities/${id}/export`)}
        className="w-full h-11 border-primary/40 text-primary hover:bg-primary/5"
      >
        <FileText className="h-4 w-4 mr-2" /> Podklad k fakturaci (PDF)
      </Button>

      {/* Timer */}
      <Card className={running ? "border-emerald-500 border-2" : ""}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Odpracovaný čas</div>
              <div className="text-2xl font-bold mt-1 flex items-center gap-2">
                <Clock className="h-5 w-5 text-muted-foreground" /> {fmtH(activity.hoursSpent)}
              </div>
              {running && (
                <div className="text-sm text-emerald-600 dark:text-emerald-400 mt-1 font-mono">
                  Běží: {fmtElapsed(elapsed)}
                </div>
              )}
            </div>
            {can("write") && (
              <Button
                size="lg"
                onClick={handleStartStop}
                className={running ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-500 hover:bg-emerald-600"}
                disabled={startTimer.isPending || stopTimer.isPending}
              >
                {running ? <><Square className="h-5 w-5 mr-2 fill-white" /> Zastavit</> : <><Play className="h-5 w-5 mr-2 fill-white" /> Spustit</>}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Materials */}
      <MaterialsSection
        activityId={id}
        materials={materials ?? []}
        canWrite={can("write")}
        createMaterial={createMaterial}
        updateMaterial={updateMaterial}
        deleteMaterial={deleteMaterial}
        onChange={invalidate}
      />

      {/* Per-employee time tracking */}
      <ActivityTimeEntries activityId={id} canWrite={can("write")} onChange={invalidate} />

      {/* Extra works (vícepráce) */}
      <ExtraWorksSection activityId={id} canWrite={can("write")} />

      {/* Doklady (faktury, účtenky, dodací listy) */}
      <ActivityDokladySection activityId={id} canWrite={can("write")} />

      {/* Photos */}
      <PhotosSection activityId={id} canWrite={can("write")} />
      <ConfirmDialog {...dialogPropsActivity} />
    </div>
  );
}

type Material = {
  id: number;
  activityId: number;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  pricePerUnit?: number | null;
  done: boolean;
  sortOrder: number;
  createdAt: string;
};

function MaterialsSection({
  activityId, materials, canWrite,
  createMaterial, updateMaterial, deleteMaterial, onChange,
}: {
  activityId: number;
  materials: Material[];
  canWrite: boolean;
  createMaterial: ReturnType<typeof useCreateActivityMaterial>;
  updateMaterial: ReturnType<typeof useUpdateActivityMaterial>;
  deleteMaterial: ReturnType<typeof useDeleteActivityMaterial>;
  onChange: () => void;
}) {
  const { toast } = useToast();
  const { data: warehouseItems } = useListWarehouseItems(undefined, { query: { queryKey: getListWarehouseItemsQueryKey() } });
  const { data: marginTrend } = useGetWarehouseActivityMarginTrend(
    { activityId },
    { query: { queryKey: getGetWarehouseActivityMarginTrendQueryKey({ activityId }) } },
  );
  const materialSuggestions = (warehouseItems ?? []).map((w: any) => w.name);
  const { openConfirm, dialogProps: dialogPropsMat } = useConfirmDialog();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", quantity: "", unit: "", pricePerUnit: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", quantity: "", unit: "", pricePerUnit: "" });

  const total = materials.reduce((sum, m) => sum + (m.quantity ?? 0) * (m.pricePerUnit ?? 0), 0);

  const matQtyError = decimalError(form.quantity);
  const matPriceError = decimalError(form.pricePerUnit);
  const matAddHasErrors = !!(matQtyError || matPriceError);

  const editQtyError = decimalError(editForm.quantity);
  const editPriceError = decimalError(editForm.pricePerUnit);
  const editHasErrors = !!(editQtyError || editPriceError);

  const startEdit = (m: Material) => {
    setEditingId(m.id);
    setEditForm({
      name: m.name,
      quantity: m.quantity != null ? String(m.quantity) : "",
      unit: m.unit ?? "",
      pricePerUnit: m.pricePerUnit != null ? String(m.pricePerUnit) : "",
    });
    setShowAdd(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ name: "", quantity: "", unit: "", pricePerUnit: "" });
  };

  const handleSaveEdit = (e: React.FormEvent, materialId: number) => {
    e.preventDefault();
    if (!editForm.name.trim() || editHasErrors) return;
    updateMaterial.mutate({
      activityId,
      materialId,
      data: {
        name: editForm.name.trim(),
        quantity: parseDecimal(editForm.quantity),
        unit: editForm.unit.trim() || null,
        pricePerUnit: parseDecimal(editForm.pricePerUnit),
      },
    }, {
      onSuccess: () => {
        cancelEdit();
        onChange();
        toast({ title: "Materiál upraven" });
      },
    });
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || matAddHasErrors) return;
    createMaterial.mutate({
      activityId,
      data: {
        name: form.name.trim(),
        quantity: parseDecimal(form.quantity),
        unit: form.unit.trim() || null,
        pricePerUnit: parseDecimal(form.pricePerUnit),
      },
    }, {
      onSuccess: () => {
        setForm({ name: "", quantity: "", unit: "", pricePerUnit: "" });
        setShowAdd(false);
        onChange();
        toast({ title: "Materiál přidán" });
      },
    });
  };

  const toggleDone = (m: Material) => {
    updateMaterial.mutate({ activityId, materialId: m.id, data: { done: !m.done } }, { onSuccess: onChange });
  };

  const handleDelete = (id: number) => {
    openConfirm("Smazat materiál?", () => {
      deleteMaterial.mutate({ activityId, materialId: id }, { onSuccess: onChange });
    });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-amber-500" /> Materiál
            {total > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                · {Math.round(total).toLocaleString("cs-CZ")} Kč
              </span>
            )}
          </h2>
          {canWrite && !showAdd && editingId === null && (
            <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" /> Přidat
            </Button>
          )}
        </div>

        {showAdd && canWrite && (
          <form onSubmit={handleAdd} className="space-y-2 p-3 border rounded-md bg-muted/30">
            <Autocomplete placeholder="Název" value={form.name} onValueChange={(v) => setForm({ ...form, name: v })} suggestions={materialSuggestions} autoFocus required />
            <div className="grid grid-cols-3 gap-2">
              <DecimalInput placeholder="Množ." value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} error={matQtyError} />
              <Input placeholder="Jed." value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
              <DecimalInput placeholder="Kč/jed." value={form.pricePerUnit} onChange={(v) => setForm({ ...form, pricePerUnit: v })} error={matPriceError} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={matAddHasErrors}>Přidat</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}><X className="h-4 w-4" /></Button>
            </div>
          </form>
        )}

        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">Zatím žádný materiál.</p>
        ) : (
          <ul className="space-y-1">
            {materials.map((m) => {
              if (editingId === m.id && canWrite) {
                return (
                  <li key={m.id} className="py-2 border-b last:border-0">
                    <form onSubmit={(e) => handleSaveEdit(e, m.id)} className="space-y-2 p-2 border rounded-md bg-muted/30">
                      <Autocomplete placeholder="Název" value={editForm.name} onValueChange={(v) => setEditForm({ ...editForm, name: v })} suggestions={materialSuggestions} autoFocus required />
                      <div className="grid grid-cols-3 gap-2">
                        <DecimalInput placeholder="Množ." value={editForm.quantity} onChange={(v) => setEditForm({ ...editForm, quantity: v })} error={editQtyError} />
                        <Input placeholder="Jed." value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} />
                        <DecimalInput placeholder="Kč/jed." value={editForm.pricePerUnit} onChange={(v) => setEditForm({ ...editForm, pricePerUnit: v })} error={editPriceError} />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={editHasErrors || !editForm.name.trim()}>Uložit</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}><X className="h-4 w-4" /></Button>
                      </div>
                    </form>
                  </li>
                );
              }
              const lineTotal = (m.quantity ?? 0) * (m.pricePerUnit ?? 0);
              return (
                <li key={m.id} className="flex items-center gap-2 py-2 border-b last:border-0">
                  <Checkbox checked={m.done} onCheckedChange={() => canWrite && toggleDone(m)} disabled={!canWrite} />
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium text-sm ${m.done ? "line-through text-muted-foreground" : ""}`}>
                      {m.name}
                    </div>
                    {(m.quantity != null || m.pricePerUnit != null) && (
                      <div className="text-xs text-muted-foreground">
                        {m.quantity ?? "—"} {m.unit ?? ""} {m.pricePerUnit != null && `× ${m.pricePerUnit} Kč`}
                        {lineTotal > 0 && ` = ${Math.round(lineTotal).toLocaleString("cs-CZ")} Kč`}
                      </div>
                    )}
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => startEdit(m)}>
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-500" onClick={() => handleDelete(m.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {marginTrend && marginTrend.points.length >= 3 && (
          <MarginTrendChart points={marginTrend.points} />
        )}
      </CardContent>
      <ConfirmDialog {...dialogPropsMat} />
    </Card>
  );
}

function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {
  const { openConfirm, dialogProps: dialogPropsWork } = useConfirmDialog();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const listKey = getListActivityExtraWorksQueryKey(activityId);
  const { data: works } = useListActivityExtraWorks(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const createWork = useCreateActivityExtraWork();
  const updateWork = useUpdateActivityExtraWork();
  const deleteWork = useDeleteActivityExtraWork();

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ description: "", note: "", hours: "", amount: "" });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const items = works ?? [];
  const totalAmount = items.reduce((sum, w) => sum + (w.amount ?? 0), 0);
  const totalHours = items.reduce((sum, w) => sum + (w.hours ?? 0), 0);

  const workHoursError = decimalError(form.hours);
  const workAmountError = decimalError(form.amount);
  const workAddHasErrors = !!(workHoursError || workAmountError);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description.trim() || workAddHasErrors) return;
    createWork.mutate({
      activityId,
      data: {
        description: form.description.trim(),
        note: form.note.trim() || null,
        hours: parseDecimal(form.hours),
        amount: parseDecimal(form.amount),
      },
    }, {
      onSuccess: () => {
        setForm({ description: "", note: "", hours: "", amount: "" });
        setShowAdd(false);
        invalidate();
        toast({ title: "Vícepráce přidána" });
      },
    });
  };

  const toggleDone = (w: ExtraWork) => {
    updateWork.mutate({ activityId, extraWorkId: w.id, data: { done: !w.done } }, { onSuccess: invalidate });
  };

  const handleDelete = (id: number) => {
    openConfirm("Smazat vícepráci?", () => {
      deleteWork.mutate({ activityId, extraWorkId: id }, { onSuccess: invalidate });
    });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <PlusCircle className="h-4 w-4 text-sky-500" /> Vícepráce
            {(totalAmount > 0 || totalHours > 0) && (
              <span className="text-sm font-normal text-muted-foreground">
                · {totalHours > 0 && `${Math.round(totalHours * 100) / 100} h`}
                {totalHours > 0 && totalAmount > 0 && " · "}
                {totalAmount > 0 && `${Math.round(totalAmount).toLocaleString("cs-CZ")} Kč`}
              </span>
            )}
          </h2>
          {canWrite && !showAdd && (
            <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" /> Přidat
            </Button>
          )}
        </div>

        {showAdd && canWrite && (
          <form onSubmit={handleAdd} className="space-y-2 p-3 border rounded-md bg-muted/30">
            <Input placeholder="Co se dělalo navíc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} autoFocus required />
            <Textarea placeholder="Poznámka (volitelné)" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <DecimalInput placeholder="Hodiny" value={form.hours} onChange={(v) => setForm({ ...form, hours: v })} error={workHoursError} />
              <DecimalInput placeholder="Cena Kč" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} error={workAmountError} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={workAddHasErrors}>Přidat</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}><X className="h-4 w-4" /></Button>
            </div>
          </form>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">Zatím žádné vícepráce.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((w) => (
              <li key={w.id} className="flex items-start gap-2 py-2 border-b last:border-0">
                <Checkbox className="mt-0.5" checked={w.done} onCheckedChange={() => canWrite && toggleDone(w)} disabled={!canWrite} />
                <div className="flex-1 min-w-0">
                  <div className={`font-medium text-sm ${w.done ? "line-through text-muted-foreground" : ""}`}>
                    {w.description}
                  </div>
                  {w.note && <div className="text-xs text-muted-foreground whitespace-pre-wrap">{w.note}</div>}
                  {(w.hours != null || w.amount != null) && (
                    <div className="text-xs text-muted-foreground">
                      {w.hours != null && `${w.hours} h`}
                      {w.hours != null && w.amount != null && " · "}
                      {w.amount != null && `${Math.round(w.amount).toLocaleString("cs-CZ")} Kč`}
                    </div>
                  )}
                </div>
                {canWrite && (
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-500" onClick={() => handleDelete(w.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog {...dialogPropsWork} />
    </Card>
  );
}

type ExtraWork = {
  id: number;
  activityId: number;
  description: string;
  note?: string | null;
  hours?: number | null;
  amount?: number | null;
  done: boolean;
  sortOrder: number;
  createdAt: string;
};

function ActivityTimeEntries({ activityId, canWrite, onChange }: { activityId: number; canWrite: boolean; onChange: () => void }) {
  const queryClient = useQueryClient();
  const listKey = getListActivityTimeEntriesQueryKey(activityId);
  const { data: entries } = useListActivityTimeEntries(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const addPerson = useCreateActivityTimeEntry();
  const startTimer = useStartActivityTimeEntry();
  const stopTimer = useStopActivityTimeEntry();
  const setHours = useUpdateActivityTimeEntry();
  const removeEntry = useDeleteActivityTimeEntry();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: listKey });
    onChange();
  };

  const busy = addPerson.isPending || startTimer.isPending || stopTimer.isPending || setHours.isPending || removeEntry.isPending;

  return (
    <TimeEntriesSection
      entries={entries ?? []}
      people={people ?? []}
      canWrite={canWrite}
      busy={busy}
      onAddPerson={(personId) => addPerson.mutate({ activityId, data: { personId } }, { onSuccess: invalidate })}
      onStart={(personId) => startTimer.mutate({ activityId, personId }, { onSuccess: invalidate })}
      onStop={(personId) => stopTimer.mutate({ activityId, personId }, { onSuccess: invalidate })}
      onSetHours={(personId, hours) => setHours.mutate({ activityId, personId, data: { hours } }, { onSuccess: invalidate })}
      onRemove={(personId) => removeEntry.mutate({ activityId, personId }, { onSuccess: invalidate })}
    />
  );
}

const DOKLAD_TYPES = ["invoice", "receipt", "delivery_note"];

function dokladTypeLabel(t: string | null | undefined): string {
  return t === "invoice" ? "Faktura" : t === "receipt" ? "Účtenka" : "Dodací list";
}

function ActivityDokladySection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {
  const { openConfirm, dialogProps: dialogPropsDoklad } = useConfirmDialog();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const listKey = getListActivityAttachmentsQueryKey(activityId);
  const { data: attachments } = useListActivityAttachments(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const createAttachment = useCreateActivityAttachment();
  const deleteAttachment = useDeleteActivityAttachment();
  const {
    uploadFile: uploadDoklad,
    uploadFiles: uploadDoklady,
    isBusy: isUploading,
    displayProgress: progress,
    statusLabel,
  } = useUpload();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const doklady = (attachments ?? []).filter((a) => DOKLAD_TYPES.includes(a.type ?? ""));
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);

  const uploadDokladyFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const { succeeded, failed, errors } = await uploadDoklady(files, async (file) => {
      const isPhoto =
        file.type.startsWith("image/") ||
        file.name.toLowerCase().endsWith(".heic") ||
        file.name.toLowerCase().endsWith(".heif");
      const type = isPhoto ? "receipt" : "invoice";
      const toUpload = isPhoto ? await prepareImageFile(file) : file;
      const result = await uploadDoklad(toUpload);
      await createAttachment.mutateAsync(
        { activityId, data: { type, fileName: toUpload.name, url: result.objectPath, description: "Doklad" } },
      );
    });

    invalidate();
    if (succeeded > 0) {
      toast({ title: succeeded === 1 ? "Doklad uložen" : `Nahráno ${succeeded} dokladů` });
    }
    if (failed > 0) {
      debugLog("upload", "doklad upload failed", errors);
      const description = files.length === 1
        ? (errors[0]?.message ?? "Neznámá chyba")
        : `${failed} z ${files.length} se nepodařilo nahrát`;
      toast({ title: "Nahrání selhalo", description, variant: "destructive" });
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadDokladyFiles(files);
  };

  const handleDelete = (id: number) => {
    openConfirm("Smazat tento doklad?", () => {
      deleteAttachment.mutate({ activityId, attachmentId: id }, { onSuccess: invalidate });
    });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Receipt className="h-4 w-4 text-emerald-500" /> Doklady
          {doklady.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">· {doklady.length}</span>
          )}
        </h2>

        {canWrite && (
          <>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={cameraInputRef}
              onChange={handleUpload}
              className="hidden"
            />
            <input
              type="file"
              accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png"
              multiple
              ref={fileInputRef}
              onChange={handleUpload}
              className="hidden"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => cameraInputRef.current?.click()}
                disabled={createAttachment.isPending || isUploading}
                className="flex-1 h-11"
              >
                <Camera className="h-4 w-4 mr-2" /> {isUploading ? statusLabel : "Vyfotit"}
              </Button>
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={createAttachment.isPending || isUploading}
                variant="outline"
                className="flex-1 h-11"
              >
                <FileImage className="h-4 w-4 mr-2" /> Nahrát doklad
              </Button>
            </div>
            <FileDropZone
              onFiles={uploadDokladyFiles}
              accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png"
              disabled={createAttachment.isPending || isUploading}
              label="Sem přetáhněte doklady (PDF nebo foto)"
            />
            <UploadProgressBar isUploading={isUploading} progress={progress} />
          </>
        )}

        {doklady.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Receipt className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Přidejte faktury, účtenky nebo dodací listy.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {doklady.map((doc) => {
              const displayUrl = getAttachmentUrl(doc.url);
              return (
                <div key={doc.id} className="flex items-center gap-3 p-3 bg-muted/40 border rounded-lg">
                  <div className="p-1.5 bg-amber-100 dark:bg-amber-900/30 rounded text-amber-600 dark:text-amber-400 shrink-0">
                    <FileImage className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.fileName || "Doklad"}</p>
                    <p className="text-xs text-muted-foreground">{dokladTypeLabel(doc.type)}</p>
                  </div>
                  {displayUrl && (
                    <>
                      <button
                        onClick={() => setViewer({ url: displayUrl, fileName: doc.fileName })}
                        className="text-xs text-primary hover:underline shrink-0"
                      >
                        Zobrazit
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground shrink-0"
                        onClick={() => downloadAttachment(displayUrl, doc.fileName || `doklad-${doc.id}`)}
                        title="Stáhnout doklad"
                        aria-label="Stáhnout doklad"
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-rose-500 shrink-0"
                      onClick={() => handleDelete(doc.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {viewer && <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />}
      </CardContent>
      <ConfirmDialog {...dialogPropsDoklad} />
    </Card>
  );
}

function PhotosSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {
  const { openConfirm, dialogProps: dialogPropsPhoto } = useConfirmDialog();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listKey = getListActivityAttachmentsQueryKey(activityId);
  const { data: attachments } = useListActivityAttachments(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const createAttachment = useCreateActivityAttachment();
  const deleteAttachment = useDeleteActivityAttachment();
  const {
    uploadFile: uploadPhoto,
    uploadFiles: uploadPhotos,
    isBusy: isUploading,
    displayProgress: progress,
    statusLabel,
  } = useUpload();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const photos = (attachments ?? []).filter((a) => (a.type ?? "photo") === "photo");
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);

  const uploadPhotoFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const { succeeded, failed, errors } = await uploadPhotos(files, async (file) => {
      const prepared = await prepareImageFile(file);
      const result = await uploadPhoto(prepared);
      await createAttachment.mutateAsync({
        activityId,
        data: { type: "photo", fileName: prepared.name, url: result.objectPath, description: "Foto ze stavby" },
      });
    });

    invalidate();
    if (succeeded > 0) {
      toast({ title: succeeded === 1 ? "Fotografie uložena" : `Nahráno ${succeeded} fotek` });
    }
    if (failed > 0) {
      debugLog("upload", "photo upload failed", errors);
      const description = files.length === 1
        ? (errors[0]?.message ?? "Neznámá chyba")
        : `${failed} z ${files.length} se nepodařilo nahrát`;
      toast({ title: "Nahrání fotky selhalo", description, variant: "destructive" });
    }
  };

  const handleCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadPhotoFiles(files);
  };

  const handleDelete = (attachmentId: number) => {
    openConfirm("Smazat tuto fotografii?", () => {
      deleteAttachment.mutate({ activityId, attachmentId }, { onSuccess: invalidate });
    });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <Camera className="h-4 w-4 text-violet-500" /> Fotky ze stavby
            {photos.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">· {photos.length}</span>
            )}
          </h2>
        </div>

        {canWrite && (
          <>
            <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} onChange={handleCapture} className="hidden" />
            <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleCapture} className="hidden" />
            <div className="flex gap-2">
              <Button
                onClick={() => cameraInputRef.current?.click()}
                disabled={createAttachment.isPending || isUploading}
                className="flex-1"
              >
                <Camera className="h-4 w-4 mr-2" /> {isUploading ? statusLabel : "Vyfotit"}
              </Button>
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={createAttachment.isPending || isUploading}
                className="flex-1"
              >
                <FileImage className="h-4 w-4 mr-2" /> Z galerie
              </Button>
            </div>
            <FileDropZone
              onFiles={uploadPhotoFiles}
              accept="image/*"
              disabled={createAttachment.isPending || isUploading}
              label="Sem přetáhněte fotky"
            />
            <UploadProgressBar isUploading={isUploading} progress={progress} />
          </>
        )}

        {photos.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Camera className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Foťte průběh prací, stav stavby apod.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {photos.map((photo) => {
              const src = getAttachmentUrl(photo.url);
              return (
                <div key={photo.id} className="relative aspect-square rounded-xl overflow-hidden border group bg-muted">
                  {src ? (
                    <button type="button" onClick={() => setViewer({ url: src, fileName: photo.fileName })} className="w-full h-full">
                      <img src={src} alt={photo.fileName || "Fotografie"} className="w-full h-full object-cover" />
                    </button>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                      <Camera className="w-8 h-8 opacity-20" />
                    </div>
                  )}
                  {src && (
                    <button
                      onClick={() => downloadAttachment(src, photo.fileName || `foto-${photo.id}.jpg`)}
                      className="absolute top-2 left-2 p-1.5 bg-background/80 backdrop-blur-sm rounded-full text-foreground shadow-sm"
                      title="Stáhnout fotografii"
                      aria-label="Stáhnout fotografii"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  )}
                  {canWrite && (
                    <button
                      onClick={() => handleDelete(photo.id)}
                      className="absolute top-2 right-2 p-1.5 bg-background/80 backdrop-blur-sm rounded-full text-rose-500 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {viewer && <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />}
      </CardContent>
    </Card>
  );
}
