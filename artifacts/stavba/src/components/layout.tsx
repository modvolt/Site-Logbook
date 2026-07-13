import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Briefcase, Plus, LogOut, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useQuickAddDate } from "@/hooks/use-quick-add-date";
import { useLogout, useListClientErrors, getListClientErrorsQueryKey, useGetWatchdogStatus, getGetWatchdogStatusQueryKey } from "@workspace/api-client-react";
import { clearApiCache } from "@/lib/pwa";
import { clearTimerNotification } from "@/lib/timer-notification";
import { useQueryClient } from "@tanstack/react-query";
import { MobileNav } from "@/components/mobile-nav";
import { mainNavItems, adminNavItems, type NavItem } from "@/components/nav-items";

const CLIENT_ERRORS_SEEN_KEY = "stavba.clientErrorsLastSeen";
const CLIENT_ERRORS_PATH = "/admin/client-errors";
const HEALTH_PATH = "/admin/health";
const FALLBACK_HOURS = 24;

function useCrashBadgeCount(enabled: boolean) {
  const [since, setSince] = useState<string>(() => {
    const stored = localStorage.getItem(CLIENT_ERRORS_SEEN_KEY);
    if (stored) return stored;
    return new Date(Date.now() - FALLBACK_HOURS * 60 * 60 * 1000).toISOString();
  });

  const params = useMemo(() => ({ limit: 1, since }), [since]);

  const { data } = useListClientErrors(params, {
    query: {
      queryKey: getListClientErrorsQueryKey(params),
      enabled,
      refetchInterval: 5 * 60 * 1000,
      staleTime: 60 * 1000,
    },
  });

  const markSeen = () => {
    const now = new Date().toISOString();
    localStorage.setItem(CLIENT_ERRORS_SEEN_KEY, now);
    setSince(now);
  };

  return { count: data?.total ?? 0, markSeen };
}

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  master: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  guest: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, role, can, refresh } = useAuth();
  const { quickAddDate } = useQuickAddDate();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const canSeeErrors = can("diagnostics.view");
  const { count: crashCount, markSeen } = useCrashBadgeCount(canSeeErrors);

  const { data: watchdog } = useGetWatchdogStatus({
    query: {
      queryKey: getGetWatchdogStatusQueryKey(),
      enabled: canSeeErrors,
      refetchInterval: 60_000,
      staleTime: 55_000,
    },
  });
  const isDegraded = watchdog?.overallStatus === "degraded";

  useEffect(() => {
    if (location === CLIENT_ERRORS_PATH) markSeen();
  }, [location]);

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.clear();
        void clearApiCache();
        void clearTimerNotification();
        refresh();
      },
    });
  };

  const isActive = (item: NavItem) => (item.match ? item.match(location) : location === item.href);

  return (
    <div className="flex min-h-[100dvh] w-full bg-background flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-card h-screen sticky top-0">
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold text-primary flex items-center gap-2">
            <Briefcase className="h-6 w-6" /> Stavba
          </h1>
          {user && (
            <div className="mt-3 flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{user.name}</p>
                <span className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[0.625rem] font-medium ${ROLE_BADGE[role || "guest"]}`}>
                  {role === "admin" ? "Admin" : role === "master" ? "Master" : "Guest"}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8" title="Odhlásit">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        {/* Single scrollable region holds both the main nav and the admin
            section, so on short screens every item stays reachable via scroll
            and nothing is ever permanently hidden under the viewport edge. */}
        <nav className="flex-1 min-h-0 p-4 space-y-1 overflow-y-auto">
          {mainNavItems
            .filter((item) => !item.requires || can(item.requires))
            .map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                  active ? `${item.activeBg}` : `text-muted-foreground ${item.hoverBg}`
                }`}
              >
                <item.icon className={`h-5 w-5 ${active ? "text-white" : item.color}`} />
                {item.label}
              </Link>
            );
          })}
          {adminNavItems.filter((item) => !item.requires || can(item.requires))
            .length > 0 && (
            <div className="mt-2 pt-2 border-t space-y-1">
              {adminNavItems
                .filter((item) => !item.requires || can(item.requires))
                .map((item) => {
                  const active = isActive(item);
                  const showCrashBadge = item.href === CLIENT_ERRORS_PATH && crashCount > 0;
                  const showHealthBadge = item.href === HEALTH_PATH && isDegraded;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                        active ? item.activeBg : `text-muted-foreground ${item.hoverBg}`
                      }`}
                    >
                      <item.icon className={`h-5 w-5 ${active ? "text-white" : item.color}`} />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                      {showCrashBadge && (
                        <span className={`ml-auto shrink-0 min-w-[1.25rem] h-5 px-1 rounded-full text-[0.65rem] font-semibold flex items-center justify-center ${active ? "bg-white/25 text-white" : "bg-rose-500 text-white"}`}>
                          {crashCount > 99 ? "99+" : crashCount}
                        </span>
                      )}
                      {showHealthBadge && !showCrashBadge && (
                        <span
                          title="Systém je ve stavu selhání"
                          className={`ml-auto shrink-0 w-2.5 h-2.5 rounded-full ${active ? "bg-white/80" : "bg-rose-500"} animate-pulse`}
                        />
                      )}
                    </Link>
                  );
                })}
            </div>
          )}
        </nav>
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden border-b bg-card px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] flex items-center justify-between sticky top-0 z-30">
        <h1 className="text-base font-bold text-primary flex items-center gap-2">
          <Briefcase className="h-5 w-5" /> Stavba
        </h1>
        {user && (
          <div className="flex items-center gap-2 min-w-0">
            <span className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium truncate max-w-[40vw] ${ROLE_BADGE[role || "guest"]}`}>
              {user.name}
            </span>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-10 w-10" aria-label="Odhlásit">
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        )}
      </header>

      {/* Main Content. Bottom padding clears the fixed mobile nav (h-16) plus the
          iOS home-indicator safe area so content is never hidden behind it. */}
      <main className="flex-1 min-w-0 flex flex-col pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0 relative min-h-[100dvh]">
        {role === "guest" && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Eye className="w-3.5 h-3.5" />
            Režim pouze pro čtení — nemůžete vytvářet ani upravovat zakázky.
          </div>
        )}
        {children}

        {/* Global FAB — visible only on dashboard, calendar and jobs list.
            Hidden on /jobs/new (user is already on the form), and on warehouse,
            actions and machines pages where a page-local add button is used. */}
        {can("write") && ["/", "/calendar", "/jobs"].includes(location) && (
          <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] right-4 md:bottom-8 md:right-8 z-50">
            <Link href={quickAddDate ? `/jobs/new?date=${quickAddDate}` : "/jobs/new"}>
              <Button
                size="icon"
                className="h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-shadow bg-primary text-primary-foreground"
                aria-label="Přidat zakázku"
              >
                <Plus className="h-6 w-6" />
              </Button>
            </Link>
          </div>
        )}
      </main>

      {/* Mobile Bottom Nav */}
      <MobileNav location={location} isActive={isActive} can={can} />
    </div>
  );
}
