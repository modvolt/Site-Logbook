import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ClipboardCheck, CloudOff, Loader2, MinusCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useOfflineQueue } from "@/hooks/use-offline-queue";
import { useToast } from "@/hooks/use-toast";
import {
  switchboardFetch, type SwitchboardChecklist as ChecklistPayload,
  type SwitchboardChecklistItem, type SwitchboardChecklistResponse,
} from "@/lib/switchboards-api";

type ResponseInput = {
  expectedRevision: number;
  result: "done" | "defect" | "not_applicable";
  value: string | null;
  unit: string | null;
  passed: boolean | null;
  note: string | null;
  justification: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  not_started: "Nezahájeno",
  in_progress: "Rozpracováno",
  completed: "Dokončeno",
};

function pendingPayload(current: ChecklistPayload, itemKey: string, input: ResponseInput, user: { id: number; name: string } | null): ChecklistPayload {
  return {
    ...current,
    phases: current.phases.map((phase) => {
      const items = phase.items.map((item) => item.key !== itemKey ? item : {
        ...item,
        response: {
          id: item.response?.id ?? -1,
          phaseKey: phase.key,
          itemKey,
          ...input,
          revision: item.response?.revision ?? 0,
          performedByUserId: user?.id ?? null,
          performedByName: user?.name ?? null,
          performedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pending: true,
        },
      });
      const answered = items.filter((item) => item.response?.result).length;
      const defects = items.filter((item) => item.response?.result === "defect").length;
      const criticalDefects = items.filter((item) => item.critical && item.response?.result === "defect").length;
      return { ...phase, items, summary: { ...phase.summary, completed: answered, defects, criticalDefects, status: "in_progress", lastWorker: user?.name ?? phase.summary.lastWorker, lastChangedAt: new Date().toISOString() } };
    }),
  };
}

