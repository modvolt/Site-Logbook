import { useState } from "react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { JobCard } from "@/components/job-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_STATUSES } from "@/components/badges";

export default function Jobs() {
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");
  
  const { data: jobs, isLoading } = useListJobs(
    status !== "all" ? { status } : {},
    { query: { queryKey: getListJobsQueryKey(status !== "all" ? { status } : {}) } }
  );

  const filtered = jobs?.filter(j =>
    j.title.toLowerCase().includes(search.toLowerCase()) ||
    (j.clientSite || "").toLowerCase().includes(search.toLowerCase()) ||
    (j.customerCompanyName || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Všechny zakázky</h1>

      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Hledat zakázky..."
            className="pl-10 h-12 text-base"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px] h-12">
            <SelectValue placeholder="Stav" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Vše</SelectItem>
            {Object.entries(JOB_STATUSES).map(([key, config]) => (
              <SelectItem key={key} value={key}>{config.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)
        ) : filtered && filtered.length > 0 ? (
          filtered.map(job => <JobCard key={job.id} job={job} />)
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <p>Žádné zakázky odpovídající vašemu hledání.</p>
          </div>
        )}
      </div>
    </div>
  );
}
