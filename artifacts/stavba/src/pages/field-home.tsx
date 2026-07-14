import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetTodayJobs, getGetTodayJobsQueryKey } from "@workspace/api-client-react";
import { Calendar, Camera, CheckCircle2, ChevronRight, Clock, MapPin, Navigation, RefreshCw, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";

export default function FieldHome() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: jobs, isLoading, isError, refetch } = useGetTodayJobs({
    query: { queryKey: getGetTodayJobsQueryKey() },
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetTodayJobsQueryKey() });
  };

  return (
    <main className="mx-auto w-full max-w-3xl p-4 pb-24 md:p-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dnešní práce</h1>
          <p className="text-sm text-muted-foreground">{user?.name}</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => void refresh()} aria-label="Obnovit dnešní práci">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {user?.personId == null && (
        <div className="mb-4 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Účet není propojený se zaměstnancem. Správce musí doplnit zaměstnance v nastavení uživatele.
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((item) => <Skeleton key={item} className="h-56 w-full" />)}
        </div>
      ) : isError ? (
        <div className="border p-5 text-center">
          <p className="mb-3 text-sm text-muted-foreground">Dnešní zakázky se nepodařilo načíst.</p>
          <Button variant="outline" onClick={() => void refetch()}>Zkusit znovu</Button>
        </div>
      ) : jobs && jobs.length > 0 ? (
        <div className="space-y-3" data-testid="field-today-jobs">
          {jobs.map((job) => {
            const tasksDone = job.taskDoneCount ?? 0;
            const tasksTotal = job.taskCount ?? 0;
            return (
              <Card key={job.id} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-muted-foreground">#{job.jobNumber}</div>
                        <h2 className="text-lg font-bold leading-tight">{job.title}</h2>
                      </div>
                      {(job.startTime || job.endTime) && (
                        <div className="shrink-0 text-right text-sm font-semibold">
                          <Clock className="mr-1 inline h-4 w-4" />
                          {job.startTime ?? "--:--"}{job.endTime ? ` - ${job.endTime}` : ""}
                        </div>
                      )}
                    </div>

                    {job.clientSite && (
                      <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4 shrink-0" />
                        <span>{job.clientSite}</span>
                      </div>
                    )}
                    {job.address && (
                      <a
                        href={`https://waze.com/ul?q=${encodeURIComponent(job.address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mb-3 flex items-center gap-2 text-sm font-medium text-blue-600 hover:underline"
                      >
                        <Navigation className="h-4 w-4 shrink-0" />
                        <span className="truncate">{job.address}</span>
                      </a>
                    )}

                    <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
                      <div>
                        <CheckCircle2 className="mx-auto mb-1 h-4 w-4 text-green-600" />
                        <div className="text-sm font-semibold">{tasksDone}/{tasksTotal}</div>
                        <div className="text-[11px] text-muted-foreground">Úkoly</div>
                      </div>
                      <div>
                        <ShoppingCart className="mx-auto mb-1 h-4 w-4 text-amber-600" />
                        <div className="text-sm font-semibold">{job.consumedMaterialCount ?? 0}/{job.materialCount ?? 0}</div>
                        <div className="text-[11px] text-muted-foreground">Materiál</div>
                      </div>
                      <div>
                        <Camera className="mx-auto mb-1 h-4 w-4 text-blue-600" />
                        <div className="text-sm font-semibold">{job.attachmentCount ?? 0}</div>
                        <div className="text-[11px] text-muted-foreground">Přílohy</div>
                      </div>
                    </div>
                  </div>
                  <Link href={`/jobs/${job.id}`} className="flex h-12 items-center justify-center gap-2 border-t bg-primary font-semibold text-primary-foreground hover:bg-primary/90">
                    Otevřít práci <ChevronRight className="h-4 w-4" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="border-2 border-dashed p-8 text-center text-muted-foreground">
          <Calendar className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="font-medium text-foreground">Dnes nemáte přiřazenou zakázku</p>
        </div>
      )}
    </main>
  );
}
