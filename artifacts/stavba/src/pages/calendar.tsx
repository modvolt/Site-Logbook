import { useEffect, useState } from "react";
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks, getDay } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useListJobs, getListJobsQueryKey,
  useListLeaves, getListLeavesQueryKey,
  useListPublicHolidays, getListPublicHolidaysQueryKey,
  type EmployeeLeave,
} from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Plus, Timer, Palmtree, Stethoscope, Calendar as CalendarIcon } from "lucide-react";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { JobCard } from "@/components/job-card";
import { JOB_TYPES } from "@/components/badges";
import { sortJobsDoneLast, isJobFinished } from "@/lib/job-sort";
import { useQuickAddDate } from "@/hooks/use-quick-add-date";
import { Link } from "wouter";

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function leaveIcon(type: string) {
  if (type === "sick") return "🤒";
  if (type === "other") return "📅";
  return "🏖";
}

function leaveLabel(type: string) {
  if (type === "sick") return "Nemoc";
  if (type === "other") return "Volno";
  return "Dovolená";
}

function leaveBgClass(type: string) {
  if (type === "sick") return "bg-rose-500";
  if (type === "other") return "bg-sky-500";
  return "bg-emerald-500";
}

export default function Calendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const { setQuickAddDate } = useQuickAddDate();

  useEffect(() => {
    setQuickAddDate(
      isSameDay(selectedDate, new Date()) ? null : format(selectedDate, "yyyy-MM-dd"),
    );
    return () => setQuickAddDate(null);
  }, [selectedDate, setQuickAddDate]);

  const currentWeekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const startDate = subWeeks(currentWeekStart, 2);
  const endDate = addDays(addWeeks(currentWeekStart, 3), -1);
  const todayStart = startOfWeek(new Date(), { weekStartsOn: 1 });

  const fromStr = format(startDate, "yyyy-MM-dd");
  const toStr = format(endDate, "yyyy-MM-dd");

  const { data: jobs, isError: jobsError, refetch: refetchJobs } = useListJobs(
    { from: fromStr, to: toStr },
    { query: { queryKey: getListJobsQueryKey({ from: fromStr, to: toStr }) } }
  );

  const { data: leavesData } = useListLeaves(
    { from: fromStr, to: toStr },
    { query: { queryKey: getListLeavesQueryKey({ from: fromStr, to: toStr }) } }
  );

  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();

  const { data: holidays1 } = useListPublicHolidays(
    { year: startYear },
    { query: { queryKey: getListPublicHolidaysQueryKey({ year: startYear }) } }
  );
  const { data: holidays2 } = useListPublicHolidays(
    { year: endYear },
    { query: { enabled: endYear !== startYear, queryKey: getListPublicHolidaysQueryKey({ year: endYear }) } }
  );

  const allHolidays = [
    ...(holidays1 ?? []),
    ...(startYear !== endYear ? (holidays2 ?? []) : []),
  ];
  const holidayMap = new Map(allHolidays.map((h) => [h.date, h.name]));

  const selectedDateStr = format(selectedDate, "yyyy-MM-dd");
  const selectedDateJobs = jobsError ? [] : sortJobsDoneLast(jobs?.filter(job => job.date === selectedDateStr) || []);
  const selectedDateLeaves = (leavesData ?? []).filter(
    (l) => l.startDate <= selectedDateStr && l.endDate >= selectedDateStr,
  );

  const nextWeek = () => setCurrentDate(addWeeks(currentDate, 1));
  const prevWeek = () => setCurrentDate(subWeeks(currentDate, 1));
  const goToday = () => { setCurrentDate(new Date()); setSelectedDate(new Date()); };

  const days: Date[] = [];
  for (let i = 0; i < 35; i++) days.push(addDays(startDate, i));

  const weekDays = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex items-center justify-between border-b bg-card z-10 sticky top-0 md:top-0">
        <div className="flex flex-col">
          <h1 className="text-xl font-bold capitalize leading-tight">
            {format(startDate, "d.M.", { locale: cs })} – {format(endDate, "d.M.yyyy", { locale: cs })}
          </h1>
          <span className="text-xs text-muted-foreground">5 týdnů</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={prevWeek} className="h-10 w-10" title="O týden zpět">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <Button variant="outline" onClick={goToday} className="h-10 px-3 text-sm">
            Dnes
          </Button>
          <Button variant="outline" size="icon" onClick={nextWeek} className="h-10 w-10" title="O týden vpřed">
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-muted/30">
        <div className="grid grid-cols-7 border-b bg-card text-xs font-medium text-muted-foreground text-center">
          {weekDays.map((d, i) => (
            <div
              key={d}
              className={`py-2 ${i >= 5 ? "text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/30" : ""}`}
            >
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 bg-border gap-px">
          {days.map((d) => {
            const dateStr = format(d, "yyyy-MM-dd");
            const dayJobs = sortJobsDoneLast(jobs?.filter(job => job.date === dateStr) || []);
            const dayLeaves = (leavesData ?? []).filter(
              (l) => l.startDate <= dateStr && l.endDate >= dateStr,
            );
            const dayHours = dayJobs.reduce((s, j) => s + (j.hoursSpent ? Number(j.hoursSpent) : 0), 0);
            const isSelected = isSameDay(d, selectedDate);
            const dWeekStart = startOfWeek(d, { weekStartsOn: 1 });
            const isCurrentWeek = isSameDay(dWeekStart, todayStart);
            const isToday = isSameDay(d, new Date());
            const dow = getDay(d); // 0=Sun, 6=Sat
            const isWeekend = dow === 0 || dow === 6;
            const holidayName = holidayMap.get(dateStr) ?? null;
            const isHoliday = holidayName !== null;

            let cellBg: string;
            if (isSelected) {
              cellBg = "ring-2 ring-primary ring-inset bg-primary/5";
            } else if (isHoliday) {
              cellBg = "bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100/80 dark:hover:bg-amber-950/40";
            } else if (isWeekend) {
              cellBg = "bg-gray-100 dark:bg-gray-800/40 hover:bg-gray-200/70 dark:hover:bg-gray-800/70";
            } else if (isCurrentWeek) {
              cellBg = "bg-blue-50/50 dark:bg-blue-950/10 hover:bg-muted/80";
            } else {
              cellBg = "bg-card hover:bg-muted/80";
            }

            const totalItems = dayJobs.length + dayLeaves.length;
            const maxVisible = 3;
            const visibleJobs = dayJobs.slice(0, Math.min(dayJobs.length, maxVisible - Math.min(dayLeaves.length, 1)));
            const visibleLeaves = dayLeaves.slice(0, maxVisible - visibleJobs.length);
            const overflow = totalItems - visibleJobs.length - visibleLeaves.length;

            return (
              <div
                key={d.toString()}
                onClick={() => setSelectedDate(d)}
                className={`min-h-[80px] p-1 cursor-pointer transition-colors ${cellBg}`}
              >
                <div className="flex items-start justify-between mb-0.5">
                  <div className="flex flex-col items-center">
                    <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full
                      ${isToday ? "bg-primary text-primary-foreground" : isWeekend ? "text-gray-500 dark:text-gray-400" : "text-foreground"}
                    `}>
                      {format(d, "d")}
                    </div>
                    {isHoliday && (
                      <span className="text-[8px] leading-tight text-amber-700 dark:text-amber-400 font-medium text-center max-w-[44px] break-words mt-0.5 hidden sm:block">
                        {truncate(holidayName, 14)}
                      </span>
                    )}
                  </div>
                  {dayHours > 0 && (
                    <span
                      className="text-[9px] font-bold px-1 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300 mt-0.5"
                      title={`Celkem ${dayHours.toFixed(2)} h`}
                    >
                      {dayHours.toFixed(1)}h
                    </span>
                  )}
                </div>

                <div className="space-y-0.5 mt-0.5">
                  {visibleJobs.map(job => {
                    const colorClass = JOB_TYPES[job.type as keyof typeof JOB_TYPES]?.color || JOB_TYPES.other.color;
                    const parts = colorClass.split(" ");
                    const bg = parts[0];
                    const textColor = parts[1];
                    return (
                      <div
                        key={job.id}
                        className={`w-full rounded px-1 py-0.5 text-[9px] font-medium leading-tight truncate ${bg} ${textColor} ${isJobFinished(job.status) ? "opacity-30" : "opacity-90"}`}
                        title={job.title}
                      >
                        {truncate(job.title, 18)}
                      </div>
                    );
                  })}
                  {visibleLeaves.map(leave => (
                    <div
                      key={`leave-${leave.id}`}
                      className={`w-full rounded px-1 py-0.5 text-[9px] font-medium leading-tight truncate ${leaveBgClass(leave.type)} text-white`}
                      title={`${leaveLabel(leave.type)}: ${leave.personName}`}
                    >
                      {leaveIcon(leave.type)} {truncate(leave.personName?.split(" ")[0] ?? "—", 10)}
                    </div>
                  ))}
                  {overflow > 0 && (
                    <div className="text-[9px] text-muted-foreground text-center font-bold">
                      +{overflow}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-4 pb-24 md:pb-8">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 className="text-lg font-bold capitalize">
              {format(selectedDate, "EEEE d. MMMM", { locale: cs })}
              {holidayMap.get(selectedDateStr) && (
                <span className="ml-2 text-sm font-normal text-amber-700 dark:text-amber-400">
                  🎉 {holidayMap.get(selectedDateStr)}
                </span>
              )}
            </h2>
            {(() => {
              const total = selectedDateJobs.reduce((s, j) => s + (j.hoursSpent ? Number(j.hoursSpent) : 0), 0);
              if (total <= 0) return null;
              return (
                <span className="inline-flex items-center gap-1 text-sm font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                  <Timer className="w-3.5 h-3.5" /> {total.toFixed(2)} h
                </span>
              );
            })()}
          </div>

          {selectedDateLeaves.length > 0 && (
            <div className="mb-4 space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                <Palmtree className="w-3.5 h-3.5" /> Dovolené / absence
              </h3>
              {selectedDateLeaves.map((leave) => (
                <div
                  key={leave.id}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white ${leaveBgClass(leave.type)}`}
                >
                  <span className="text-base">{leaveIcon(leave.type)}</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold">{leave.personName}</span>
                    <span className="ml-1.5 opacity-80">
                      {leaveLabel(leave.type)}
                      {leave.note && ` · ${leave.note}`}
                    </span>
                  </div>
                  <span className="text-xs opacity-70 whitespace-nowrap">
                    {leave.startDate === leave.endDate
                      ? leave.startDate
                      : `${leave.startDate} – ${leave.endDate}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {jobsError ? (
            <QueryErrorState
              title="Nepodařilo se načíst zakázky"
              onRetry={() => refetchJobs()}
            />
          ) : selectedDateJobs.length > 0 ? (
            <div className="space-y-3">
              {selectedDateJobs.map(job => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          ) : selectedDateLeaves.length === 0 ? (
            <div className="text-center py-8 border-2 border-dashed rounded-xl border-muted">
              <p className="text-muted-foreground mb-4">Žádné zakázky na tento den.</p>
              <Link href={`/jobs/new?date=${selectedDateStr}`}>
                <Button variant="outline" className="h-12 px-6">
                  <Plus className="mr-2 h-5 w-5" /> Přidat zakázku
                </Button>
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
