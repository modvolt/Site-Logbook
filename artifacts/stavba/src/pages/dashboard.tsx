import { useGetDashboardSummary, useGetTodayJobs, getGetDashboardSummaryQueryKey, getGetTodayJobsQueryKey } from "@workspace/api-client-react";
import { JobCard } from "@/components/job-card";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, CheckCircle2, Clock, PlayCircle } from "lucide-react";

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() }
  });
  
  const { data: jobs, isLoading: loadingJobs } = useGetTodayJobs({
    query: { queryKey: getGetTodayJobsQueryKey() }
  });

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Today</h1>
      
      {loadingSummary ? (
        <Skeleton className="h-32 w-full mb-8" />
      ) : summary ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <Card className="bg-primary text-primary-foreground border-none">
            <CardContent className="p-4 flex flex-col items-center justify-center">
              <div className="text-3xl font-bold">{summary.todayCount}</div>
              <div className="text-xs font-medium uppercase tracking-wider opacity-80 mt-1">Jobs Today</div>
            </CardContent>
          </Card>
          <Card className="bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
            <CardContent className="p-4 flex flex-col items-center justify-center">
              <PlayCircle className="w-6 h-6 mb-1 opacity-70" />
              <div className="text-xl font-bold">{summary.inProgressCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80">In Progress</div>
            </CardContent>
          </Card>
          <Card className="bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800">
            <CardContent className="p-4 flex flex-col items-center justify-center">
              <Clock className="w-6 h-6 mb-1 opacity-70" />
              <div className="text-xl font-bold">{summary.plannedCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80">Planned</div>
            </CardContent>
          </Card>
          <Card className="bg-green-100 text-green-900 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-800">
            <CardContent className="p-4 flex flex-col items-center justify-center">
              <CheckCircle2 className="w-6 h-6 mb-1 opacity-70" />
              <div className="text-xl font-bold">{summary.doneCount}</div>
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-80">Done</div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex justify-between items-end mb-4">
        <h2 className="text-xl font-bold text-foreground">Your Schedule</h2>
      </div>

      <div className="space-y-4">
        {loadingJobs ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)
        ) : jobs && jobs.length > 0 ? (
          jobs.map(job => <JobCard key={job.id} job={job} />)
        ) : (
          <div className="text-center py-12 px-4 border-2 border-dashed rounded-xl border-muted">
            <Calendar className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-bold mb-1">No jobs today</h3>
            <p className="text-muted-foreground mb-4">Take a break or add a new job to your schedule.</p>
          </div>
        )}
      </div>
      
      {summary && (
        <div className="mt-8 pt-8 border-t">
          <h2 className="text-lg font-bold mb-4 text-muted-foreground">This Week</h2>
          <div className="grid grid-cols-2 gap-4">
            <Card className="bg-muted border-none">
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground font-medium mb-1">Total Hours</div>
                <div className="text-2xl font-bold">{summary.totalHoursThisWeek}h</div>
              </CardContent>
            </Card>
            <Card className="bg-muted border-none">
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground font-medium mb-1">Revenue</div>
                <div className="text-2xl font-bold">${summary.totalRevenueThisWeek.toLocaleString()}</div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
