import {
  Home, Calendar, Briefcase, Users, Settings, Building2, ShieldAlert,
  UserCog, Hammer, User as UserIcon, Package, Wrench, ScrollText,
  ShieldCheck, KeyRound, BarChart3, Receipt, Bug, Activity, FolderKanban, CircuitBoard,
} from "lucide-react";
import type { Permission } from "@/hooks/use-auth";

export type NavItem = {
  href: string;
  icon: typeof Home;
  label: string;
  /** Shorter label used in tight spaces (mobile bottom bar / grid). */
  shortLabel?: string;
  color: string;
  activeBg: string;
  hoverBg: string;
  match?: (loc: string) => boolean;
  requires?: Permission | "write" | "manageUsers";
};

/** Primary destinations — shown in the desktop sidebar and mobile menu. */
export const mainNavItems: NavItem[] = [
  { href: "/", icon: Home, label: "Dnes", color: "text-amber-500", activeBg: "bg-amber-500 text-white", hoverBg: "hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/30" },
  { href: "/calendar", icon: Calendar, label: "Kalendář", color: "text-blue-500", activeBg: "bg-blue-500 text-white", hoverBg: "hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/30" },
  { href: "/jobs", icon: Briefcase, label: "Zakázky", color: "text-violet-500", activeBg: "bg-violet-500 text-white", hoverBg: "hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-950/30", requires: "jobs.view" },
  { href: "/switchboards", icon: CircuitBoard, label: "Rozvaděče", color: "text-cyan-600", activeBg: "bg-cyan-600 text-white", hoverBg: "hover:bg-cyan-50 hover:text-cyan-700 dark:hover:bg-cyan-950/30", requires: "switchboards.view", match: (l) => l === "/switchboards" || l.startsWith("/switchboards/") },
  { href: "/job-groups", icon: FolderKanban, label: "Akce zakázek", shortLabel: "Skupiny", color: "text-fuchsia-500", activeBg: "bg-fuchsia-500 text-white", hoverBg: "hover:bg-fuchsia-50 hover:text-fuchsia-600 dark:hover:bg-fuchsia-950/30", requires: "jobs.view", match: (l) => l === "/job-groups" || l.startsWith("/job-groups/") },
  { href: "/activities", icon: Hammer, label: "Dlouhodobé akce", shortLabel: "Akce", color: "text-orange-500", activeBg: "bg-orange-500 text-white", hoverBg: "hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-950/30", requires: "activities.view", match: (l) => l === "/activities" || l.startsWith("/activities/") },
  { href: "/customers", icon: Building2, label: "Zákazníci", color: "text-emerald-500", activeBg: "bg-emerald-500 text-white", hoverBg: "hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30", requires: "customers.view" },
  { href: "/pristupove-udaje", icon: KeyRound, label: "Přístupové údaje", shortLabel: "Přístupy", color: "text-rose-500", activeBg: "bg-rose-500 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "credentials.view", match: (l) => l === "/pristupove-udaje" || l.startsWith("/pristupove-udaje/") },
  { href: "/people", icon: Users, label: "Zaměstnanci", shortLabel: "Lidé", color: "text-teal-500", activeBg: "bg-teal-500 text-white", hoverBg: "hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-950/30", requires: "people.view" },
  { href: "/sklad", icon: Package, label: "Sklad", color: "text-cyan-500", activeBg: "bg-cyan-500 text-white", hoverBg: "hover:bg-cyan-50 hover:text-cyan-600 dark:hover:bg-cyan-950/30", requires: "warehouse.view" },
  { href: "/stroje", icon: Wrench, label: "Stroje", color: "text-slate-500", activeBg: "bg-slate-500 text-white", hoverBg: "hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800/40", requires: "machines.view", match: (l) => l === "/stroje" || l.startsWith("/stroje/") },
  { href: "/me", icon: UserIcon, label: "Můj přehled", shortLabel: "Já", color: "text-indigo-500", activeBg: "bg-indigo-500 text-white", hoverBg: "hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950/30" },
];

/** Secondary / admin destinations — desktop footer section and mobile menu. */
export const adminNavItems: NavItem[] = [
  { href: "/admin", icon: ShieldAlert, label: "Správa zakázek", shortLabel: "Správa", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "jobs.manage" },
  { href: "/billing", icon: Receipt, label: "Fakturace", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "billing.view", match: (l) => l === "/billing" || l.startsWith("/billing/") },
  { href: "/statistika", icon: BarChart3, label: "Statistika", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "statistics.view" },
  { href: "/admin/users", icon: UserCog, label: "Uživatelé", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "users.manage" },
  { href: "/admin/audit", icon: ScrollText, label: "Záznam změn", shortLabel: "Záznam", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "audit.view" },
  { href: "/admin/client-errors", icon: Bug, label: "Frontend chyby", shortLabel: "Chyby", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "diagnostics.view" },
  { href: "/admin/gdpr", icon: ShieldCheck, label: "GDPR", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "settings.manage" },
  { href: "/admin/health", icon: Activity, label: "Diagnostika", color: "text-rose-600", activeBg: "bg-rose-600 text-white", hoverBg: "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30", requires: "diagnostics.view" },
  { href: "/settings", icon: Settings, label: "Nastavení", color: "text-gray-500", activeBg: "bg-gray-500 text-white", hoverBg: "hover:bg-muted hover:text-foreground", requires: "settings.view" },
];

/** All destinations available in the mobile menu, in display order. */
export const mobileMenuItems: NavItem[] = [...mainNavItems, ...adminNavItems];

/** Default quick items pinned to the mobile bottom bar. */
export const MOBILE_DEFAULT_QUICK = ["/", "/calendar", "/jobs", "/sklad"];

/**
 * Default quick items for users with the manager/admin role.
 * Billing is included so it's immediately accessible without customisation.
 */
export const MOBILE_DEFAULT_QUICK_MANAGER = ["/", "/billing", "/jobs", "/sklad"];

/** Max number of pinned quick items on the mobile bottom bar (excl. "Další"). */
export const MOBILE_QUICK_MAX = 4;

export const MOBILE_QUICK_STORAGE_KEY = "stavba.mobileQuickNav";
