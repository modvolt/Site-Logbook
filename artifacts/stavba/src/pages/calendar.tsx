import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  format,
  startOfWeek,
  endOfWeek,
  addDays,
  addWeeks,
  subWeeks,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  subDays,
  isSameMonth,
  getDay,
  parseISO,
  isValid,
} from "date-fns";
import { cs } from "date-fns/locale";
import {
  useGetJobsCalendar,
  getGetJobsCalendarQueryKey,
  useListPeople,
  getListPeopleQueryKey,
  useListLeaves,
  getListLeavesQueryKey,
  useListPublicHolidays,
  getListPublicHolidaysQueryKey,
  useUpdateJob,
  useGetActivityVisitsCalendar,
  getGetActivityVisitsCalendarQueryKey,
  useUpdateActivityVisit,
  useListActivities,
  useCreateActivityVisit,
  type CalendarJob,
  type EmployeeLeave,
  type Person,
  type CalendarActivityVisit,
  type Activity,
} from "@workspace/api-client-react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarDays,
  Rows3,
  LayoutGrid,
  Palmtree,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QueryErrorState } from "@/components/query-error-state";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { invalidateData } from "@/lib/query-invalidation";

type View = "week" | "month" | "day";

const STATUS_CHIP: Record<string, string> = {
  planned: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  done: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 opacity-60",
  cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 opacity-40",
  vyfakturovano: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
};

function statusChip(status: string) {
  return STATUS_CHIP[status] ?? STATUS_CHIP.planned;
}

function leaveIcon(type: string) {
  if (type === "sick") return "🤒";
  if (type === "other") return "📅";
  return "🏖";
}

function leaveBgClass(type: string) {
  if (type === "sick") return "bg-rose-500";
  if (type === "other") return "bg-sky-500";
  return "bg-emerald-500";
}

function leaveLabel(type: string) {
  if (type === "sick") return "Nemoc";
  if (type === "other") return "Volno";
  return "Dovolená";
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function personLeavesOn(leaves: EmployeeLeave[], personId: number, dateStr: string): EmployeeLeave[] {
  return leaves.filter((l) => l.personId === personId && l.startDate <= dateStr && l.endDate >= dateStr);
}

function jobsForSlot(jobs: CalendarJob[], personId: number | null, dateStr: string): CalendarJob[] {
  return jobs.filter((j) => {
    const matchDate = j.date === dateStr;
    if (personId === null) return matchDate && (j.assignedPersonId == null);
    return matchDate && j.assignedPersonId === personId;
  });
}

function jobsForDay(jobs: CalendarJob[], dateStr: string): CalendarJob[] {
  return jobs.filter((j) => j.date === dateStr);
}

interface JobChipProps {
  job: CalendarJob;
  onNavigate: (path: string) => void;
  compact?: boolean;
  isDragging?: boolean;
}

function JobChip({ job, onNavigate, compact, isDragging }: JobChipProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onNavigate(`/jobs/${job.id}`); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onNavigate(`/jobs/${job.id}`); } }}
      className={`w-full rounded px-1 py-0.5 text-[10px] font-medium leading-tight truncate cursor-grab select-none ${statusChip(job.status)} ${isDragging ? "opacity-40" : ""}`}
      title={`${job.title}${job.startTime ? ` · ${job.startTime}` : ""}`}
    >
      {compact ? truncate(job.title, 14) : (
        <span>
          {job.startTime && <span className="opacity-70 mr-0.5">{job.startTime}</span>}
          {truncate(job.title, 20)}
        </span>
      )}
    </div>
  );
}

interface DraggableJobChipProps {
  job: CalendarJob;
  onNavigate: (path: string) => void;
}

function DraggableJobChip({ job, onNavigate }: DraggableJobChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `job-${job.id}`,
    data: { job },
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform), zIndex: 50, opacity: 0 }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="touch-none"
      onClick={(e) => e.stopPropagation()}
    >
      <JobChip job={job} onNavigate={onNavigate} compact isDragging={isDragging} />
    </div>
  );
}

interface DroppableSlotProps {
  id: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

function DroppableSlot({ id, children, className, onClick, onKeyDown }: DroppableSlotProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      data-slot={id}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`${className ?? ""} ${isOver ? "ring-2 ring-primary/60 ring-inset bg-primary/5" : ""}`}
    >
      {children}
    </div>
  );
}

function slotId(personId: number | null, dateStr: string) {
  return `slot-${personId ?? "null"}-${dateStr}`;
}

