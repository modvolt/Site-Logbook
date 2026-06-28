import { useState, useMemo, useCallback } from "react";
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
  isSameDay,
  isSameMonth,
  getDay,
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
  type CalendarJob,
  type EmployeeLeave,
  type Person,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryErrorState } from "@/components/query-error-state";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
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

interface WeekViewProps {
  jobs: CalendarJob[];
  people: Person[];
  leaves: EmployeeLeave[];
  holidays: Map<string, string>;
  weekStart: Date;
  onNavigate: (path: string) => void;
}

function WeekView({ jobs, people, leaves, holidays, weekStart, onNavigate }: WeekViewProps) {
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));
  const dayStrs = days.map((d) => format(d, "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");
  const DAY_NAMES = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { date: string; assignedPersonId: number | null }>
  >(new Map());

  const [draggingJobId, setDraggingJobId] = useState<number | null>(null);

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const job = event.active.data.current?.job as CalendarJob | undefined;
    if (job) setDraggingJobId(job.id);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingJobId(null);
    const { active, over } = event;
    if (!over) return;

    const job = active.data.current?.job as CalendarJob | undefined;
    if (!job) return;

    const target = parseSlotId(String(over.id));
    if (!target) return;

    const sameSlot = job.date === target.dateStr && job.assignedPersonId === target.personId;
    if (sameSlot) return;

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
          toast({ title: "Zakázka přeřazena" });
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
  }, [updateJob, queryClient, toast]);

  const draggingJob = draggingJobId != null
    ? (jobs.find((j) => j.id === draggingJobId) ?? null)
    : null;

  const rows: Array<{ person: Person | null; label: string }> = [
    ...people.map((p) => ({ person: p, label: p.name })),
    { person: null, label: "Nepřiřazeno" },
  ];

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          <div
            className="grid border-b bg-card"
            style={{ gridTemplateColumns: "140px repeat(7, 1fr)" }}
          >
            <div className="px-2 py-2 text-xs font-medium text-muted-foreground border-r" />
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
              <div className="px-2 py-2 border-r bg-muted/30 flex items-start">
                <span className="text-xs font-semibold text-foreground leading-tight break-words">
                  {label}
                </span>
              </div>
              {days.map((d, i) => {
                const ds = dayStrs[i];
                const isToday = ds === today;
                const isWeekend = i >= 5;
                const slotJobs = jobsForSlot(effectiveJobs, person?.id ?? null, ds);
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
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface MonthViewProps {
  jobs: CalendarJob[];
  holidays: Map<string, string>;
  monthDate: Date;
  onNavigate: (path: string) => void;
}

function MonthView({ jobs, holidays, monthDate, onNavigate }: MonthViewProps) {
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
          const isExpanded = expandedDay === ds;
          const maxVisible = 3;
          const visibleJobs = isExpanded ? dayJobs : dayJobs.slice(0, maxVisible);
          const overflow = dayJobs.length - maxVisible;

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
              role="button"
              tabIndex={0}
              onClick={() => {
                if (expandedDay === ds) {
                  setExpandedDay(null);
                  return;
                }
                onNavigate(`/jobs/new?date=${ds}`);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onNavigate(`/jobs/new?date=${ds}`);
              }}
              className={`min-h-[80px] p-1 cursor-pointer transition-colors hover:bg-muted/60 ${cellBg} ${!inMonth ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full
                  ${isToday ? "bg-primary text-primary-foreground" : isWeekend ? "text-gray-400" : "text-foreground"}`}>
                  {format(d, "d")}
                </div>
                {holiday && inMonth && (
                  <span className="text-[8px] text-amber-700 dark:text-amber-400 font-medium truncate max-w-[50px]" title={holiday}>
                    {truncate(holiday, 8)}
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                {visibleJobs.map((job) => (
                  <JobChip key={job.id} job={job} onNavigate={onNavigate} compact />
                ))}
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
}

function DraggableDayJobCard({ job, onNavigate }: DraggableDayJobCardProps) {
  const startH = parseTimeDecimal(job.startTime!);
  const endH = job.endTime ? parseTimeDecimal(job.endTime) : startH + 1;
  const duration = Math.max(0.5, endH - startH);
  const top = startH * HOUR_HEIGHT;
  const height = duration * HOUR_HEIGHT - 2;

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
  leaves: EmployeeLeave[];
  holidays: Map<string, string>;
  date: Date;
  onNavigate: (path: string) => void;
}

function DayView({ jobs, leaves, holidays, date, onNavigate }: DayViewProps) {
  const ds = format(date, "yyyy-MM-dd");
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const isToday = ds === todayStr;

  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { startTime: string; endTime: string | null }>
  >(new Map());
  const [draggingJobId, setDraggingJobId] = useState<number | null>(null);

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const job = event.active.data.current?.job as CalendarJob | undefined;
    if (job) setDraggingJobId(job.id);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingJobId(null);
    const { active, delta } = event;

    const job = active.data.current?.job as CalendarJob | undefined;
    if (!job || !job.startTime) return;

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
          toast({ title: "Čas zakázky upraven" });
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
  const holiday = holidays.get(ds);

  const draggingJob = draggingJobId != null
    ? (jobs.find((j) => j.id === draggingJobId) ?? null)
    : null;

  const nowPx = isToday ? nowOffsetPx() : null;
  const hours = Array.from({ length: TIMELINE_HOURS }, (_, i) => i);

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

        {untimedJobs.length > 0 && (
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
          </div>
        )}

        <div className="px-2 pt-3">
          <div
            className="relative bg-card border rounded-lg overflow-hidden"
            style={{ height: `${TIMELINE_HOURS * HOUR_HEIGHT}px` }}
          >
            {hours.map((h) => (
              <div
                key={h}
                className="absolute left-0 right-0 border-t border-border/30 flex"
                style={{ top: `${h * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
              >
                <span className="text-[10px] text-muted-foreground w-10 pt-0.5 pl-1 shrink-0 select-none">
                  {String(h).padStart(2, "0")}:00
                </span>
                <DroppableTimeSlot hour={h} dateStr={ds} onNavigate={onNavigate} />
              </div>
            ))}

            {nowPx !== null && (
              <div
                className="absolute left-0 right-0 z-20 pointer-events-none"
                style={{ top: `${nowPx}px` }}
              >
                <div className="ml-10 h-0.5 bg-red-500/80 relative">
                  <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                </div>
              </div>
            )}

            <div className="absolute inset-0 pointer-events-none" style={{ left: "40px" }}>
              {timedJobs.map((job) => (
                <DraggableDayJobCard key={job.id} job={job} onNavigate={onNavigate} />
              ))}
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

        <div className="px-4 pt-3">
          <Button variant="outline" className="w-full" onClick={() => onNavigate(`/jobs/new?date=${ds}`)}>
            <Plus className="mr-2 h-4 w-4" /> Přidat zakázku na tento den
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

export default function CalendarPage() {
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) return "day";
    return "week";
  });
  const [currentDate, setCurrentDate] = useState(new Date());

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

  function goBack() {
    if (view === "week") setCurrentDate((d) => subWeeks(d, 1));
    else if (view === "month") setCurrentDate((d) => subMonths(d, 1));
    else setCurrentDate((d) => subDays(d, 1));
  }

  function goForward() {
    if (view === "week") setCurrentDate((d) => addWeeks(d, 1));
    else if (view === "month") setCurrentDate((d) => addMonths(d, 1));
    else setCurrentDate((d) => addDays(d, 1));
  }

  function goToday() {
    setCurrentDate(new Date());
  }

  const headerTitle = useMemo(() => {
    if (view === "week") {
      const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
      const we = endOfWeek(currentDate, { weekStartsOn: 1 });
      if (ws.getMonth() === we.getMonth()) {
        return format(ws, "MMMM yyyy", { locale: cs });
      }
      return `${format(ws, "d. MMM", { locale: cs })} – ${format(we, "d. MMM yyyy", { locale: cs })}`;
    }
    if (view === "month") {
      return format(currentDate, "MMMM yyyy", { locale: cs });
    }
    return format(currentDate, "EEEE d. MMMM yyyy", { locale: cs });
  }, [view, currentDate]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex items-center justify-between border-b bg-card z-10 sticky top-0 gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-bold capitalize leading-tight">{headerTitle}</h1>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5">
            <Button
              variant={view === "week" ? "default" : "ghost"}
              size="sm"
              className={`h-7 px-2 text-xs gap-1 ${view === "week" ? "" : "text-muted-foreground"}`}
              onClick={() => setView("week")}
            >
              <Rows3 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Týden</span>
            </Button>
            <Button
              variant={view === "month" ? "default" : "ghost"}
              size="sm"
              className={`h-7 px-2 text-xs gap-1 ${view === "month" ? "" : "text-muted-foreground"}`}
              onClick={() => setView("month")}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Měsíc</span>
            </Button>
            <Button
              variant={view === "day" ? "default" : "ghost"}
              size="sm"
              className={`h-7 px-2 text-xs gap-1 ${view === "day" ? "" : "text-muted-foreground"}`}
              onClick={() => setView("day")}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Den</span>
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={goBack} title="Zpět">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={goToday}>
              Dnes
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={goForward} title="Vpřed">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
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
              people={safePeople}
              leaves={safeLeaves}
              holidays={holidayMap}
              weekStart={startOfWeek(currentDate, { weekStartsOn: 1 })}
              onNavigate={navigate}
            />
          )}
          {view === "month" && (
            <MonthView
              jobs={safeJobs}
              holidays={holidayMap}
              monthDate={currentDate}
              onNavigate={navigate}
            />
          )}
          {view === "day" && (
            <DayView
              jobs={safeJobs}
              leaves={safeLeaves}
              holidays={holidayMap}
              date={currentDate}
              onNavigate={navigate}
            />
          )}
        </div>
      )}
    </div>
  );
}
