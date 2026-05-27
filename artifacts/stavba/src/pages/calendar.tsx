import { useState } from "react";
import { format, startOfWeek, addDays, startOfMonth, endOfMonth, endOfWeek, isSameMonth, isSameDay, parseISO, addMonths, subMonths } from "date-fns";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JobCard } from "@/components/job-card";
import { JOB_TYPES } from "@/components/badges";
import { Link } from "wouter";

export default function Calendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const { data: jobs } = useListJobs(
    { from: format(startDate, "yyyy-MM-dd"), to: format(endDate, "yyyy-MM-dd") },
    { query: { queryKey: getListJobsQueryKey({ from: format(startDate, "yyyy-MM-dd"), to: format(endDate, "yyyy-MM-dd") }) } }
  );

  const selectedDateStr = format(selectedDate, "yyyy-MM-dd");
  const selectedDateJobs = jobs?.filter(job => job.date === selectedDateStr) || [];

  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));

  // Generate calendar days
  const days = [];
  let day = startDate;
  while (day <= endDate) {
    days.push(day);
    day = addDays(day, 1);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex items-center justify-between border-b bg-card z-10 sticky top-0 md:top-0">
        <h1 className="text-xl font-bold">{format(currentDate, "MMMM yyyy")}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={prevMonth} className="h-10 w-10">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <Button variant="outline" size="icon" onClick={nextMonth} className="h-10 w-10">
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-muted/30">
        <div className="grid grid-cols-7 border-b bg-card text-xs font-medium text-muted-foreground text-center">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
            <div key={d} className="py-2">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 bg-border gap-px">
          {days.map((day, i) => {
            const dateStr = format(day, "yyyy-MM-dd");
            const dayJobs = jobs?.filter(job => job.date === dateStr) || [];
            const isSelected = isSameDay(day, selectedDate);
            const isCurrentMonth = isSameMonth(day, monthStart);
            const isToday = isSameDay(day, new Date());

            return (
              <div 
                key={day.toString()} 
                onClick={() => setSelectedDate(day)}
                className={`min-h-[80px] bg-card p-1 cursor-pointer transition-colors
                  ${!isCurrentMonth ? 'opacity-50 bg-muted/50' : ''}
                  ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/5' : 'hover:bg-muted/80'}
                `}
              >
                <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full mb-1
                  ${isToday ? 'bg-primary text-primary-foreground' : 'text-foreground'}
                `}>
                  {format(day, "d")}
                </div>
                
                <div className="space-y-1">
                  {dayJobs.slice(0, 3).map(job => {
                    const colorClass = JOB_TYPES[job.type as keyof typeof JOB_TYPES]?.color || JOB_TYPES.other.color;
                    const bgOnly = colorClass.split(' ')[0]; // Extract just the bg class
                    return (
                      <div 
                        key={job.id} 
                        className={`h-1.5 w-full rounded-full ${bgOnly} opacity-80`}
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
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">
              {format(selectedDate, "EEEE, MMMM d")}
            </h2>
          </div>

          {selectedDateJobs.length > 0 ? (
            <div className="space-y-3">
              {selectedDateJobs.map(job => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 border-2 border-dashed rounded-xl border-muted">
              <p className="text-muted-foreground mb-4">No jobs scheduled.</p>
              <Link href={`/jobs/new?date=${selectedDateStr}`}>
                <Button variant="outline" className="h-12 px-6">
                  <Plus className="mr-2 h-5 w-5" /> Add Job
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
