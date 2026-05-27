import { useState } from "react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { JobCard } from "@/components/job-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_STATUSES, JOB_TYPES } from "@/components/badges";

export default function Jobs() {
  const [status, setStatus] = useState<string>("all");
  
  const { data: jobs, isLoading } = useListJobs(
    status !== "all" ? { status } : {},
    { query: { queryKey: getListJobsQueryKey(status !== "all" ? { status } : {}) } }
  );

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">All Jobs</h1>

      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input placeholder="Search jobs..." className="pl-10 h-12 text-base" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[140px] h-12">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {Object.entries(JOB_STATUSES).map(([key, config]) => (
              <SelectItem key={key} value={key}>{config.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)
        ) : jobs && jobs.length > 0 ? (
          jobs.map(job => <JobCard key={job.id} job={job} />)
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No jobs found matching your criteria.
          </div>
        )}
      </div>
    </div>
  );
}
