import { Link, useLocation } from "wouter";
import { Home, Calendar, Briefcase, Users, Settings, Plus, Building2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", icon: Home, label: "Dnes", color: "text-amber-500", activeBg: "bg-amber-500 text-white", hoverBg: "hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/30" },
  { href: "/calendar", icon: Calendar, label: "Kalendář", color: "text-blue-500", activeBg: "bg-blue-500 text-white", hoverBg: "hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/30" },
  { href: "/jobs", icon: Briefcase, label: "Zakázky", color: "text-violet-500", activeBg: "bg-violet-500 text-white", hoverBg: "hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-950/30" },
  { href: "/customers", icon: Building2, label: "Zákazníci", color: "text-emerald-500", activeBg: "bg-emerald-500 text-white", hoverBg: "hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30" },
  { href: "/people", icon: Users, label: "Zaměstnanci", color: "text-teal-500", activeBg: "bg-teal-500 text-white", hoverBg: "hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-950/30" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex min-h-[100dvh] w-full bg-background flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-card h-screen sticky top-0">
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold text-primary flex items-center gap-2">
            <Briefcase className="h-6 w-6" /> Stavba
          </h1>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? `${item.activeBg}` : `text-muted-foreground ${item.hoverBg}`
                }`}
              >
                <item.icon className={`h-5 w-5 ${isActive ? "text-white" : item.color}`} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t space-y-1">
          <Link
            href="/admin"
            className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
              location === "/admin"
                ? "bg-rose-600 text-white"
                : "text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
            }`}
          >
            <ShieldAlert className={`h-5 w-5 ${location === "/admin" ? "text-white" : "text-rose-600"}`} />
            Admin
          </Link>
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col pb-16 md:pb-0 relative min-h-[100dvh]">
        {children}

        {/* Global FAB on mobile for fast add */}
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
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-card flex items-center justify-around h-16 px-1 z-40 safe-area-bottom">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-full h-full space-y-0.5 transition-colors ${
                isActive ? item.color : "text-muted-foreground"
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
