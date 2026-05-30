import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useGetDashboardSummary, useGetTodayJobs, useUpdateJob, useUpdateJobStatus,
  getGetDashboardSummaryQueryKey, getGetTodayJobsQueryKey, getGetJobQueryKey,
  useListPeople, getListPeopleQueryKey, useListJobs, getListJobsQueryKey,
  useReorderJobs,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeBadge, StatusBadge } from "@/components/badges";
import { Calendar, CheckCircle2, Clock, PlayCircle, Play, Square, MapPin, User, ChevronRight, Navigation, Timer, GripVertical } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function useTimer(timerStartedAt: string | null | undefined) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!timerStartedAt) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(timerStartedAt).getTime()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [timerStartedAt]);

  return elapsed;
}

export function hoursFromPresetTimes(startTime: string | null | undefined, endTime: string | null | undefined): number | null {
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return null;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) return null;
  return Math.round((mins / 60) * 100) / 100;
}

export function computeTimerHours(elapsedSeconds: number, existingHoursSpent: number | string | null | undefined) {
  const existing = existingHoursSpent ? Number(existingHoursSpent) : 0;
  if (elapsedSeconds < 300) {
    return { newTotal: existing, added: 0, belowThreshold: true };
  }
  const added = Math.round((elapsedSeconds / 3600) * 100) / 100;
  const newTotal = Math.round((existing + added) * 100) / 100;
  return { newTotal, added, belowThreshold: false };
}

