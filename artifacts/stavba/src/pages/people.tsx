import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import {
  useListPeople, useCreatePerson, useDeletePerson, getListPeopleQueryKey,
  useGetPeopleStats, getGetPeopleStatsQueryKey,
  useGetActiveTimers, getGetActiveTimersQueryKey,
  useListLeaves, getListLeavesQueryKey,
  useCreateLeave, useUpdateLeave, useDeleteLeave,
  useGetLeavesSummary, getGetLeavesSummaryQueryKey,
  type PersonStats,
  type ActiveTimer,
  type EmployeeLeave,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { User, Trash2, Plus, UserPlus, Briefcase, Clock, Wrench, Timer, Palmtree, Pencil, X, Stethoscope, Calendar as CalendarIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function extractServerError(err: unknown): string | null {
  const msg =
    (err as any)?.response?.data?.error ??
    (err as any)?.data?.error ??
    (err as any)?.message;
  return typeof msg === "string" ? msg : null;
}

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}`;
}

function formatStartedAt(date: Date): string {
  const isToday = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Spuštěno ${time}`;
  const day = date.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
  return `Spuštěno ${day} ${time}`;
}

function leaveTypeLabel(type: string) {
  if (type === "sick") return "Nemoc";
  if (type === "other") return "Jiné volno";
  return "Dovolená";
}

function leaveTypeIcon(type: string) {
  if (type === "sick") return "🤒";
  if (type === "other") return "📅";
  return "🏖";
}

function leaveTypeBadge(type: string) {
  if (type === "sick") return "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  if (type === "other") return "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300";
  return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
}

const CURRENT_YEAR = new Date().getFullYear();

interface LeaveFormData {
  type: string;
  startDate: string;
  endDate: string;
  note: string;
}

