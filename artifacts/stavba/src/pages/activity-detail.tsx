import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetActivity, getGetActivityQueryKey,
  useUpdateActivity, useDeleteActivity,
  useStartActivityTimer, useStopActivityTimer,
  useListActivityMaterials, getListActivityMaterialsQueryKey,
  useCreateActivityMaterial, useUpdateActivityMaterial, useDeleteActivityMaterial,
  useListCustomers, getGetMyStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Hammer, Clock, Play, Square, Trash2, Plus, Save, Edit3, X,
  ShoppingCart, Archive, ArchiveRestore,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

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

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/activities")}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Zpět
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {can("write") && (
            <>
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
            <Input placeholder="Název" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus required />
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