function formatElapsed(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function DashboardJobRow({ job }: { job: any }) {
  const updateJob = useUpdateJob();
  const updateStatus = useUpdateJobStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const elapsed = useTimer(job.timerStartedAt);
  const isRunning = !!job.timerStartedAt;

  const handleStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateJob.mutate(
      { id: job.id, data: { timerStartedAt: new Date().toISOString(), status: "in_progress" } },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetJobQueryKey(job.id), data);
          queryClient.invalidateQueries({ queryKey: getGetTodayJobsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Čas spuštěn" });
        },
      }
    );
  };

  const handleStop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { newTotal, added, belowThreshold } = computeTimerHours(elapsed, job.hoursSpent);
    updateJob.mutate(
      { id: job.id, data: { timerStartedAt: null, hoursSpent: newTotal } },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetJobQueryKey(job.id), data);
          queryClient.invalidateQueries({ queryKey: getGetTodayJobsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({
            title: belowThreshold
              ? `Čas zastaven — pod 5 min, nezapočítáno`
              : `Čas zastaven — +${added.toFixed(2)} h (celkem ${newTotal.toFixed(2)} h)`,
          });
        },
      }
    );
  };

  const finished = job.status === "done" || job.status === "cancelled";
  return (
    <div className={`bg-card border rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all ${
      finished ? "opacity-65 saturate-50 hover:opacity-95 hover:saturate-100" : ""
    }`}>
      {/* Timer banner when running */}
      {isRunning && (
        <div className="bg-green-500 text-white px-4 py-1.5 flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Měření času
          </span>
          <span className="font-mono font-bold text-base">{formatElapsed(elapsed)}</span>
        </div>
      )}

      <div className="p-4 cursor-pointer" onClick={() => setLocation(`/jobs/${job.id}`)}>
        {/* Title row + date on right */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-bold text-lg leading-tight flex-1">{job.title}</h3>
          <div className="text-right shrink-0">
            <div className="text-base font-bold text-foreground">
              {job.startTime && job.endTime ? `${job.startTime} – ${job.endTime}` : job.startTime || ""}
            </div>
            <div className="text-sm text-muted-foreground">
              {format(new Date(job.date), "d.M.yyyy", { locale: cs })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-3">
          <TypeBadge type={job.type} />
          <StatusBadge status={job.status} />
        </div>

        <div className="space-y-1 text-sm text-muted-foreground">
          {job.clientSite && (
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 shrink-0" />
              <span className="truncate">{job.clientSite}</span>
            </div>
          )}
          {job.address && (
            <div className="flex items-center gap-2">
              <Navigation className="w-4 h-4 shrink-0 text-blue-500" />
              <a
                href={`https://waze.com/ul?q=${encodeURIComponent(job.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-blue-500 hover:underline truncate"
              >
                {job.address}
              </a>
            </div>
          )}
          {job.assignedPersonName && (
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 shrink-0" />
              <span className="truncate">{job.assignedPersonName}</span>
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="border-t flex">
        {isRunning ? (
          <button
            onClick={handleStop}
            disabled={updateJob.isPending}
            className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
          >
            <Square className="w-4 h-4 fill-current" /> Zastavit čas
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={updateJob.isPending}
            className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold text-green-600 hover:bg-green-50 dark:hover:bg-green-950/20 transition-colors"
          >
            <Play className="w-4 h-4 fill-current" /> Spustit čas
          </button>
        )}
        <Link href={`/jobs/${job.id}`} className="flex items-center justify-center px-4 border-l hover:bg-muted transition-colors">
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </Link>
      </div>
    </div>
  );
}

function SortableJobRow({ job }: { job: any }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative select-none ${isDragging ? "z-10 opacity-90 shadow-2xl scale-[1.02]" : ""}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 -m-2 cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground"
        aria-label="Přetáhnout pro změnu pořadí"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-5 h-5" />
      </div>
      <DashboardJobRow job={job} />
    </div>
  );
}

function ActiveTimerBanner({ jobs }: { jobs: any[] }) {
  const runningJob = jobs.find(j => !!j.timerStartedAt);
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const elapsed = useTimer(runningJob?.timerStartedAt);

  if (!runningJob) return null;

  const handleStop = () => {
    const { newTotal, added, belowThreshold } = computeTimerHours(elapsed, runningJob.hoursSpent);
    updateJob.mutate(
      { id: runningJob.id, data: { timerStartedAt: null, hoursSpent: newTotal } },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetJobQueryKey(runningJob.id), data);
          queryClient.invalidateQueries({ queryKey: getGetTodayJobsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({
            title: belowThreshold
              ? `Čas zastaven — pod 5 min, nezapočítáno`
              : `Čas zastaven — +${added.toFixed(2)} h (celkem ${newTotal.toFixed(2)} h)`,
          });
        },
      }
    );
  };

  return (
    <div className="mb-6 rounded-2xl bg-green-500 text-white shadow-lg overflow-hidden">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-2 mb-1 opacity-80">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider">Měří se čas</span>
        </div>
        <div
          className="font-bold text-lg leading-tight cursor-pointer hover:underline mb-3"
          onClick={() => setLocation(`/jobs/${runningJob.id}`)}
        >
          {runningJob.title}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Timer className="w-5 h-5 opacity-80" />
            <span className="font-mono text-3xl font-bold tracking-tight">{formatElapsed(elapsed)}</span>
          </div>
          <Button
            onClick={handleStop}
            disabled={updateJob.isPending}
            variant="secondary"
            className="h-11 px-5 bg-white/20 hover:bg-white/30 text-white border-white/30 font-bold text-base shrink-0"
          >
            <Square className="w-4 h-4 mr-2 fill-current" /> Zastavit
          </Button>
        </div>
      </div>
    </div>
  );
}

function WeekEmployeeRow({ person, weekFrom, weekTo }: { person: any; weekFrom: string; weekTo: string }) {
  const { data: jobs } = useListJobs({ from: weekFrom, to: weekTo, assignedPersonId: person.id }, {
    query: { queryKey: getListJobsQueryKey({ from: weekFrom, to: weekTo, assignedPersonId: person.id }) }
  });
  const totalHours = jobs?.reduce((s, j) => s + (j.hoursSpent ? Number(j.hoursSpent) : 0), 0) || 0;
  const doneCount = jobs?.filter(j => j.status === "done").length || 0;
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-b-0">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">
          {person.name.charAt(0)}
        </div>
        <span className="font-medium">{person.name}</span>
      </div>
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="text-green-600 font-medium">{doneCount} hotovo</span>
        <span className="font-bold text-foreground">{totalHours.toFixed(1)} h</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() }
  });

  const { data: jobs, isLoading: loadingJobs } = useGetTodayJobs({
    query: { queryKey: getGetTodayJobsQueryKey() }
  });

  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reorder = useReorderJobs();
  const [orderedJobs, setOrderedJobs] = useState<any[]>([]);

  useEffect(() => {
    if (jobs) setOrderedJobs(jobs);
  }, [jobs]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedJobs(prev => {
      const oldIndex = prev.findIndex(j => j.id === active.id);
      const newIndex = prev.findIndex(j => j.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      reorder.mutate(
        { data: { ids: next.map(j => j.id) } },
        {
          onError: () => {
            toast({ title: "Nepodařilo se uložit pořadí", variant: "destructive" });
            queryClient.invalidateQueries({ queryKey: getGetTodayJobsQueryKey() });
          },
        }
      );
      return next;
    });
  };

  const today = new Date();
  const dayOfWeek = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekFrom = format(monday, "yyyy-MM-dd");
  const weekTo = format(sunday, "yyyy-MM-dd");

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Dnes</h1>

      {jobs && <ActiveTimerBanner jobs={jobs} />}

      {loadingSummary ? (
        <Skeleton className="h-16 w-full mb-6" />
      ) : summary ? (
        <div className="grid grid-cols-4 gap-2 mb-6">
          <Card className="bg-primary text-primary-foreground border-none">
            <CardContent className="p-2.5 flex flex-col items-center justify-center">
              <div className="text-xl font-bold leading-none">{summary.todayCount}</div>
              <div className="text-[10px] font-medium uppercase tracking-wider opacity-80 mt-1">Dnes</div>
            </CardContent>
          </Card>
          <Card className="bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
            <CardContent className="p-2.5 flex flex-col items-center justify-center">
              <div className="text-xl font-bold leading-none">{summary.inProgressCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80 mt-1">Probíhá</div>
            </CardContent>
          </Card>
          <Card className="bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800">
            <CardContent className="p-2.5 flex flex-col items-center justify-center">
              <div className="text-xl font-bold leading-none">{summary.plannedCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80 mt-1">Naplánováno</div>
            </CardContent>
          </Card>
          <Card className="bg-green-100 text-green-900 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-800">
            <CardContent className="p-2.5 flex flex-col items-center justify-center">
              <div className="text-xl font-bold leading-none">{summary.doneCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80 mt-1">Hotovo</div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex justify-between items-end mb-4">
        <h2 className="text-xl font-bold text-foreground">Dnešní program</h2>
      </div>

      {loadingJobs ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      ) : orderedJobs.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedJobs.map(j => j.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-4">
              {orderedJobs.map(job => <SortableJobRow key={job.id} job={job} />)}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="text-center py-12 px-4 border-2 border-dashed rounded-xl border-muted">
          <Calendar className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-bold mb-1">Dnes žádné zakázky</h3>
          <p className="text-muted-foreground mb-4">Odpočiňte si, nebo přidejte novou zakázku.</p>
        </div>
      )}

      {summary && (
        <div className="mt-8 pt-8 border-t space-y-4">
          <h2 className="text-lg font-bold text-muted-foreground">Tento týden</h2>
          <div className="grid grid-cols-2 gap-4">
            <Card className="bg-muted border-none">
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground font-medium mb-1">Celkem hodin</div>
                <div className="text-2xl font-bold">{summary.totalHoursThisWeek} h</div>
              </CardContent>
            </Card>
            <Card className="bg-muted border-none">
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground font-medium mb-1">Tržby</div>
                <div className="text-2xl font-bold">{summary.totalRevenueThisWeek.toLocaleString("cs-CZ")} Kč</div>
              </CardContent>
            </Card>
          </div>

          {people && people.length > 0 && (
            <Card className="border-none bg-muted">
              <CardContent className="p-4">
                <h3 className="text-sm font-bold text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-1.5">
                  <User className="w-4 h-4" /> Pracovníci tento týden
                </h3>
                {people.map(p => (
                  <WeekEmployeeRow key={p.id} person={p} weekFrom={weekFrom} weekTo={weekTo} />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
