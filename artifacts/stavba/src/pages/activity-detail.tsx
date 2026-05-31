import { useState, useEffect, useRef } from "react";
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
  useListCustomers, getGetMyStatsQueryKey,
  useListActivityTimeEntries, getListActivityTimeEntriesQueryKey,
  useCreateActivityTimeEntry, useStartActivityTimeEntry, useStopActivityTimeEntry,
  useUpdateActivityTimeEntry, useDeleteActivityTimeEntry,
  useListPeople, getListPeopleQueryKey,
} from "@workspace/api-client-react";
import { TimeEntriesSection } from "@/components/time-entries-section";
import { useUpload } from "@workspace/object-storage-web";
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
  Receipt, FileImage,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { debugLog } from "@/lib/pwa";

async function prepareImageFile(file: File, maxPx = 1920, quality = 0.82): Promise<File> {
  let processedFile = file;
  if (
    file.type === "image/heic" || file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") || file.name.toLowerCase().endsWith(".heif")
  ) {
    const heic2any = (await import("heic2any")).default;
    const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 }) as Blob;
    processedFile = new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
  }
  // Client-side resize is a best-effort optimisation. On memory-constrained
  // iOS standalone (PWA) webviews the canvas pipeline can fail for large camera
  // photos; in that case fall back to uploading the (already allowed-type)
  // source file rather than failing the whole upload.
  // Types the backend accepts as-is (HEIC/HEIF are already transcoded to JPEG
  // above). If the resize pipeline fails for one of these we can safely upload
  // the source; anything else must be rejected with a clear message rather than
  // sent on to be refused by the server with a 415.
  const FALLBACK_ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(processedFile);
    const fallback = (reason: string) => {
      URL.revokeObjectURL(objectUrl);
      debugLog("upload", `image resize skipped: ${reason}`);
      if (FALLBACK_ALLOWED.has(processedFile.type)) {
        resolve(processedFile);
      } else {
        reject(new Error(`Formát obrázku není podporován (${processedFile.type || "neznámý"}). Použijte JPEG nebo PNG.`));
      }
    };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { fallback("no canvas context"); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { fallback("toBlob returned null"); return; }
          URL.revokeObjectURL(objectUrl);
          const outName = processedFile.name.replace(/\.(heic|heif)$/i, ".jpg");
          resolve(new File([blob], outName, { type: "image/jpeg" }));
        }, "image/jpeg", quality);
      } catch (e) {
        fallback(e instanceof Error ? e.message : "draw failed");
      }
    };
    img.onerror = () => fallback("image decode failed");
    img.src = objectUrl;
  });
}

function getAttachmentUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:")) return url;
  return `/api/storage${url}`;
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
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const detailKey = getGetActivityQueryKey(id);
  const matsKey = getListActivityMaterialsQueryKey(id);

  const { data: activity, isLoading } = useGetActivity(id, { query: { queryKey: detailKey, enabled: Number.isFinite(id) } });
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
    queryClient.invalidateQueries({ queryKey: detailKey });
    queryClient.invalidateQueries({ queryKey: matsKey });
    queryClient.invalidateQueries({ queryKey: ["/activities"] });
    queryClient.invalidateQueries({ queryKey: getGetMyStatsQueryKey() });
  };

  if (isLoading || !activity) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
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
    if (!confirm(`Smazat akci „${activity.name}"? Smažou se i materiály.`)) return;
    deleteActivity.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/activities"] });
        queryClient.invalidateQueries({ queryKey: getGetMyStatsQueryKey() });
        toast({ title: "Akce smazána" });
        setLocation("/activities");
      },
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
  const { data: warehouseItems } = useListWarehouseItems({ query: { queryKey: getListWarehouseItemsQueryKey() } });
  const materialSuggestions = (warehouseItems ?? []).map((w: any) => w.name);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", quantity: "", unit: "", pricePerUnit: "" });

  const total = materials.reduce((sum, m) => sum + (m.quantity ?? 0) * (m.pricePerUnit ?? 0), 0);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    createMaterial.mutate({
      activityId,
      data: {
        name: form.name.trim(),
        quantity: form.quantity ? Number(form.quantity) : null,
        unit: form.unit.trim() || null,
        pricePerUnit: form.pricePerUnit ? Number(form.pricePerUnit) : null,
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
    if (!confirm("Smazat materiál?")) return;
    deleteMaterial.mutate({ activityId, materialId: id }, { onSuccess: onChange });
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
          {canWrite && !showAdd && (
            <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" /> Přidat
            </Button>
          )}
        </div>

        {showAdd && canWrite && (
          <form onSubmit={handleAdd} className="space-y-2 p-3 border rounded-md bg-muted/30">
            <Autocomplete placeholder="Název" value={form.name} onValueChange={(v) => setForm({ ...form, name: v })} suggestions={materialSuggestions} autoFocus required />
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="Množ." type="number" step="0.01" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
              <Input placeholder="Jed." value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
              <Input placeholder="Kč/jed." type="number" step="0.01" value={form.pricePerUnit} onChange={(e) => setForm({ ...form, pricePerUnit: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm">Přidat</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}><X className="h-4 w-4" /></Button>
            </div>
          </form>
        )}

        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">Zatím žádný materiál.</p>
        ) : (
          <ul className="space-y-1">
            {materials.map((m) => {
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
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-500" onClick={() => handleDelete(m.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {
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

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description.trim()) return;
    createWork.mutate({
      activityId,
      data: {
        description: form.description.trim(),
        note: form.note.trim() || null,
        hours: form.hours ? Number(form.hours) : null,
        amount: form.amount ? Number(form.amount) : null,
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
    if (!confirm("Smazat vícepráci?")) return;
    deleteWork.mutate({ activityId, extraWorkId: id }, { onSuccess: invalidate });
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
              <Input placeholder="Hodiny" type="number" step="0.01" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
              <Input placeholder="Cena Kč" type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm">Přidat</Button>
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listKey = getListActivityAttachmentsQueryKey(activityId);
  const { data: attachments } = useListActivityAttachments(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const createAttachment = useCreateActivityAttachment();
  const deleteAttachment = useDeleteActivityAttachment();
  const { uploadFile: uploadDoklad, isUploading, progress } = useUpload();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const doklady = (attachments ?? []).filter((a) => DOKLAD_TYPES.includes(a.type ?? ""));

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const isPhoto =
      file.type.startsWith("image/") ||
      file.name.toLowerCase().endsWith(".heic") ||
      file.name.toLowerCase().endsWith(".heif");
    const type = isPhoto ? "receipt" : "invoice";
    try {
      const toUpload = isPhoto ? await prepareImageFile(file) : file;
      const result = await uploadDoklad(toUpload);
      createAttachment.mutate(
        { activityId, data: { type, fileName: toUpload.name, url: result.objectPath, description: "Doklad" } },
        { onSuccess: () => { invalidate(); toast({ title: "Doklad uložen" }); } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";
      debugLog("upload", "doklad upload failed", err);
      toast({ title: "Nahrání selhalo", description: msg, variant: "destructive" });
    }
  };

  const handleDelete = (id: number) => {
    if (!confirm("Smazat tento doklad?")) return;
    deleteAttachment.mutate({ activityId, attachmentId: id }, { onSuccess: invalidate });
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
              accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png"
              capture="environment"
              ref={fileInputRef}
              onChange={handleUpload}
              className="hidden"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={createAttachment.isPending || isUploading}
              variant="secondary"
              className="w-full h-11"
            >
              <Camera className="h-4 w-4 mr-2" /> {isUploading ? `Nahrávám… ${progress}%` : "Vyfotit / nahrát doklad"}
            </Button>
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
                      <a
                        href={displayUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline shrink-0"
                      >
                        Zobrazit
                      </a>
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
      </CardContent>
    </Card>
  );
}

function PhotosSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listKey = getListActivityAttachmentsQueryKey(activityId);
  const { data: attachments } = useListActivityAttachments(activityId, {
    query: { queryKey: listKey, enabled: Number.isFinite(activityId) },
  });
  const createAttachment = useCreateActivityAttachment();
  const deleteAttachment = useDeleteActivityAttachment();
  const { uploadFile: uploadPhoto, isUploading, progress } = useUpload();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const photos = (attachments ?? []).filter((a) => (a.type ?? "photo") === "photo");

  const handleCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const prepared = await prepareImageFile(file);
      const result = await uploadPhoto(prepared);
      createAttachment.mutate({
        activityId,
        data: { type: "photo", fileName: prepared.name, url: result.objectPath, description: "Foto ze stavby" },
      }, {
        onSuccess: () => {
          invalidate();
          toast({ title: "Fotografie uložena" });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";
      debugLog("upload", "photo upload failed", err);
      toast({ title: "Nahrání fotky selhalo", description: msg, variant: "destructive" });
    }
  };

  const handleDelete = (attachmentId: number) => {
    if (!confirm("Smazat tuto fotografii?")) return;
    deleteAttachment.mutate({ activityId, attachmentId }, { onSuccess: invalidate });
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
            <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleCapture} className="hidden" />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={createAttachment.isPending || isUploading}
              className="w-full"
            >
              <Camera className="h-4 w-4 mr-2" /> {isUploading ? `Nahrávám… ${progress}%` : "Vyfotit / nahrát"}
            </Button>
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
                    <img src={src} alt={photo.fileName || "Fotografie"} className="w-full h-full object-cover" />
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
      </CardContent>
    </Card>
  );
}