function ChecklistItemRow({ item, saving, canFill, onSave }: {
  item: SwitchboardChecklistItem;
  saving: boolean;
  canFill: boolean;
  onSave: (item: SwitchboardChecklistItem, input: Omit<ResponseInput, "expectedRevision">) => void;
}) {
  const response = item.response;
  const [selected, setSelected] = useState<ResponseInput["result"]>(response?.result ?? "done");
  const [value, setValue] = useState(response?.value ?? "");
  const [unit, setUnit] = useState(response?.unit ?? "");
  const [passed, setPassed] = useState(response?.passed ?? true);
  const [note, setNote] = useState(response?.note ?? "");
  const [justification, setJustification] = useState(response?.justification ?? "");
  useEffect(() => {
    setSelected(response?.result ?? "done"); setValue(response?.value ?? ""); setUnit(response?.unit ?? "");
    setPassed(response?.passed ?? true); setNote(response?.note ?? ""); setJustification(response?.justification ?? "");
  }, [response?.revision, response?.pending, response?.result, response?.value, response?.unit, response?.passed, response?.note, response?.justification]);
  const submit = (result = selected) => onSave(item, { result, value: value || null, unit: unit || null, passed: item.kind === "measurement" ? passed : null, note: note || null, justification: justification || null });
  const choose = (result: ResponseInput["result"]) => {
    setSelected(result);
    if (result === "done" && item.kind !== "measurement") submit("done");
  };
  const resultTone = response?.result === "done" ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/10" : response?.result === "defect" ? "border-red-300 bg-red-50/50 dark:bg-red-950/10" : response?.result === "not_applicable" ? "border-neutral-300 bg-neutral-50 dark:bg-neutral-900/30" : "border-border";
  return (
    <div className={`border-l-4 px-3 py-4 ${resultTone}`}>
      <div className="flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm leading-5">{item.title}</div>
          <div className="flex gap-2 mt-1 text-xs text-muted-foreground">
            {item.critical && <span className="text-red-600 font-medium">Kritická</span>}
            {item.required && <span>Povinná</span>}
            {response?.performedByName && <span>· {response.performedByName}</span>}
            {response?.pending && <span className="text-amber-700">· čeká na synchronizaci</span>}
          </div>
        </div>
        {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {item.details.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground group">
          <summary className="cursor-pointer inline-flex items-center gap-1 py-1">Podrobnosti <ChevronDown className="h-3 w-3 group-open:rotate-180" /></summary>
          <ul className="list-disc pl-5 space-y-1 mt-1">{item.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        </details>
      )}
      <div className="grid grid-cols-3 gap-2 mt-3">
        <Button type="button" size="sm" variant={selected === "done" ? "default" : "outline"} className={`px-1.5 text-xs ${selected === "done" ? "bg-emerald-600 hover:bg-emerald-700" : ""}`} disabled={!canFill || saving} onClick={() => choose("done")}><Check className="h-4 w-4 mr-1 shrink-0" />Hotovo</Button>
        <Button type="button" size="sm" variant={selected === "defect" ? "destructive" : "outline"} className="px-1.5 text-xs" disabled={!canFill || saving} onClick={() => choose("defect")}><AlertTriangle className="h-4 w-4 mr-1 shrink-0" />Závada</Button>
        <Button type="button" size="sm" variant={selected === "not_applicable" ? "secondary" : "outline"} className="px-1.5 text-xs" disabled={!canFill || saving} onClick={() => choose("not_applicable")}><MinusCircle className="h-4 w-4 mr-1 shrink-0" />Netýká se</Button>
      </div>
      {selected === "done" && item.kind === "measurement" && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><Label className="text-xs">Naměřená hodnota</Label><Input value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" /></div>
          <div><Label className="text-xs">Jednotka</Label><Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="Ω, MΩ, ms" /></div>
          <div className="col-span-2 flex gap-2"><Button type="button" size="sm" variant={passed ? "default" : "outline"} onClick={() => setPassed(true)}>Vyhovuje</Button><Button type="button" size="sm" variant={!passed ? "destructive" : "outline"} onClick={() => setPassed(false)}>Nevyhovuje</Button></div>
          <div className="col-span-2"><Label className="text-xs">Poznámka</Label><Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></div>
          <Button type="button" className="col-span-2" disabled={!canFill || saving || !value.trim() || !unit.trim()} onClick={() => submit()}><Save className="h-4 w-4 mr-1" />Uložit měření</Button>
        </div>
      )}
      {selected === "defect" && (
        <div className="mt-3 space-y-2"><Label className="text-xs">Popis závady</Label><Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Co přesně je potřeba opravit?" /><Button type="button" variant="destructive" className="w-full" disabled={!canFill || saving || note.trim().length < 3} onClick={() => submit()}><Save className="h-4 w-4 mr-1" />Uložit závadu</Button></div>
      )}
      {selected === "not_applicable" && (
        <div className="mt-3 space-y-2"><Label className="text-xs">Zdůvodnění{(item.required || item.critical) ? " *" : ""}</Label><Textarea rows={2} value={justification} onChange={(event) => setJustification(event.target.value)} placeholder="Proč se bod na tento rozvaděč nevztahuje?" /><Button type="button" variant="secondary" className="w-full" disabled={!canFill || saving || ((item.required || item.critical) && justification.trim().length < 3)} onClick={() => submit()}><Save className="h-4 w-4 mr-1" />Uložit</Button></div>
      )}
      {response?.result === "done" && item.kind !== "measurement" && (
        <details className="mt-2"><summary className="text-xs text-muted-foreground cursor-pointer">Poznámka k provedení</summary><div className="mt-2 flex gap-2"><Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Volitelná poznámka" /><Button size="icon" variant="outline" disabled={!canFill || saving} onClick={() => submit("done")} title="Uložit poznámku"><Save className="h-4 w-4" /></Button></div></details>
      )}
    </div>
  );
}