function PersonLeavesDialog({
  person,
  open,
  onOpenChange,
}: {
  person: { id: number; name: string };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps: confirmProps } = useConfirmDialog();

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<LeaveFormData>({ type: "vacation", startDate: today, endDate: today, note: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: leaves, isLoading: leavesLoading } = useListLeaves(
    { personId: person.id },
    { query: { queryKey: getListLeavesQueryKey({ personId: person.id }), enabled: open } }
  );

  const { data: summaryAll } = useGetLeavesSummary(
    { year: CURRENT_YEAR },
    { query: { queryKey: getGetLeavesSummaryQueryKey({ year: CURRENT_YEAR }), enabled: open } }
  );
  const summary = summaryAll?.find((s) => s.personId === person.id);

  const createLeave = useCreateLeave();
  const updateLeave = useUpdateLeave();
  const deleteLeave = useDeleteLeave();

  function resetForm() {
    setForm({ type: "vacation", startDate: today, endDate: today, note: "" });
    setEditId(null);
    setShowForm(false);
  }

  function startEdit(leave: EmployeeLeave) {
    setForm({ type: leave.type, startDate: leave.startDate, endDate: leave.endDate, note: leave.note ?? "" });
    setEditId(leave.id);
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.startDate || !form.endDate) {
      toast({ title: "Vyplňte datum začátku a konce", variant: "destructive" });
      return;
    }
    if (form.startDate > form.endDate) {
      toast({ title: "Datum konce musí být stejné nebo pozdější než datum začátku", variant: "destructive" });
      return;
    }

    const data = {
      personId: person.id,
      type: form.type as "vacation" | "sick" | "other",
      startDate: form.startDate,
      endDate: form.endDate,
      note: form.note || null,
    };

    if (editId !== null) {
      updateLeave.mutate({ id: editId, data }, {
        onSuccess: () => {
          invalidateData(queryClient, "leaves");
          toast({ title: "Dovolená aktualizována" });
          resetForm();
        },
        onError: (err) => {
          toast({ title: extractServerError(err) ?? "Nepodařilo se uložit dovolennou", variant: "destructive" });
        },
      });
    } else {
      createLeave.mutate({ data }, {
        onSuccess: () => {
          invalidateData(queryClient, "leaves");
          toast({ title: "Dovolená přidána" });
          resetForm();
        },
        onError: (err) => {
          toast({ title: extractServerError(err) ?? "Nepodařilo se přidat dovolenou", variant: "destructive" });
        },
      });
    }
  }

  function handleDelete(id: number) {
    openConfirm("Opravdu smazat tento záznam dovolené?", () => {
      deleteLeave.mutate({ id }, {
        onSuccess: () => {
          invalidateData(queryClient, "leaves");
          toast({ title: "Dovolená smazána" });
        },
        onError: () => {
          toast({ title: "Nepodařilo se smazat dovolenou", variant: "destructive" });
        },
      });
    });
  }

  const sortedLeaves = [...(leaves ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Palmtree className="h-5 w-5 text-emerald-600" />
              Dovolené – {person.name}
            </DialogTitle>
          </DialogHeader>

          {summary && (
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/20 p-3 text-center">
                <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                  {summary.vacationDays}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Dovolená (dny {CURRENT_YEAR})</div>
              </div>
              <div className="rounded-lg bg-rose-50 dark:bg-rose-950/20 p-3 text-center">
                <div className="text-2xl font-bold text-rose-700 dark:text-rose-400">
                  {summary.sickDays}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Nemoc (dny {CURRENT_YEAR})</div>
              </div>
              <div className="rounded-lg bg-sky-50 dark:bg-sky-950/20 p-3 text-center">
                <div className="text-2xl font-bold text-sky-700 dark:text-sky-400">
                  {summary.otherDays}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Jiné (dny {CURRENT_YEAR})</div>
              </div>
            </div>
          )}

          {!showForm && (
            <Button
              variant="outline"
              size="sm"
              className="w-full border-dashed"
              onClick={() => { resetForm(); setShowForm(true); }}
            >
              <Plus className="h-4 w-4 mr-1" /> Přidat záznam
            </Button>
          )}

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <div className="font-medium text-sm mb-1">
                {editId ? "Upravit záznam" : "Nový záznam"}
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Typ</Label>
                <Select value={form.type} onValueChange={(v) => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vacation">🏖 Dovolená</SelectItem>
                    <SelectItem value="sick">🤒 Nemoc / nemocenská</SelectItem>
                    <SelectItem value="other">📅 Jiné volno</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Od</Label>
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm(f => ({ ...f, startDate: e.target.value }))}
                    className="h-9"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Do</Label>
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm(f => ({ ...f, endDate: e.target.value }))}
                    className="h-9"
                    min={form.startDate}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Poznámka (nepovinné)</Label>
                <Textarea
                  value={form.note}
                  onChange={(e) => setForm(f => ({ ...f, note: e.target.value }))}
                  className="h-16 resize-none"
                  placeholder="Volitelná poznámka..."
                />
              </div>

              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={createLeave.isPending || updateLeave.isPending}
                  className="flex-1"
                >
                  {editId ? "Uložit změny" : "Přidat"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                  Zrušit
                </Button>
              </div>
            </form>
          )}

          <div className="space-y-2 mt-1">
            {leavesLoading ? (
              [1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)
            ) : sortedLeaves.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground border-2 border-dashed rounded-lg border-muted">
                Žádné záznamy dovolených.
              </div>
            ) : (
              sortedLeaves.map((leave) => (
                <div
                  key={leave.id}
                  className="flex items-start gap-3 rounded-lg border bg-card p-3"
                >
                  <span className="text-lg mt-0.5">{leaveTypeIcon(leave.type)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full ${leaveTypeBadge(leave.type)}`}>
                        {leaveTypeLabel(leave.type)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {leave.startDate === leave.endDate
                          ? leave.startDate
                          : `${leave.startDate} – ${leave.endDate}`}
                        {" "}
                        <span className="font-semibold text-foreground">({leave.days} {leave.days === 1 ? "den" : leave.days < 5 ? "dny" : "dní"})</span>
                      </span>
                    </div>
                    {leave.note && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">{leave.note}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => startEdit(leave)}
                      title="Upravit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => handleDelete(leave.id)}
                      disabled={deleteLeave.isPending}
                      title="Smazat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...confirmProps} />
    </>
  );
}

function ActiveTimersPanel({ timers }: { timers: ActiveTimer[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timers.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timers.length]);

  return (
    <Card className="mb-8 border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Timer className="h-4 w-4 text-amber-600" />
          <h2 className="font-semibold text-sm">Aktivní časovače</h2>
          {timers.length > 0 && (
            <span className="text-xs text-muted-foreground">({timers.length})</span>
          )}
        </div>
        {timers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Žádné aktivní časovače.</p>
        ) : (
          <ul className="divide-y divide-amber-200/60 dark:divide-amber-900/40">
            {timers.map((t) => {
              const startedMs = new Date(t.timerStartedAt).getTime();
              const href = t.kind === "job" ? `/jobs/${t.parentId}` : `/activities/${t.parentId}`;
              return (
                <li key={t.id} className="first:pt-0 last:pb-0">
                  <Link
                    href={href}
                    className="flex items-center gap-3 py-2 rounded-md -mx-2 px-2 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 transition-colors"
                  >
                    <div className="bg-amber-500/15 p-1.5 rounded-full text-amber-600 shrink-0">
                      <User className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{t.personName}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        {t.kind === "job" ? (
                          <Briefcase className="h-3 w-3 shrink-0" />
                        ) : (
                          <Clock className="h-3 w-3 shrink-0" />
                        )}
                        <span className="truncate">{t.parentName}</span>
                      </p>
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <span className="font-mono text-sm tabular-nums text-amber-700 dark:text-amber-400">
                        {formatElapsed(startedMs, now)}
                      </span>
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                        {formatStartedAt(new Date(startedMs))}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PersonCard({
  person,
  stats,
  onDelete,
  isDeleting,
  onNavigate,
}: {
  person: { id: number; name: string };
  stats: PersonStats | undefined;
  onDelete: (id: number) => void;
  isDeleting: boolean;
  onNavigate: (path: string) => void;
}) {
  const [leavesOpen, setLeavesOpen] = useState(false);

  return (
    <>
      <Card className="hover:bg-muted/30 transition-colors">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 p-2.5 rounded-full text-primary shrink-0 mt-0.5">
              <User className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-base">{person.name}</span>
                {stats?.hasActiveTimer && (
                  <Badge variant="outline" className="border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-950/30 text-xs gap-1 px-1.5">
                    <Timer className="h-3 w-3" /> Časovač běží
                  </Badge>
                )}
              </div>
              {stats ? (
                <div className="flex flex-wrap gap-3 mt-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => onNavigate(`/jobs?assignedPersonId=${person.id}`)}
                    title="Dnešní zakázky"
                  >
                    <Briefcase className="h-3.5 w-3.5" />
                    <span>
                      Dnes: <strong>{stats.todayJobsCount}</strong>
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Hodiny tento týden">
                    <Clock className="h-3.5 w-3.5" />
                    <span>
                      Týden: <strong>{stats.weekHours.toFixed(1)} h</strong>
                    </span>
                  </div>
                  {stats.assignedMachinesCount > 0 && (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Přiřazené stroje">
                      <Wrench className="h-3.5 w-3.5" />
                      <span>
                        Stroje: <strong>{stats.assignedMachinesCount}</strong>
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex gap-3 mt-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-700"
                onClick={() => setLeavesOpen(true)}
                title="Dovolené"
              >
                <Palmtree className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onDelete(person.id)}
                disabled={isDeleting}
                title="Odebrat pracovníka"
              >
                <Trash2 className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <PersonLeavesDialog
        person={person}
        open={leavesOpen}
        onOpenChange={setLeavesOpen}
      />
    </>
  );
}

export default function People() {
  const [newPersonName, setNewPersonName] = useState("");
  const [nameError, setNameError] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const [, setLocation] = useLocation();

  const { data: people, isLoading: loadingPeople } = useListPeople({
    query: { queryKey: getListPeopleQueryKey() },
  });

  const { data: statsData } = useGetPeopleStats({
    query: { queryKey: getGetPeopleStatsQueryKey() },
  });

  const { data: activeTimers } = useGetActiveTimers({
    query: { queryKey: getGetActiveTimersQueryKey() },
  });

  const statsMap = new Map((statsData ?? []).map((s) => [s.personId, s]));

  const createPerson = useCreatePerson();
  const deletePerson = useDeletePerson();

  const handleAddPerson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonName.trim()) {
      setNameError("Jméno pracovníka je povinné");
      return;
    }
    setNameError("");

    createPerson.mutate({ data: { name: newPersonName.trim() } }, {
      onSuccess: () => {
        setNewPersonName("");
        setNameError("");
        invalidateData(queryClient, "people");
        toast({ title: "Pracovník přidán" });
      },
      onError: (err) => {
        const serverMsg = extractServerError(err);
        if (serverMsg) {
          setNameError(serverMsg);
        } else {
          toast({ title: "Nepodařilo se přidat pracovníka", variant: "destructive" });
        }
      },
    });
  };

  const handleDeletePerson = (id: number) => {
    openConfirm("Opravdu chcete odebrat tohoto pracovníka?", () => {
      deletePerson.mutate({ id }, {
        onSuccess: () => {
          invalidateData(queryClient, "people");
          toast({ title: "Pracovník odebrán" });
        },
        onError: () => {
          toast({ title: "Nepodařilo se odebrat pracovníka", variant: "destructive" });
        },
      });
    });
  };

  const activeTimerCount = statsData?.filter((s) => s.hasActiveTimer).length ?? 0;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold flex-1">Tým</h1>
        {activeTimerCount > 0 && (
          <Badge variant="outline" className="border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-950/30 gap-1">
            <Timer className="h-3.5 w-3.5" />
            {activeTimerCount} {activeTimerCount === 1 ? "aktivní časovač" : "aktivní časovače"}
          </Badge>
        )}
      </div>

      <ActiveTimersPanel timers={activeTimers ?? []} />

      <Card className="mb-8 border-primary/20 bg-primary/5">
        <CardContent className="p-4">
          <form onSubmit={handleAddPerson} className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <UserPlus className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  value={newPersonName}
                  onChange={(e) => {
                    setNewPersonName(e.target.value);
                    if (nameError) setNameError("");
                  }}
                  placeholder="Jméno pracovníka..."
                  className={`pl-10 h-14 text-base bg-background${nameError ? " border-destructive" : ""}`}
                  aria-invalid={!!nameError}
                />
              </div>
              <Button type="submit" disabled={createPerson.isPending} className="h-14 px-6">
                <Plus className="h-5 w-5 md:mr-2" />
                <span className="hidden md:inline">Přidat</span>
              </Button>
            </div>
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {loadingPeople ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : people && people.length > 0 ? (
          people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              stats={statsMap.get(person.id)}
              onDelete={handleDeletePerson}
              isDeleting={deletePerson.isPending}
              onNavigate={setLocation}
            />
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <User className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Zatím žádní pracovníci.</p>
            <p className="text-sm mt-1">Přidejte prvního pomocí formuláře výše.</p>
          </div>
        )}
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
