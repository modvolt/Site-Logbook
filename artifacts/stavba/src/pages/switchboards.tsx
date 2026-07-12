import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CircuitBoard, ChevronRight, MapPin } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SWITCHBOARD_STATUS_LABELS, switchboardFetch, type Switchboard } from "@/lib/switchboards-api";

export default function Switchboards() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["switchboards"],
    queryFn: () => switchboardFetch<Switchboard[]>("/api/switchboards"),
  });
  return (
    <div className="max-w-5xl mx-auto w-full p-4 md:p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold flex items-center gap-2"><CircuitBoard className="h-6 w-6 text-cyan-600" />Rozvaděče</h1>
        <p className="text-sm text-muted-foreground mt-1">Výroba, kontroly, měření a dokumentace rozvaděčů.</p>
      </div>
      {isLoading && <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
      {error && <div className="border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error.message}</div>}
      {!isLoading && !error && data.length === 0 && (
        <div className="border border-dashed p-10 text-center text-sm text-muted-foreground">První rozvaděč založte v detailu konkrétní zakázky.</div>
      )}
      <div className="border-y divide-y bg-card">
        {data.map((board) => (
          <Link key={board.id} href={`/switchboards/${board.id}`} className="flex items-center gap-4 p-4 hover:bg-muted/60">
            <div className="h-11 w-11 shrink-0 grid place-items-center rounded-md border bg-cyan-50 text-cyan-700 dark:bg-cyan-950/30"><CircuitBoard className="h-6 w-6" /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{board.designation} <span className="font-normal text-muted-foreground">{board.internalName}</span></div>
              <div className="text-xs text-muted-foreground flex gap-3 flex-wrap mt-1">
                <span>Zakázka {board.job?.jobNumber ? `#${board.job.jobNumber}` : `#${board.jobId}`}: {board.job?.title}</span>
                {board.installationLocation && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{board.installationLocation}</span>}
                <span>{SWITCHBOARD_STATUS_LABELS[board.status] ?? board.status}</span>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}