export function SwitchboardChecklist({ switchboardId, jobId }: { switchboardId: number; jobId: number }) {
  const { can, user } = useAuth();
  const { isOnline, enqueue, pendingOps, failedOps } = useOfflineQueue();
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = ["switchboard-checklist", switchboardId];
  const { data, isLoading, error } = useQuery({ queryKey, queryFn: () => switchboardFetch<ChecklistPayload>(`/api/switchboards/${switchboardId}/checklist`) });
  const [selectedPhase, setSelectedPhase] = useState<"assembly" | "inspection" | "measurement">("assembly");
  useEffect(() => { if (data?.instance?.currentPhase) setSelectedPhase(data.instance.currentPhase); }, [data?.instance?.currentPhase]);
  const pendingForBoard = useMemo(() => pendingOps.filter((op) => op.type === "set_switchboard_checklist_response" && op.payload.boardId === switchboardId).length, [pendingOps, switchboardId]);
  const failedForBoard = useMemo(() => failedOps.filter((op) => op.type === "set_switchboard_checklist_response" && op.payload.boardId === switchboardId).length, [failedOps, switchboardId]);
  const start = useMutation({
    mutationFn: () => switchboardFetch<ChecklistPayload>(`/api/switchboards/${switchboardId}/checklist/start`, { method: "POST" }),
    onSuccess: (payload) => { qc.setQueryData(queryKey, payload); toast({ title: "Průběžný protokol byl založen" }); },
    onError: (reason) => toast({ variant: "destructive", title: "Protokol nelze založit", description: reason.message }),
  });
  const save = useMutation({
    mutationFn: async ({ item, input }: { item: SwitchboardChecklistItem; input: Omit<ResponseInput, "expectedRevision"> }) => {
      const body: ResponseInput = { ...input, expectedRevision: item.response?.revision ?? 0 };
      const queue = async () => {
        await enqueue({ id: `switchboard-checklist-${switchboardId}-${item.key}`, type: "set_switchboard_checklist_response", jobId, payload: { boardId: switchboardId, itemKey: item.key, body } });
        qc.setQueryData<ChecklistPayload>(queryKey, (current) => current ? pendingPayload(current, item.key, body, user ? { id: user.id, name: user.name } : null) : current);
        return null;
      };
      if (!isOnline) return queue();
      try {
        return await switchboardFetch<ChecklistPayload>(`/api/switchboards/${switchboardId}/checklist/responses/${encodeURIComponent(item.key)}`, { method: "PATCH", body: JSON.stringify(body) });
      } catch (reason) {
        if (reason instanceof TypeError) return queue();
        throw reason;
      }
    },
    onSuccess: (payload) => { if (payload) qc.setQueryData(queryKey, payload); },
    onError: (reason) => toast({ variant: "destructive", title: "Kontrolu se nepodařilo uložit", description: reason.message }),
  });
  const selectPhase = useMutation({
    mutationFn: (phaseKey: typeof selectedPhase) => switchboardFetch<ChecklistPayload>(`/api/switchboards/${switchboardId}/checklist/current-phase`, { method: "PATCH", body: JSON.stringify({ phaseKey }) }),
    onSuccess: (payload) => qc.setQueryData(queryKey, payload),
  });
  const completePhase = useMutation({
    mutationFn: (phaseKey: typeof selectedPhase) => switchboardFetch<ChecklistPayload>(`/api/switchboards/${switchboardId}/checklist/phases/${phaseKey}/complete`, { method: "POST" }),
    onSuccess: (payload) => { qc.setQueryData(queryKey, payload); toast({ title: "Fáze byla dokončena" }); },
    onError: (reason) => toast({ variant: "destructive", title: "Fázi nelze dokončit", description: reason.message }),
  });
  if (isLoading) return <section className="mt-5 border-y p-6 text-sm text-muted-foreground text-center">Načítám průběžný protokol…</section>;
  if (error || !data) return <section className="mt-5 border-y p-6 text-sm text-destructive text-center">{error?.message ?? "Protokol se nepodařilo načíst."}</section>;
  if (!data.instance) return <section className="mt-5 border-y bg-card p-5"><div className="flex items-center gap-3"><ClipboardCheck className="h-6 w-6 text-cyan-600" /><div className="flex-1"><h2 className="font-semibold">Průběžný výrobní protokol</h2><p className="text-xs text-muted-foreground">Tři pracovní fáze lze vyplňovat postupně během více dnů.</p></div>{can("switchboards.checklist.fill") && <Button disabled={!isOnline || start.isPending} onClick={() => start.mutate()}>{start.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Založit protokol</Button>}</div>{!isOnline && <p className="mt-3 text-xs text-amber-700">Pro první založení protokolu je potřeba připojení.</p>}</section>;
  const phase = data.phases.find((candidate) => candidate.key === selectedPhase) ?? data.phases[0];
  return (
    <section className="mt-5 border-y bg-card">
      <div className="p-4 border-b flex items-center gap-3"><ClipboardCheck className="h-5 w-5 text-cyan-600" /><div className="flex-1"><h2 className="font-semibold">Průběžný výrobní protokol</h2><p className="text-xs text-muted-foreground">Revize {data.instance.revision}</p></div>{(!isOnline || pendingForBoard > 0 || failedForBoard > 0) && <div className={`text-xs flex items-center gap-1 ${failedForBoard ? "text-red-600" : "text-amber-700"}`}><CloudOff className="h-4 w-4" />{failedForBoard ? `${failedForBoard} změn vyžaduje opakování` : `${pendingForBoard} změn čeká na synchronizaci`}</div>}</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 border-b">
        {data.phases.map((candidate) => <button key={candidate.key} type="button" className={`text-left p-3 min-h-28 border-b sm:border-b-0 sm:border-r last:border-r-0 ${selectedPhase === candidate.key ? "bg-cyan-50 dark:bg-cyan-950/20" : "hover:bg-muted/50"}`} onClick={() => { setSelectedPhase(candidate.key); if (isOnline && candidate.key !== data.instance?.currentPhase) selectPhase.mutate(candidate.key); }}><div className="text-sm font-medium leading-5">{candidate.title}</div><div className="mt-2 text-xl font-bold">{candidate.summary.completed}/{candidate.summary.total}</div><div className="mt-1 text-xs text-muted-foreground">{STATUS_LABELS[candidate.summary.status] ?? candidate.summary.status}{candidate.summary.defects > 0 && <span className="text-red-600"> · {candidate.summary.defects} závad</span>}</div>{candidate.summary.lastWorker && <div className="mt-1 text-xs truncate">{candidate.summary.lastWorker}</div>}</button>)}
      </div>
      <div className="px-4 py-3 border-b flex items-center gap-3"><div className="flex-1"><h3 className="font-semibold text-sm">{phase.title}</h3><div className="h-2 bg-muted mt-2 overflow-hidden"><div className="h-full bg-cyan-600 transition-[width]" style={{ width: `${phase.summary.total ? Math.round(phase.summary.completed / phase.summary.total * 100) : 0}%` }} /></div></div><span className="text-xs text-muted-foreground">{phase.summary.completed} z {phase.summary.total}</span></div>
      <div className="divide-y">{phase.items.map((item) => {
        const canEdit = !item.response
          ? can("switchboards.checklist.fill")
          : item.response.performedByUserId === user?.id
            ? can("switchboards.checklist.edit_own") || can("switchboards.checklist.edit_all")
            : can("switchboards.checklist.edit_all");
        return <ChecklistItemRow key={item.key} item={item} saving={save.isPending && save.variables?.item.key === item.key} canFill={canEdit} onSave={(selectedItem, input) => save.mutate({ item: selectedItem, input })} />;
      })}</div>
      <div className="p-4 border-t flex items-center gap-3"><div className="flex-1 text-xs text-muted-foreground">Fázi lze dokončit až po vyplnění všech relevantních povinných bodů bez závad.</div>{can("switchboards.phases.complete") && <Button disabled={!isOnline || completePhase.isPending || phase.summary.completed < phase.summary.total || phase.summary.defects > 0 || phase.summary.status === "completed"} onClick={() => completePhase.mutate(phase.key)}>{completePhase.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}Dokončit fázi</Button>}</div>
    </section>
  );
}
