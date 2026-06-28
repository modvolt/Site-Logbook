import { Link } from "wouter";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useGetMyStats, useGetMyDoneJobs, useListActivities, getListActivitiesQueryKey,
  useGetMyVisits,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  User as UserIcon, Clock, Hammer, Briefcase, CheckCircle2, ChevronRight,
  Settings, ShieldAlert, UserCog, LogOut, Building2, Users, CalendarPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useLogout } from "@workspace/api-client-react";
import { clearApiCache } from "@/lib/pwa";
import { useQueryClient } from "@tanstack/react-query";

function fmtH(n: number | null | undefined) {
  if (n == null) return "0 h";
  return `${Math.round(Number(n) * 10) / 10} h`;
}

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string; sub?: string; icon: typeof Clock; color: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${color}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
            <div className="text-xl font-bold">{value}</div>
            {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MyOverview() {
  const { user, role, can, refresh } = useAuth();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => { queryClient.clear(); void clearApiCache(); refresh(); },
    });
  };

  const { data: stats, isLoading: statsLoading } = useGetMyStats();
  const { data: myJobs } = useGetMyDoneJobs({ limit: 20 });
  const { data: myVisits } = useGetMyVisits();
  const mineParams = { mine: true, archived: false };
  const { data: myActivities } = useListActivities(mineParams, {
    query: { queryKey: getListActivitiesQueryKey(mineParams) },
  });

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          <UserIcon className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold">{user?.name ?? "Můj přehled"}</h1>
          <p className="text-xs text-muted-foreground">
            {role === "admin" ? "Administrátor" : role === "master" ? "Master" : "Guest"}
          </p>
        </div>
      </div>

      {statsLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : stats ? (
        <>
          <div>
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">Moje dlouhodobé akce</h2>
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Tento týden"
                value={fmtH(stats.activityHoursWeek)}
                icon={Clock}
                color="bg-orange-500"
              />
              <StatCard
                label="Tento měsíc"
                value={fmtH(stats.activityHoursMonth)}
                icon={Hammer}
                color="bg-amber-500"
              />
              <StatCard
                label="Celkem"
                value={fmtH(stats.activityHoursAll)}
                sub={`${stats.activitiesActiveCount} aktivních`}
                icon={Clock}
                color="bg-emerald-500"
              />
              <StatCard
                label="Otevřené akce"
                value={String(stats.activitiesActiveCount)}
                icon={Hammer}
                color="bg-violet-500"
              />
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">Zakázky (celý tým)</h2>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Tento týden" value={fmtH(stats.jobHoursWeek)} icon={Briefcase} color="bg-blue-500" />
              <StatCard label="Tento měsíc" value={fmtH(stats.jobHoursMonth)} icon={Briefcase} color="bg-sky-500" />
              <StatCard label="Hodiny celkem" value={fmtH(stats.jobHoursAll)} icon={Clock} color="bg-teal-500" />
              <StatCard label="Hotové zakázky" value={String(stats.jobsDoneCount)} icon={CheckCircle2} color="bg-green-500" />
            </div>
          </div>
        </>
      ) : null}

      {/* My planned site visits */}
      {myVisits && myVisits.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 text-violet-500" /> Moje plánované výjezdy
            </h2>
            <ul className="divide-y">
              {myVisits.map((v) => {
                const isActivity = v.kind === "activity";
                const href = isActivity ? `/activities/${v.parentId}` : `/jobs/${v.parentId}`;
                return (
                  <li key={`${v.kind}-${v.id}`}>
                    <Link
                      href={href}
                      className="flex items-center justify-between gap-2 py-2 hover:bg-muted/40 -mx-2 px-2 rounded"
                    >
                      <div className="min-w-0 flex items-start gap-2">
                        <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${isActivity ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"}`}>
                          {isActivity ? "Akce" : "Zakázka"}
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{v.parentName ?? (isActivity ? "Akce" : "Zakázka")}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {format(new Date(v.date), "EEEE d. M. yyyy", { locale: cs })}
                            {v.clientSite && ` · ${v.clientSite}`}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            <span className="inline-block rounded bg-muted px-1.5 py-0.5 font-medium capitalize">{v.status}</span>
                          </div>
                          {v.note && (
                            <div className="text-xs text-muted-foreground truncate mt-0.5">{v.note}</div>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* My recent activities */}
      {myActivities && myActivities.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              <Hammer className="h-4 w-4 text-orange-500" /> Moje aktivní akce
            </h2>
            <ul className="divide-y">
              {myActivities.slice(0, 8).map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/activities/${a.id}`}
                    className="flex items-center justify-between gap-2 py-2 hover:bg-muted/40 -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{fmtH(a.hoursSpent)}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Recent done jobs */}
      {myJobs && myJobs.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" /> Hotové zakázky
            </h2>
            <ul className="divide-y">
              {myJobs.slice(0, 15).map((j) => (
                <li key={j.id}>
                  <Link
                    href={`/jobs/${j.id}`}
                    className="flex items-center justify-between gap-2 py-2 hover:bg-muted/40 -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{j.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {format(new Date(j.date), "d. M. yyyy", { locale: cs })}
                        {j.clientSite && ` · ${j.clientSite}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {j.hoursSpent != null && (
                        <span className="text-xs text-muted-foreground">{fmtH(j.hoursSpent)}</span>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Quick links (mobile-only utility menu) */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <Link href="/customers" className="flex items-center gap-3 px-3 py-3 rounded hover:bg-muted">
            <Building2 className="h-5 w-5 text-emerald-500" /> <span className="text-sm">Zákazníci</span>
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </Link>
          <Link href="/people" className="flex items-center gap-3 px-3 py-3 rounded hover:bg-muted">
            <Users className="h-5 w-5 text-teal-500" /> <span className="text-sm">Zaměstnanci</span>
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </Link>
          {can("write") && (
            <Link href="/admin" className="flex items-center gap-3 px-3 py-3 rounded hover:bg-muted">
              <ShieldAlert className="h-5 w-5 text-rose-500" /> <span className="text-sm">Správa zakázek</span>
              <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </Link>
          )}
          {can("manageUsers") && (
            <Link href="/admin/users" className="flex items-center gap-3 px-3 py-3 rounded hover:bg-muted">
              <UserCog className="h-5 w-5 text-rose-500" /> <span className="text-sm">Uživatelé</span>
              <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </Link>
          )}
          <Link href="/settings" className="flex items-center gap-3 px-3 py-3 rounded hover:bg-muted">
            <Settings className="h-5 w-5" /> <span className="text-sm">Nastavení</span>
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </Link>
          <button onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-3 rounded hover:bg-muted text-left">
            <LogOut className="h-5 w-5" /> <span className="text-sm">Odhlásit se</span>
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
