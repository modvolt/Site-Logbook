import { Link, useLocation } from "wouter";
import { Home, Calendar, Briefcase, Users, Settings, Plus, Building2, ShieldAlert, LogOut, UserCog, Eye, Hammer, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type NavItem = {
  href: string;
  icon: typeof Home;
  label: string;
  color: string;
  activeBg: string;
  hoverBg: string;
  match?: (loc: string) => boolean;
};

const desktopNavItems: NavItem[] = [
  { href: "/", icon: Home, label: "Dnes", color: "text-amber-500", activeBg: "bg-amber-500 text-white", hoverBg: "hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/30" },
  { href: "/calendar", icon: Calendar, label: "Kalendář", color: "text-blue-500", activeBg: "bg-blue-500 text-white", hoverBg: "hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/30" },
  { href: "/jobs", icon: Briefcase, label: "Zakázky", color: "text-violet-500", activeBg: "bg-violet-500 text-white", hoverBg: "hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-950/30" },
  { href: "/activities", icon: Hammer, label: "Dlouhodobé akce", color: "text-orange-500", activeBg: "bg-orange-500 text-white", hoverBg: "hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-950/30", match: (l) => l === "/activities" || l.startsWith("/activities/") },
  { href: "/customers", icon: Building2, label: "Zákazníci", color: "text-emerald-500", activeBg: "bg-emerald-500 text-white", hoverBg: "hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30" },
  { href: "/people", icon: Users, label: "Zaměstnanci", color: "text-teal-500", activeBg: "bg-teal-500 text-white", hoverBg: "hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-950/30" },
  { href: "/me", icon: UserIcon, label: "Můj přehled", color: "text-indigo-500", activeBg: "bg-indigo-500 text-white", hoverBg: "hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950/30" },
];

const mobileNavItems: NavItem[] = [
  { href: "/", icon: Home, label: "Dnes", color: "text-amber-500", activeBg: "", hoverBg: "" },
  { href: "/calendar", icon: Calendar, label: "Kalendář", color: "text-blue-500", activeBg: "", hoverBg: "" },
  { href: "/jobs", icon: Briefcase, label: "Zakázky", color: "text-violet-500", activeBg: "", hoverBg: "" },
  { href: "/activities", icon: Hammer, label: "Akce", color: "text-orange-500", activeBg: "", hoverBg: "", match: (l) => l === "/activities" || l.startsWith("/activities/") },
  { href: "/me", icon: UserIcon, label: "Já", color: "text-indigo-500", activeBg: "", hoverBg: "" },
];

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  master: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  guest: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, role, can, refresh } = useAuth();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.clear();
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
                <span className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${ROLE_BADGE[role || "guest"]}`}>
                  {role === "admin" ? "Admin" : role === "master" ? "Master" : "Guest"}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8" title="Odhlásit">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {desktopNavItems.map((item) => {
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
        </nav>
        <div className="p-4 border-t space-y-1">
          {can("write") && (
            <Link
              href="/admin"
              className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                location === "/admin"
                  ? "bg-rose-600 text-white"
                  : "text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
              }`}
            >
              <ShieldAlert className={`h-5 w-5 ${location === "/admin" ? "text-white" : "text-rose-600"}`} />
              Správa zakázek
            </Link>
          )}
          {can("manageUsers") && (
            <Link
              href="/admin/users"
              className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                location === "/admin/users"
                  ? "bg-rose-600 text-white"
                  : "text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
              }`}
            >
              <UserCog className={`h-5 w-5 ${location === "/admin/users" ? "text-white" : "text-rose-600"}`} />
              Uživatelé
            </Link>
          )}
          <Link
            href="/settings"
            className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
              location === "/settings"
                ? "bg-gray-500 text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Settings className="h-5 w-5" />
            Nastavení
          </Link>
        </div>
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden border-b bg-card px-4 py-2 flex items-center justify-between">
        <h1 className="text-base font-bold text-primary flex items-center gap-2">
          <Briefcase className="h-5 w-5" /> Stavba
        </h1>
        {user && (
          <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ROLE_BADGE[role || "guest"]}`}>
              {user.name}
            </span>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col pb-16 md:pb-0 relative min-h-[100dvh]">
        {role === "guest" && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Eye className="w-3.5 h-3.5" />
            Režim pouze pro čtení — nemůžete vytvářet ani upravovat zakázky.
          </div>
        )}
        {children}

        {/* Global FAB on mobile for fast add (writers only) */}
        {can("write") && (
          <div className="fixed bottom-20 right-4 md:bottom-8 md:right-8 z-50">
            <Link href="/jobs/new">
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
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-card flex items-center justify-around h-16 px-1 z-40 safe-area-bottom">
        {mobileNavItems.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-full h-full space-y-0.5 transition-colors ${
                active ? item.color : "text-muted-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-tight">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
