import { useEffect, useState } from "react";
import { Link } from "wouter";
import { MoreHorizontal, Star, SlidersHorizontal, Check } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import {
  mobileMenuItems,
  MOBILE_DEFAULT_QUICK,
  MOBILE_DEFAULT_QUICK_MANAGER,
  MOBILE_QUICK_MAX,
  MOBILE_QUICK_STORAGE_KEY,
  type NavItem,
} from "@/components/nav-items";
import type { Permission } from "@/hooks/use-auth";

function loadQuick(): string[] {
  try {
    const raw = localStorage.getItem(MOBILE_QUICK_STORAGE_KEY);
    if (!raw) return MOBILE_DEFAULT_QUICK;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* ignore malformed storage */
  }
  return MOBILE_DEFAULT_QUICK;
}

/**
 * Reduce a raw list of hrefs to a valid quick-bar config: only currently
 * available destinations, de-duplicated, capped at MOBILE_QUICK_MAX. Falls back
 * to the (available) defaults so the bar never degrades to an unusable state.
 */
function normalizeQuick(quick: string[], availableHrefs: Set<string>, defaults: string[] = MOBILE_DEFAULT_QUICK): string[] {
  const out: string[] = [];
  for (const href of quick) {
    if (availableHrefs.has(href) && !out.includes(href)) out.push(href);
    if (out.length >= MOBILE_QUICK_MAX) break;
  }
  if (out.length === 0) {
    for (const href of defaults) {
      if (availableHrefs.has(href) && !out.includes(href)) out.push(href);
      if (out.length >= MOBILE_QUICK_MAX) break;
    }
  }
  return out;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

type Props = {
  location: string;
  isActive: (item: NavItem) => boolean;
  can: (action: Permission | "write" | "manageUsers") => boolean;
};

export function MobileNav({ location, isActive, can }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [quick, setQuick] = useState<string[]>(loadQuick);

  const available = mobileMenuItems.filter((i) => !i.requires || can(i.requires));
  const availableHrefs = new Set(available.map((i) => i.href));
  const availableKey = available.map((i) => i.href).join(",");

  const isManager = can("billing.view");
  const roleDefaults = isManager ? MOBILE_DEFAULT_QUICK_MANAGER : MOBILE_DEFAULT_QUICK;

  // Drop stale/unauthorized/duplicate hrefs whenever the available set changes
  // (e.g. role change), so the quick bar always reflects a valid, capped config.
  // Manager users get billing included in the defaults so it's accessible without
  // any customisation (they can still override via Přizpůsobit).
  useEffect(() => {
    setQuick((prev) => {
      const next = normalizeQuick(prev, availableHrefs, roleDefaults);
      return sameOrder(prev, next) ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey, isManager]);

  // Persist the normalized config.
  useEffect(() => {
    try {
      localStorage.setItem(MOBILE_QUICK_STORAGE_KEY, JSON.stringify(quick));
    } catch {
      /* ignore storage failures (private mode, quota) */
    }
  }, [quick]);

  // Resolve pinned quick items to actual (permitted) destinations, keeping order.
  const quickItems = quick
    .map((href) => available.find((i) => i.href === href))
    .filter((i): i is NavItem => Boolean(i))
    .slice(0, MOBILE_QUICK_MAX);

  const toggleQuick = (href: string) => {
    setQuick((prev) => {
      const base = normalizeQuick(prev, availableHrefs, roleDefaults);
      if (base.includes(href)) return base.filter((h) => h !== href);
      if (base.length >= MOBILE_QUICK_MAX) return base;
      return [...base, href];
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setEditing(false);
  };

  const moreActive = open || !quickItems.some(isActive);

  return (
    <>
      {/* Bottom bar height + icons + labels are rem-based, so they scale with
          the chosen "Velikost zobrazení" (UI zoom) like the rest of the app.
          The safe-area inset stays in px (device-fixed). min-w-0 + truncate on
          each cell keep the (now scalable) labels from overflowing at the
          largest zoom on narrow phones. */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-card flex items-center justify-around h-[calc(4rem+env(safe-area-inset-bottom,0px))] pb-[env(safe-area-inset-bottom,0px)] px-1 z-40">
        {quickItems.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-full min-w-0 h-full space-y-0.5 transition-colors ${
                active ? item.color : "text-muted-foreground"
              }`}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <span className="text-[0.5625rem] font-medium leading-tight max-w-full truncate px-0.5">
                {item.shortLabel ?? item.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex flex-col items-center justify-center w-full min-w-0 h-full space-y-0.5 transition-colors ${
            moreActive ? "text-primary" : "text-muted-foreground"
          }`}
          aria-label="Další položky"
        >
          <MoreHorizontal className="h-5 w-5 shrink-0" />
          <span className="text-[0.5625rem] font-medium leading-tight max-w-full truncate px-0.5">Další</span>
        </button>
      </nav>

      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent className="md:hidden">
          <DrawerHeader className="flex flex-row items-start justify-between gap-2 text-left">
            <div>
              <DrawerTitle>{editing ? "Přizpůsobit lištu" : "Nabídka"}</DrawerTitle>
              <DrawerDescription>
                {editing
                  ? `Vyberte až ${MOBILE_QUICK_MAX} položky pro spodní lištu.`
                  : "Všechny sekce aplikace."}
              </DrawerDescription>
            </div>
            <Button
              variant={editing ? "default" : "outline"}
              size="sm"
              className="h-9 shrink-0"
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? (
                <>
                  <Check className="h-4 w-4 mr-1" /> Hotovo
                </>
              ) : (
                <>
                  <SlidersHorizontal className="h-4 w-4 mr-1" /> Přizpůsobit
                </>
              )}
            </Button>
          </DrawerHeader>

          <div className="px-4 pb-8 overflow-y-auto">
            <div className="grid grid-cols-4 gap-2">
              {available.map((item) => {
                const inQuick = quick.includes(item.href);
                const atMax = quickItems.length >= MOBILE_QUICK_MAX;
                const label = item.shortLabel ?? item.label;

                if (editing) {
                  const disabled = !inQuick && atMax;
                  return (
                    <button
                      key={item.href}
                      type="button"
                      onClick={() => toggleQuick(item.href)}
                      disabled={disabled}
                      className={`relative flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-colors ${
                        inQuick ? "border-primary bg-primary/5" : "border-border"
                      } ${disabled ? "opacity-40" : "active:bg-muted"}`}
                    >
                      <Star
                        className={`absolute top-1.5 right-1.5 h-4 w-4 ${
                          inQuick
                            ? "fill-amber-400 text-amber-400"
                            : "text-muted-foreground/50"
                        }`}
                      />
                      <span className={`p-2 rounded-lg bg-muted ${item.color}`}>
                        <item.icon className="h-5 w-5" />
                      </span>
                      <span className="text-[0.6875rem] font-medium leading-tight line-clamp-2">
                        {label}
                      </span>
                    </button>
                  );
                }

                const active = isActive(item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-colors ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted active:bg-muted"
                    }`}
                  >
                    <span className={`p-2 rounded-lg bg-muted ${item.color}`}>
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span className="text-[0.6875rem] font-medium leading-tight line-clamp-2">
                      {label}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
