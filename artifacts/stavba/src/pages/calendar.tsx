import { useEffect, useState } from "react";
import { format, startOfWeek, addDays, isSameDay, addWeeks, subWeeks } from "date-fns";
import { cs } from "date-fns/locale";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Plus, Timer } from "lucide-react";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { JobCard } from "@/components/job-card";
import { JOB_TYPES } from "@/components/badges";
import { sortJobsDoneLast, isJobFinished } from "@/lib/job-sort";
import { useQuickAddDate } from "@/hooks/use-quick-add-date";
import { Link } from "wouter";

export default function Calendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const { setQuickAddDate } = useQuickAddDate();

  // While the calendar is open, the global "+" FAB should create jobs on the
  // selected day — unless today is selected, where the default (today) applies.
  // Cleared on unmount so every other screen keeps the default behaviour.
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

  const { data: jobs, isError: jobsError, refetch: refetchJobs } = useListJobs(
    { from: format(startDate, "yyyy-MM-dd"), to: format(endDate, "yyyy-MM-dd") },
    { query: { queryKey: getListJobsQueryKey({ from: format(startDate, "yyyy-MM-dd"), to: format(endDate, "yyyy-MM-dd") }) } }
  );

  const selectedDateStr = format(selectedDate, "yyyy-MM-dd");
  const selectedDateJobs = jobsError ? [] : sortJobsDoneLast(jobs?.filter(job => job.date === selectedDateStr) || []);

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
          {weekDays.map(d => (
            <div key={d} className="py-2">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 bg-border gap-px">
          {days.map((d) => {
            const dateStr = format(d, "yyyy-MM-dd");
            const dayJobs = sortJobsDoneLast(jobs?.filter(job => job.date === dateStr) || []);
            const dayHours = dayJobs.reduce((s, j) => s + (j.hoursSpent ? Number(j.hoursSpent) : 0), 0);
            const isSelected = isSameDay(d, selectedDate);
            const dWeekStart = startOfWeek(d, { weekStartsOn: 1 });
            const isCurrentWeek = isSameDay(dWeekStart, todayStart);
            const isToday = isSameDay(d, new Date());

            return (
              <div 
                key={d.toString()} 
                onClick={() => setSelectedDate(d)}
                className={`min-h-[80px] bg-card p-1 cursor-pointer transition-colors
                  ${isCurrentWeek ? 'bg-amber-50 dark:bg-amber-950/20' : ''}
                  ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/5' : 'hover:bg-muted/80'}
                `}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full
                    ${isToday ? 'bg-primary text-primary-foreground' : 'text-foreground'}
                  `}>
                    {format(d, "d")}
                  </div>
                  {dayHours > 0 && (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300"
                      title={`Celkem ${dayHours.toFixed(2)} h`}
                    >
                      {dayHours.toFixed(1)}h
                    </span>
                  )}
                </div>
                
                <div className="space-y-1">
                  {dayJobs.slice(0, 3).map(job => {
                    const colorClass = JOB_TYPES[job.type as keyof typeof JOB_TYPES]?.color || JOB_TYPES.other.color;
                    const bgOnly = colorClass.split(' ')[0];
                    return (
                      <div 
                        key={job.id} 
                        className={`h-1.5 w-full rounded-full ${bgOnly} ${isJobFinished(job.status) ? 'opacity-30' : 'opacity-80'}`}
                        title={job.title}
                      />
                    );
                  })}
                  {dayJobs.length > 3 && (
                    <div className="text-[10px] text-muted-foreground text-center font-bold">
                      +{dayJobs.length - 3}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-4 pb-24 md:pb-8">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h2 className="text-lg font-bold capitalize">
              {format(selectedDate, "EEEE d. MMMM", { locale: cs })}
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
          ) : (
            <div className="text-center py-8 border-2 border-dashed rounded-xl border-muted">
              <p className="text-muted-foreground mb-4">Žádné zakázky na tento den.</p>
              <Link href={`/jobs/new?date=${selectedDateStr}`}>
                <Button variant="outline" className="h-12 px-6">
                  <Plus className="mr-2 h-5 w-5" /> Přidat zakázku
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