function parseSlotId(id: string): { personId: number | null; dateStr: string } | null {
  const m = id.match(/^slot-([\d]+|null)-(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return {
    personId: m[1] === "null" ? null : Number(m[1]),
    dateStr: m[2],
  };
}

function actVisitChipClass(status: string) {
  switch (status) {
    case "completed": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "cancelled": return "bg-gray-200 text-gray-500 dark:bg-gray-700/40 dark:text-gray-400 line-through";
    default: return "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300";
  }
}

interface CreateActivityVisitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  personId: number | null;
  activities: Activity[];
  onConfirm: (activityId: number) => void;
  isLoading: boolean;
}

function CreateActivityVisitDialog({ open, onOpenChange, date, personId: _personId, activities, onConfirm, isLoading }: CreateActivityVisitDialogProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const active = activities.filter((a) => !a.isArchived);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Nový výjezd akce</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Datum: <span className="font-medium text-foreground">{date}</span></p>
          <div>
            <label className="text-sm font-medium block mb-1">Akce</label>
            <select
              className="w-full h-10 rounded-md border bg-background px-3 text-sm"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— Vyberte akci —</option>
              {active.map((a) => (
                <option key={a.id} value={String(a.id)}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Zrušit</Button>
          <Button
            onClick={() => { if (selectedId) onConfirm(Number(selectedId)); }}
            disabled={!selectedId || isLoading}
          >
            {isLoading ? "Ukládám…" : "Vytvořit výjezd"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DraggableActivityVisitChipProps {
  visit: CalendarActivityVisit;
  onNavigate: (path: string) => void;
}

function DraggableActivityVisitChip({ visit, onNavigate }: DraggableActivityVisitChipProps) {
  const updateVisit = useUpdateActivityVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `actvisit-${visit.id}`,
    data: { activityVisit: visit },
  });
  const style = transform ? { transform: CSS.Translate.toString(transform), zIndex: 50, opacity: 0.5 } : undefined;

  const handleToggleComplete = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = visit.status === "completed" ? "planned" : "completed";
    updateVisit.mutate(
      { activityId: visit.activityId, visitId: visit.id, data: { status: newStatus } },
      {
        onSuccess: () => {
          invalidateData(queryClient, "activities");
          toast({ title: newStatus === "completed" ? "Výjezd splněn" : "Výjezd obnoven" });
        },
      },
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      className={`w-full rounded px-1 py-0.5 text-[9px] font-medium leading-tight touch-none select-none cursor-grab active:cursor-grabbing border-l-2 border-violet-400 dark:border-violet-600 flex items-center gap-0.5 ${actVisitChipClass(visit.status)} ${isDragging ? "opacity-30" : ""}`}
      title={`Akce: ${visit.activityName}${visit.timeFrom ? ` · ${visit.timeFrom}` : ""}${visit.personName ? ` · ${visit.personName}` : ""}`}
      onClick={(e) => { if (!isDragging) { e.stopPropagation(); onNavigate(`/activities/${visit.activityId}`); } }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(`/activities/${visit.activityId}`); }}
    >
      <span className="truncate flex-1">◈ {truncate(visit.activityName, 12)}</span>
      <button
        type="button"
        className={`shrink-0 rounded hover:bg-black/10 dark:hover:bg-white/10 p-0.5 transition-colors ${visit.status === "completed" ? "text-emerald-600 dark:text-emerald-400" : "opacity-40 hover:opacity-100"}`}
        onClick={handleToggleComplete}
        title={visit.status === "completed" ? "Označit jako neplánovaný" : "Označit jako splněný"}
        aria-label={visit.status === "completed" ? "Označit jako neplánovaný" : "Označit jako splněný"}
      >
        <Check className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

interface WeekViewProps {
  jobs: CalendarJob[];
  activityVisits: CalendarActivityVisit[];
  people: Person[];
  leaves: EmployeeLeave[];
  holidays: Map<string, string>;
  weekStart: Date;
  onNavigate: (path: string) => void;
  onRequestCreateVisit: (date: string, personId: number | null) => void;
}

function WeekView({ jobs, activityVisits, people, leaves, holidays, weekStart, onNavigate, onRequestCreateVisit }: WeekViewProps) {
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));
  const dayStrs = days.map((d) => format(d, "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");
  const DAY_NAMES = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

  const updateJob = useUpdateJob();
  const updateActivityVisit = useUpdateActivityVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { date: string; assignedPersonId: number | null }>
  >(new Map());
  const [optimisticVisitOverrides, setOptimisticVisitOverrides] = useState<
    Map<number, { date: string }>
  >(new Map());

  const [draggingJobId, setDraggingJobId] = useState<number | null>(null);
  const [draggingVisitId, setDraggingVisitId] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const effectiveJobs = useMemo(() => {
    if (optimisticOverrides.size === 0) return jobs;
    return jobs.map((j) => {
      const override = optimisticOverrides.get(j.id);
      if (!override) return j;
      return { ...j, ...override };
    });
  }, [jobs, optimisticOverrides]);

  const effectiveVisits = useMemo(() => {
    if (optimisticVisitOverrides.size === 0) return activityVisits;
    return activityVisits.map((v) => {
      const override = optimisticVisitOverrides.get(v.id);
      if (!override) return v;
      return { ...v, ...override };
    });
  }, [activityVisits, optimisticVisitOverrides]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const job = event.active.data.current?.job as CalendarJob | undefined;
    if (job) { setDraggingJobId(job.id); return; }
    const visit = event.active.data.current?.activityVisit as CalendarActivityVisit | undefined;
    if (visit) setDraggingVisitId(visit.id);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingJobId(null);
    setDraggingVisitId(null);
    const { active, over } = event;
    if (!over) return;

    const target = parseSlotId(String(over.id));
    if (!target) return;

    const visit = active.data.current?.activityVisit as CalendarActivityVisit | undefined;
    if (visit) {
      if (visit.date === target.dateStr) return;
      setOptimisticVisitOverrides((prev) => { const next = new Map(prev); next.set(visit.id, { date: target.dateStr }); return next; });
      updateActivityVisit.mutate(
        { activityId: visit.activityId, visitId: visit.id, data: { date: target.dateStr } },
        {
          onSuccess: () => {
            setOptimisticVisitOverrides((prev) => { const next = new Map(prev); next.delete(visit.id); return next; });
            invalidateData(queryClient, "activities");
            toast({ title: "Výjezd přesunut" });
          },
          onError: () => {
            setOptimisticVisitOverrides((prev) => { const next = new Map(prev); next.delete(visit.id); return next; });
            toast({ title: "Přesun selhal", variant: "destructive" });
          },
        },
      );
      return;
    }

    const job = active.data.current?.job as CalendarJob | undefined;
    if (!job) return;

    const sameSlot = job.date === target.dateStr && job.assignedPersonId === target.personId;
    if (sameSlot) return;

    const originalDate = job.date;
    const originalPersonId = job.assignedPersonId;

    setOptimisticOverrides((prev) => {
      const next = new Map(prev);
      next.set(job.id, { date: target.dateStr, assignedPersonId: target.personId });
      return next;
    });

    updateJob.mutate(
      {
        id: job.id,
        data: {
          date: target.dateStr,
          assignedPersonId: target.personId,
        },
      },
      {
        onSuccess: () => {
          setOptimisticOverrides((prev) => {
            const next = new Map(prev);
            next.delete(job.id);
            return next;
          });
          invalidateData(queryClient, "jobs");
          toast({
            title: "Zakázka přeřazena",
            action: (
              <ToastAction
                altText="Vrátit přesun"
                onClick={() => {
                  updateJob.mutate(
                    { id: job.id, data: { date: originalDate, assignedPersonId: originalPersonId } },
                    { onSuccess: () => { invalidateData(queryClient, "jobs"); } },
                  );
                }}
              >
                Vrátit
              </ToastAction>
            ),
          });
        },
        onError: (err: unknown) => {
          setOptimisticOverrides((prev) => {
            const next = new Map(prev);
            next.delete(job.id);
            return next;
          });
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status === 409) {
            toast({
              title: "Přeřazení neprovedeno",
              description: "Zaměstnanec má v tento den dovolenou.",
              variant: "destructive",
            });
          } else {
            toast({
              title: "Přeřazení selhalo",
              description: "Zkuste to prosím znovu.",
              variant: "destructive",
            });
          }
        },
      },
    );
  }, [updateJob, updateActivityVisit, queryClient, toast]);

  const draggingJob = draggingJobId != null
    ? (jobs.find((j) => j.id === draggingJobId) ?? null)
    : null;
  const draggingVisit = draggingVisitId != null
    ? (activityVisits.find((v) => v.id === draggingVisitId) ?? null)
    : null;

  const rows: Array<{ person: Person | null; label: string }> = [
    ...people.map((p) => ({ person: p, label: p.name })),
    { person: null, label: "Nepřiřazeno" },
  ];

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto relative">
        <div className="absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-background/60 to-transparent pointer-events-none z-10 sm:hidden" />
        <div className="min-w-[680px]">
          <div
            className="grid border-b bg-card"
            style={{ gridTemplateColumns: "140px repeat(7, 1fr)" }}
          >
            <div className="px-2 py-2 text-xs font-medium text-muted-foreground border-r sticky left-0 bg-card z-10" />
            {days.map((d, i) => {
              const ds = dayStrs[i];
              const isToday = ds === today;
              const isWeekend = i >= 5;
              const holiday = holidays.get(ds);
              return (
                <div
                  key={ds}
                  className={`px-1 py-1.5 text-center border-r last:border-r-0 ${isWeekend ? "bg-gray-50 dark:bg-gray-800/30" : ""}`}
                >
                  <div className={`text-xs font-semibold ${isWeekend ? "text-gray-400" : "text-muted-foreground"}`}>
                    {DAY_NAMES[i]}
                  </div>
                  <div className={`text-sm font-bold mx-auto w-7 h-7 flex items-center justify-center rounded-full
                    ${isToday ? "bg-primary text-primary-foreground" : isWeekend ? "text-gray-400 dark:text-gray-500" : "text-foreground"}`}>
                    {format(d, "d")}
                  </div>
                  {holiday && (
                    <div className="text-[8px] text-amber-700 dark:text-amber-400 font-medium truncate mt-0.5 px-0.5" title={holiday}>
                      {truncate(holiday, 10)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {rows.map(({ person, label }) => (
            <div
              key={person?.id ?? "unassigned"}
              className="grid border-b last:border-b-0"
              style={{ gridTemplateColumns: "140px repeat(7, 1fr)" }}
            >
              <div className="px-2 py-2 border-r bg-muted/30 flex items-start sticky left-0 z-10">
                <span className="text-xs font-semibold text-foreground leading-tight break-words">
                  {label}
                </span>
              </div>
              {days.map((d, i) => {
                const ds = dayStrs[i];
                const isToday = ds === today;
                const isWeekend = i >= 5;
                const slotJobs = jobsForSlot(effectiveJobs, person?.id ?? null, ds);
                const slotVisits = effectiveVisits.filter((v) => v.date === ds && (v.personId ?? null) === (person?.id ?? null));
                const onLeave = person ? personLeavesOn(leaves, person.id, ds) : [];

                return (
                  <DroppableSlot
                    key={ds}
                    id={slotId(person?.id ?? null, ds)}
                    className={`min-h-[64px] p-1 border-r last:border-r-0 cursor-pointer transition-colors space-y-0.5
                      ${isToday ? "bg-blue-50/40 dark:bg-blue-950/10" : isWeekend ? "bg-gray-50/70 dark:bg-gray-800/20" : "bg-card"}
                      hover:bg-muted/50`}
                    onClick={() => {
                      const params = new URLSearchParams({ date: ds });
                      if (person) params.set("personId", String(person.id));
                      onNavigate(`/jobs/new?${params.toString()}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        const params = new URLSearchParams({ date: ds });
                        if (person) params.set("personId", String(person.id));
                        onNavigate(`/jobs/new?${params.toString()}`);
                      }
                    }}
                  >
                    {onLeave.map((lv) => (
                      <div
                        key={lv.id}
                        className={`w-full rounded px-1 py-0.5 text-[9px] font-medium leading-tight truncate text-white ${leaveBgClass(lv.type)}`}
                        title={`${leaveLabel(lv.type)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {leaveIcon(lv.type)} {leaveLabel(lv.type)}
                      </div>
                    ))}
                    {slotJobs.map((job) => (
                      <DraggableJobChip
                        key={job.id}
                        job={job}
                        onNavigate={onNavigate}
                      />
                    ))}
                    {slotVisits.map((visit) => (
                      <DraggableActivityVisitChip
                        key={`v-${visit.id}`}
                        visit={visit}
                        onNavigate={onNavigate}
                      />
                    ))}
                    <button
                      type="button"
                      className="w-full text-left rounded px-1 py-0.5 text-[9px] text-violet-500 dark:text-violet-400 opacity-0 group-hover:opacity-100 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); onRequestCreateVisit(ds, person?.id ?? null); }}
                      title="Přidat výjezd akce"
                    >
                      ◈+
                    </button>
                  </DroppableSlot>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {draggingJob ? (
          <div
            className={`rounded px-1 py-0.5 text-[10px] font-medium leading-tight truncate shadow-lg ring-2 ring-primary/60 cursor-grabbing select-none ${statusChip(draggingJob.status)}`}
            style={{ minWidth: "80px", maxWidth: "140px" }}
          >
            {truncate(draggingJob.title, 14)}
          </div>
        ) : draggingVisit ? (
          <div
            className={`rounded px-1 py-0.5 text-[10px] font-medium leading-tight truncate shadow-lg ring-2 ring-violet-400/60 cursor-grabbing select-none border-l-2 border-violet-400 ${actVisitChipClass(draggingVisit.status)}`}
            style={{ minWidth: '80px', maxWidth: '140px' }}
          >
            ◈ {truncate(draggingVisit.activityName, 14)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface MonthViewProps {
  jobs: CalendarJob[];
  activityVisits: CalendarActivityVisit[];
  holidays: Map<string, string>;
  monthDate: Date;
  onNavigate: (path: string) => void;
  onRequestCreateVisit: (date: string, personId: number | null) => void;
  onDayClick: (dateStr: string) => void;
}

function MonthView({ jobs, activityVisits, holidays, monthDate, onNavigate, onRequestCreateVisit, onDayClick }: MonthViewProps) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const today = format(new Date(), "yyyy-MM-dd");

  const gridStart = startOfWeek(startOfMonth(monthDate), { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(monthDate), { weekStartsOn: 1 });

  const days: Date[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const DAY_NAMES = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

  return (
    <div>
      <div className="grid grid-cols-7 border-b bg-card text-xs font-medium text-muted-foreground text-center">
        {DAY_NAMES.map((d, i) => (
          <div key={d} className={`py-2 ${i >= 5 ? "text-gray-400" : ""}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 bg-border gap-px">
        {days.map((d) => {
          const ds = format(d, "yyyy-MM-dd");
          const isToday = ds === today;
          const inMonth = isSameMonth(d, monthDate);
          const dow = getDay(d);
          const isWeekend = dow === 0 || dow === 6;
          const holiday = holidays.get(ds);
          const dayJobs = jobsForDay(jobs, ds);
          const dayVisits = activityVisits.filter((v) => v.date === ds);
          const isExpanded = expandedDay === ds;
          const maxVisible = 3;
          const allItems = [...dayJobs.map((j) => ({ type: "job" as const, job: j })), ...dayVisits.map((v) => ({ type: "visit" as const, visit: v }))];
          const visibleItems = isExpanded ? allItems : allItems.slice(0, maxVisible);
          const overflow = allItems.length - maxVisible;

          let cellBg: string;
          if (holiday && inMonth) {
            cellBg = "bg-amber-50 dark:bg-amber-950/20";
          } else if (!inMonth) {
            cellBg = "bg-muted/50 dark:bg-muted/20";
          } else if (isWeekend) {
            cellBg = "bg-gray-50 dark:bg-gray-800/30";
          } else {
            cellBg = "bg-card";
          }

          return (
            <div
              key={ds}
              className={`min-h-[80px] p-1 transition-colors ${cellBg} ${!inMonth ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <div
                  role="button"
                  tabIndex={0}
                  title="Otevřít denní přehled"
                  onClick={() => onDayClick(ds)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onDayClick(ds); }}
                  className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full cursor-pointer hover:ring-2 hover:ring-primary/40 transition-all
                    ${isToday ? "bg-primary text-primary-foreground" : isWeekend ? "text-gray-400" : "text-foreground"}`}
                >
                  {format(d, "d")}
                </div>
                <div className="flex items-center gap-0.5">
                  {holiday && inMonth && (
                    <span className="text-[8px] text-amber-700 dark:text-amber-400 font-medium truncate max-w-[40px]" title={holiday}>
                      {truncate(holiday, 6)}
                    </span>
                  )}
                  <button
                    title="Přidat zakázku"
                    aria-label="Přidat zakázku"
                    onClick={(e) => { e.stopPropagation(); onNavigate(`/jobs/new?date=${ds}`); }}
                    className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="space-y-0.5">
                {visibleItems.map((item) =>
                  item.type === "job" ? (
                    <JobChip key={`j-${item.job.id}`} job={item.job} onNavigate={onNavigate} compact />
                  ) : (
                    <div
                      key={`v-${item.visit.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onNavigate(`/activities/${item.visit.activityId}`); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onNavigate(`/activities/${item.visit.activityId}`); } }}
                      className={`w-full rounded px-1 py-0.5 text-[9px] font-medium leading-tight truncate cursor-pointer border-l-2 border-violet-400 dark:border-violet-600 ${actVisitChipClass(item.visit.status)}`}
                      title={`Akce: ${item.visit.activityName}`}
                    >
                      ◈ {truncate(item.visit.activityName, 12)}
                    </div>
                  )
                )}
                {!isExpanded && overflow > 0 && (
                  <div
                    role="button"
                    tabIndex={0}
                    className="text-[10px] text-primary font-semibold text-center hover:underline"
                    onClick={(e) => { e.stopPropagation(); setExpandedDay(ds); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setExpandedDay(ds); } }}
                  >
                    +{overflow} další
                  </div>
                )}
                {isExpanded && (
                  <div
                    role="button"
                    tabIndex={0}
                    className="text-[10px] text-muted-foreground text-center hover:underline"
                    onClick={(e) => { e.stopPropagation(); setExpandedDay(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setExpandedDay(null); } }}
                  >
                    skrýt
                  </div>
                )}
                {inMonth && (
                  <button
                    type="button"
                    className="w-full text-left text-[9px] text-violet-400 hover:text-violet-600 dark:text-violet-500 dark:hover:text-violet-300 hover:underline transition-colors"
                    onClick={(e) => { e.stopPropagation(); onRequestCreateVisit(ds, null); }}
                    title="Přidat výjezd akce"
                  >
                    ◈+
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOUR_HEIGHT = 56;
const TIMELINE_HOURS = 24;
const DAY_VIEW_START = 6;
const DAY_VIEW_END = 20;

function parseTimeDecimal(t: string): number {
  const parts = t.split(":");
  return Number(parts[0]) + Number(parts[1] ?? 0) / 60;
}

function decimalToTime(h: number): string {
  const clamped = Math.max(0, Math.min(23.75, h));
  const snapped = Math.round(clamped * 4) / 4;
  const hours = Math.floor(snapped);
  const minutes = Math.round((snapped - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function nowOffsetPx(): number | null {
  const now = new Date();
  const decimal = now.getHours() + now.getMinutes() / 60;
  return decimal * HOUR_HEIGHT;
}

interface DraggableDayJobCardProps {
  job: CalendarJob;
  onNavigate: (path: string) => void;
  top: number;
  height: number;
}

function DraggableDayJobCard({ job, onNavigate, top, height }: DraggableDayJobCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `dayjob-${job.id}`,
    data: { job },
  });

  const style: React.CSSProperties = {
    top: `${top}px`,
    height: `${height}px`,
    minHeight: "24px",
    ...(transform ? { transform: CSS.Translate.toString(transform), zIndex: 50 } : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`absolute left-1 right-2 rounded-md px-2 py-1 pointer-events-auto border border-white/20 hover:brightness-95 transition-all touch-none select-none cursor-grab active:cursor-grabbing ${statusChip(job.status)} ${isDragging ? "opacity-40" : ""}`}
      title={`${job.title} · ${job.startTime}${job.endTime ? ` – ${job.endTime}` : ""}`}
      onClick={(e) => { if (!isDragging) { e.stopPropagation(); onNavigate(`/jobs/${job.id}`); } }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(`/jobs/${job.id}`); }}
      role="button"
      tabIndex={0}
    >
      <p className="text-[11px] font-semibold leading-tight truncate">{job.title}</p>
      {height > 36 && job.assignedPersonName && (
        <p className="text-[9px] opacity-70 truncate">{job.assignedPersonName}</p>
      )}
      {height > 24 && (
        <p className="text-[9px] opacity-60">{job.startTime}{job.endTime ? ` – ${job.endTime}` : ""}</p>
      )}
    </div>
  );
}

interface DroppableTimeSlotProps {
  hour: number;
  dateStr: string;
  onNavigate: (path: string) => void;
}

function DroppableTimeSlot({ hour, dateStr, onNavigate }: DroppableTimeSlotProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `timeslot-${hour}` });
  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      className={`flex-1 transition-colors cursor-pointer ${isOver ? "bg-primary/10" : "hover:bg-muted/30"}`}
      onClick={() => onNavigate(`/jobs/new?date=${dateStr}&startTime=${String(hour).padStart(2, "0")}:00`)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(`/jobs/new?date=${dateStr}&startTime=${String(hour).padStart(2, "0")}:00`); }}
      aria-label={`Přidat zakázku v ${String(hour).padStart(2, "0")}:00`}
    />
  );
}

interface DayViewProps {
  jobs: CalendarJob[];
  activityVisits: CalendarActivityVisit[];
  leaves: EmployeeLeave[];
  holidays: Map<string, string>;
  date: Date;
  onNavigate: (path: string) => void;
  onRequestCreateVisit: (date: string, personId: number | null) => void;
}

function DayView({ jobs, activityVisits, leaves, holidays, date, onNavigate, onRequestCreateVisit }: DayViewProps) {
  const ds = format(date, "yyyy-MM-dd");
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const isToday = ds === todayStr;

  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [showFullDay, setShowFullDay] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { startTime: string; endTime: string | null }>
  >(new Map());
  const [draggingJobId, setDraggingJobId] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    const now = new Date();
    let targetHour: number;
    if (isToday) {
      targetHour = Math.max(DAY_VIEW_START, now.getHours() - 1);
    } else {
      targetHour = DAY_VIEW_START;
    }
    const displayStart = showFullDay ? 0 : DAY_VIEW_START;
    const relativeHour = Math.max(0, targetHour - displayStart);
    scrollRef.current.scrollTop = relativeHour * HOUR_HEIGHT;
  }, [ds, showFullDay]);

  const effectiveJobs = useMemo(() => {
    if (optimisticOverrides.size === 0) return jobs;
    return jobs.map((j) => {
      const override = optimisticOverrides.get(j.id);
      if (!override) return j;
      return { ...j, ...override };
    });
  }, [jobs, optimisticOverrides]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const job = event.active.data.current?.job as CalendarJob | undefined;
    if (job) setDraggingJobId(job.id);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingJobId(null);
    const { active, delta } = event;

    const job = active.data.current?.job as CalendarJob | undefined;
    if (!job || !job.startTime) return;

    const originalStartTime = job.startTime;
    const originalEndTime = job.endTime ?? null;

    const startH = parseTimeDecimal(job.startTime);
    const deltaH = delta.y / HOUR_HEIGHT;
    const newStartH = startH + deltaH;
    const newStartTime = decimalToTime(newStartH);

    if (newStartTime === job.startTime) return;

    let newEndTime: string | null = null;
    if (job.endTime) {
      const endH = parseTimeDecimal(job.endTime);
      const duration = endH - startH;
      const snappedStartH = parseTimeDecimal(newStartTime);
      newEndTime = decimalToTime(snappedStartH + duration);
    }

    setOptimisticOverrides((prev) => {
      const next = new Map(prev);
      next.set(job.id, { startTime: newStartTime, endTime: newEndTime });
      return next;
    });

    updateJob.mutate(
      {
        id: job.id,
        data: {
          startTime: newStartTime,
          ...(newEndTime !== null ? { endTime: newEndTime } : {}),
        },
      },
      {
        onSuccess: () => {
          setOptimisticOverrides((prev) => {
            const next = new Map(prev);
            next.delete(job.id);
            return next;
          });
          invalidateData(queryClient, "jobs");
          toast({
            title: "Čas zakázky upraven",
            action: (
              <ToastAction
                altText="Vrátit přesun"
                onClick={() => {
                  updateJob.mutate(
                    {
                      id: job.id,
                      data: {
                        startTime: originalStartTime,
                        ...(originalEndTime !== null ? { endTime: originalEndTime } : {}),
                      },
                    },
                    { onSuccess: () => { invalidateData(queryClient, "jobs"); } },
                  );
                }}
              >
                Vrátit
              </ToastAction>
            ),
          });
        },
        onError: () => {
          setOptimisticOverrides((prev) => {
            const next = new Map(prev);
            next.delete(job.id);
            return next;
          });
          toast({
            title: "Přesun selhal",
            description: "Zkuste to prosím znovu.",
            variant: "destructive",
          });
        },
      },
    );
  }, [updateJob, queryClient, toast]);

  const dayJobs = jobsForDay(effectiveJobs, ds);
  const timedJobs = dayJobs.filter((j) => j.startTime);
  const untimedJobs = dayJobs.filter((j) => !j.startTime);
  const dayLeaves = leaves.filter((l) => l.startDate <= ds && l.endDate >= ds);
  const dayVisits = activityVisits.filter((v) => v.date === ds);
  const holiday = holidays.get(ds);

  const draggingJob = draggingJobId != null
    ? (jobs.find((j) => j.id === draggingJobId) ?? null)
    : null;

  const nowPx = isToday ? nowOffsetPx() : null;

  const displayStart = showFullDay ? 0 : DAY_VIEW_START;
  const displayEnd = showFullDay ? TIMELINE_HOURS : DAY_VIEW_END;
  const displayHours = Array.from({ length: displayEnd - displayStart }, (_, i) => i + displayStart);
  const timelineHeight = (displayEnd - displayStart) * HOUR_HEIGHT;

  const offsetPx = (absoluteHour: number) => (absoluteHour - displayStart) * HOUR_HEIGHT;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="pb-24 md:pb-8">
        {(holiday || dayLeaves.length > 0) && (
          <div className="px-4 pt-3 space-y-2">
            {holiday && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 font-medium">
                🎉 {holiday}
              </div>
            )}
            {dayLeaves.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Palmtree className="w-3.5 h-3.5" /> Dovolené / absence
                </p>
                {dayLeaves.map((lv) => (
                  <div
                    key={lv.id}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white ${leaveBgClass(lv.type)}`}
                  >
                    <span>{leaveIcon(lv.type)}</span>
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold">{lv.personName ?? "—"}</span>
                      <span className="ml-1 opacity-80">{leaveLabel(lv.type)}</span>
                      {lv.note && <span className="ml-1 opacity-70">· {lv.note}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(untimedJobs.length > 0 || dayVisits.length > 0) && (
          <div className="px-4 pt-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground">Bez naplánovaného času</p>
            {untimedJobs.map((job) => (
              <div
                key={job.id}
                role="button"
                tabIndex={0}
                onClick={() => onNavigate(`/jobs/${job.id}`)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(`/jobs/${job.id}`); }}
                className={`rounded-lg px-3 py-2 cursor-pointer border border-transparent hover:border-border/60 transition-colors ${statusChip(job.status)}`}
              >
                <p className="text-xs font-semibold leading-tight">{job.title}</p>
                {job.assignedPersonName && (
                  <p className="text-[10px] opacity-70">{job.assignedPersonName}</p>
                )}
              </div>
            ))}
            {dayVisits.map((visit) => (
              <div
                key={`v-${visit.id}`}
                role="button"
                tabIndex={0}
                onClick={() => onNavigate(`/activities/${visit.activityId}`)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(`/activities/${visit.activityId}`); }}
                className={`rounded-lg px-3 py-2 cursor-pointer border border-violet-200 dark:border-violet-800/50 hover:border-border/60 transition-colors ${actVisitChipClass(visit.status)}`}
              >
                <p className="text-xs font-semibold leading-tight">◈ {visit.activityName}</p>
                {visit.personName && <p className="text-[10px] opacity-70">{visit.personName}</p>}
                {visit.timeFrom && <p className="text-[10px] opacity-60">{visit.timeFrom}{visit.timeTo ? ` – ${visit.timeTo}` : ""}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="px-2 pt-3">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-xs text-muted-foreground">
              {showFullDay ? "Celý den (0:00–24:00)" : `Pracovní čas (${DAY_VIEW_START}:00–${DAY_VIEW_END}:00)`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground"
              onClick={() => setShowFullDay((v) => !v)}
              title={showFullDay ? "Zobrazit pouze pracovní dobu" : "Zobrazit celý den"}
            >
              <ChevronsUpDown className="w-3 h-3" />
              {showFullDay ? "Pracovní čas" : "Celý den"}
            </Button>
          </div>
          <div
            ref={scrollRef}
            className="relative bg-card border rounded-lg overflow-y-auto"
            style={{ height: "min(60vh, 480px)" }}
          >
            <div
              className="relative"
              style={{ height: `${timelineHeight}px` }}
            >
              {displayHours.map((h) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-border/30 flex"
                  style={{ top: `${offsetPx(h)}px`, height: `${HOUR_HEIGHT}px` }}
                >
                  <span className="text-[10px] text-muted-foreground w-10 pt-0.5 pl-1 shrink-0 select-none">
                    {String(h).padStart(2, "0")}:00
                  </span>
                  <DroppableTimeSlot hour={h} dateStr={ds} onNavigate={onNavigate} />
                </div>
              ))}

              {nowPx !== null && nowPx >= offsetPx(displayStart) && nowPx <= offsetPx(displayEnd) && (
                <div
                  className="absolute left-0 right-0 z-20 pointer-events-none"
                  style={{ top: `${nowPx - offsetPx(displayStart)}px` }}
                >
                  <div className="ml-10 h-0.5 bg-red-500/80 relative">
                    <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                  </div>
                </div>
              )}

              <div className="absolute inset-0 pointer-events-none" style={{ left: "40px" }}>
                {timedJobs.map((job) => {
                  const startH = parseTimeDecimal(job.startTime!);
                  if (startH < displayStart || startH >= displayEnd) return null;
                  const endH = job.endTime ? parseTimeDecimal(job.endTime) : startH + 1;
                  const duration = Math.max(0.5, endH - startH);
                  const top = offsetPx(startH);
                  const height = duration * HOUR_HEIGHT - 2;
                  return (
                    <DraggableDayJobCard
                      key={job.id}
                      job={job}
                      onNavigate={onNavigate}
                      top={top}
                      height={height}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {dayJobs.length === 0 && (
          <div className="px-4 pt-4">
            <div className="text-center py-8 border-2 border-dashed rounded-xl border-muted">
              <p className="text-muted-foreground mb-4 text-sm">Žádné zakázky na tento den.</p>
              <Button variant="outline" onClick={() => onNavigate(`/jobs/new?date=${ds}`)}>
                <Plus className="mr-2 h-4 w-4" /> Přidat zakázku
              </Button>
            </div>
          </div>
        )}

        <div className="px-4 pt-3 space-y-2">
          <Button variant="outline" className="w-full" onClick={() => onNavigate(`/jobs/new?date=${ds}`)}>
            <Plus className="mr-2 h-4 w-4" /> Přidat zakázku na tento den
          </Button>
          <Button
            variant="outline"
            className="w-full text-violet-600 border-violet-200 hover:bg-violet-50 dark:text-violet-400 dark:border-violet-800 dark:hover:bg-violet-900/20"
            onClick={() => onRequestCreateVisit(ds, null)}
          >
            <span className="mr-2">◈</span> Přidat výjezd akce
          </Button>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {draggingJob ? (
          <div
            className={`rounded-md px-2 py-1 text-[11px] font-semibold leading-tight truncate shadow-lg ring-2 ring-primary/60 cursor-grabbing select-none ${statusChip(draggingJob.status)}`}
            style={{ minWidth: "100px", maxWidth: "200px" }}
          >
            {truncate(draggingJob.title, 24)}
            <div className="text-[9px] opacity-70 mt-0.5">{draggingJob.startTime}</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function defaultView(): View {
  if (typeof window !== "undefined" && window.innerWidth < 768) return "day";
  return "week";
}

export default function CalendarPage() {
  const [, navigate] = useLocation();
  const search = useSearch();

  const { view, currentDate } = useMemo(() => {
    const params = new URLSearchParams(search);
    const viewParam = params.get("view");
    const dateParam = params.get("date");

    const parsedView: View =
      viewParam === "week" || viewParam === "month" || viewParam === "day"
        ? viewParam
        : defaultView();

    let parsedDate = new Date();
    if (dateParam) {
      const d = parseISO(dateParam);
      if (isValid(d)) parsedDate = d;
    }

    return { view: parsedView, currentDate: parsedDate };
  }, [search]);

  function pushState(newView: View, newDate: Date) {
    const params = new URLSearchParams();
    params.set("view", newView);
    params.set("date", format(newDate, "yyyy-MM-dd"));
    navigate(`/calendar?${params.toString()}`);
  }

  function setView(newView: View) {
    pushState(newView, currentDate);
  }

  function setCurrentDate(newDate: Date) {
    pushState(view, newDate);
  }

  const [createVisitCtx, setCreateVisitCtx] = useState<{ date: string; personId: number | null } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { from, to } = useMemo(() => {
    if (view === "week") {
      const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
      const we = endOfWeek(currentDate, { weekStartsOn: 1 });
      return { from: format(ws, "yyyy-MM-dd"), to: format(we, "yyyy-MM-dd") };
    }
    if (view === "month") {
      const ms = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
      const me = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
      return { from: format(ms, "yyyy-MM-dd"), to: format(me, "yyyy-MM-dd") };
    }
    const ds = format(currentDate, "yyyy-MM-dd");
    return { from: ds, to: ds };
  }, [view, currentDate]);

  const { data: jobs, isError: jobsError, refetch: refetchJobs } = useGetJobsCalendar(
    { from, to },
    { query: { queryKey: getGetJobsCalendarQueryKey({ from, to }) } }
  );

  const { data: activityVisitsData } = useGetActivityVisitsCalendar(
    { from, to },
    { query: { queryKey: getGetActivityVisitsCalendarQueryKey({ from, to }) } }
  );

  const { data: activitiesList } = useListActivities({ archived: false });
  const createActivityVisit = useCreateActivityVisit();

  const handleRequestCreateVisit = (date: string, personId: number | null) => {
    setCreateVisitCtx({ date, personId });
  };

  const handleConfirmCreateVisit = (activityId: number) => {
    if (!createVisitCtx) return;
    createActivityVisit.mutate(
      {
        activityId,
        data: {
          date: createVisitCtx.date,
          personId: createVisitCtx.personId ?? undefined,
        },
      },
      {
        onSuccess: () => {
          setCreateVisitCtx(null);
          invalidateData(queryClient, "activities");
          toast({ title: "Výjezd vytvořen" });
        },
        onError: () => {
          toast({ title: "Nepodařilo se vytvořit výjezd", variant: "destructive" });
        },
      },
    );
  };

  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const { data: leavesData } = useListLeaves(
    { from, to },
    { query: { queryKey: getListLeavesQueryKey({ from, to }) } }
  );

  const startYear = new Date(from).getFullYear();
  const endYear = new Date(to).getFullYear();

  const { data: holidays1 } = useListPublicHolidays(
    { year: startYear },
    { query: { queryKey: getListPublicHolidaysQueryKey({ year: startYear }) } }
  );
  const { data: holidays2 } = useListPublicHolidays(
    { year: endYear },
    { query: { enabled: endYear !== startYear, queryKey: getListPublicHolidaysQueryKey({ year: endYear }) } }
  );

  const holidayMap = useMemo(() => {
    const all = [...(holidays1 ?? []), ...(startYear !== endYear ? (holidays2 ?? []) : [])];
    return new Map(all.map((h) => [h.date, h.name]));
  }, [holidays1, holidays2, startYear, endYear]);

  const safeJobs = jobs ?? [];
  const safeLeaves = leavesData ?? [];
  const safePeople = people ?? [];
  const safeActivityVisits = activityVisitsData ?? [];

  function goBack() {
    if (view === "week") setCurrentDate(subWeeks(currentDate, 1));
    else if (view === "month") setCurrentDate(subMonths(currentDate, 1));
    else setCurrentDate(subDays(currentDate, 1));
  }

  function goForward() {
    if (view === "week") setCurrentDate(addWeeks(currentDate, 1));
    else if (view === "month") setCurrentDate(addMonths(currentDate, 1));
    else setCurrentDate(addDays(currentDate, 1));
  }

  function goToday() {
    setCurrentDate(new Date());
  }

  function handleDayClick(dateStr: string) {
    pushState("day", parseISO(dateStr));
  }

  const headerTitle = useMemo(() => {
    if (view === "week") {
      const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
      const we = endOfWeek(currentDate, { weekStartsOn: 1 });
      if (ws.getMonth() === we.getMonth()) {
        return format(ws, "LLLL yyyy", { locale: cs });
      }
      return `${format(ws, "d. MMM", { locale: cs })} – ${format(we, "d. MMM yyyy", { locale: cs })}`;
    }
    if (view === "month") {
      return format(currentDate, "LLLL yyyy", { locale: cs });
    }
    return format(currentDate, "EEEE d. LLLL yyyy", { locale: cs });
  }, [view, currentDate]);

  const viewSwitcher = (
    <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5">
      <Button
        variant={view === "week" ? "default" : "ghost"}
        size="sm"
        className={`h-7 px-2 text-xs gap-1 ${view === "week" ? "" : "text-muted-foreground"}`}
        onClick={() => setView("week")}
        aria-label="Týdenní pohled"
        title="Týdenní pohled"
      >
        <Rows3 className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Týden</span>
      </Button>
      <Button
        variant={view === "month" ? "default" : "ghost"}
        size="sm"
        className={`h-7 px-2 text-xs gap-1 ${view === "month" ? "" : "text-muted-foreground"}`}
        onClick={() => setView("month")}
        aria-label="Měsíční pohled"
        title="Měsíční pohled"
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Měsíc</span>
      </Button>
      <Button
        variant={view === "day" ? "default" : "ghost"}
        size="sm"
        className={`h-7 px-2 text-xs gap-1 ${view === "day" ? "" : "text-muted-foreground"}`}
        onClick={() => setView("day")}
        aria-label="Denní pohled"
        title="Denní pohled"
      >
        <CalendarDays className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Den</span>
      </Button>
    </div>
  );

  const navButtons = (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={goBack}
        aria-label="Předchozí"
        title="Předchozí"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={goToday} title="Přejít na dnešek">
        Dnes
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={goForward}
        aria-label="Následující"
        title="Následující"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Desktop header — single row */}
      <div className="hidden md:flex p-3 items-center justify-between border-b bg-card z-10 sticky top-0 gap-2">
        <h1 className="text-lg font-bold capitalize leading-tight">{headerTitle}</h1>
        <div className="flex items-center gap-2">
          {viewSwitcher}
          {navButtons}
        </div>
      </div>

      {/* Mobile header — two stable rows */}
      <div className="md:hidden border-b bg-card z-10 sticky top-0">
        <div className="px-3 pt-2 pb-1 flex items-center gap-2">
          <h1 className="text-sm font-bold capitalize leading-tight flex-1 min-w-0 truncate" title={headerTitle}>
            {headerTitle}
          </h1>
          {navButtons}
        </div>
        <div className="px-3 pb-2">
          {viewSwitcher}
        </div>
      </div>

      {jobsError ? (
        <div className="p-4">
          <QueryErrorState title="Nepodařilo se načíst zakázky" onRetry={() => refetchJobs()} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {view === "week" && (
            <WeekView
              jobs={safeJobs}
              activityVisits={safeActivityVisits}
              people={safePeople}
              leaves={safeLeaves}
              holidays={holidayMap}
              weekStart={startOfWeek(currentDate, { weekStartsOn: 1 })}
              onNavigate={navigate}
              onRequestCreateVisit={handleRequestCreateVisit}
            />
          )}
          {view === "month" && (
            <MonthView
              jobs={safeJobs}
              activityVisits={safeActivityVisits}
              holidays={holidayMap}
              monthDate={currentDate}
              onNavigate={navigate}
              onRequestCreateVisit={handleRequestCreateVisit}
              onDayClick={handleDayClick}
            />
          )}
          {view === "day" && (
            <DayView
              jobs={safeJobs}
              activityVisits={safeActivityVisits}
              leaves={safeLeaves}
              holidays={holidayMap}
              date={currentDate}
              onNavigate={navigate}
              onRequestCreateVisit={handleRequestCreateVisit}
            />
          )}
        </div>
      )}

      <CreateActivityVisitDialog
        open={createVisitCtx !== null}
        onOpenChange={(open) => { if (!open) setCreateVisitCtx(null); }}
        date={createVisitCtx?.date ?? ""}
        personId={createVisitCtx?.personId ?? null}
        activities={activitiesList ?? []}
        onConfirm={handleConfirmCreateVisit}
        isLoading={createActivityVisit.isPending}
      />
    </div>
  );
}
