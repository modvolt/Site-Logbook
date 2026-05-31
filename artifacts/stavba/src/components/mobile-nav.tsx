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
  MOBILE_QUICK_MAX,
  MOBILE_QUICK_STORAGE_KEY,
  type NavItem,
} from "@/components/nav-items";

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
function normalizeQuick(quick: string[], availableHrefs: Set<string>): string[] {
  const out: string[] = [];
  for (const href of quick) {
    if (availableHrefs.has(href) && !out.includes(href)) out.push(href);
    if (out.length >= MOBILE_QUICK_MAX) break;
  }
  if (out.length === 0) {
    for (const href of MOBILE_DEFAULT_QUICK) {
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
  can: (action: "write" | "manageUsers") => boolean;
};

export function MobileNav({ location, isActive, can }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [quick, setQuick] = useState<string[]>(loadQuick);

  const available = mobileMenuItems.filter((i) => !i.requires || can(i.requires));
  const availableHrefs = new Set(available.map((i) => i.href));
  const availableKey = available.map((i) => i.href).join(",");

  // Drop stale/unauthorized/duplicate hrefs whenever the available set changes
  // (e.g. role change), so the quick bar always reflects a valid, capped config.
  useEffect(() => {
    setQuick((prev) => {
      const next = normalizeQuick(prev, availableHrefs);
      return sameOrder(prev, next) ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey]);

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
      const base = normalizeQuick(prev, availableHrefs);
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
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-card flex items-center justify-around h-[calc(4rem+env(safe-area-inset-bottom,0px))] pb-[env(safe-area-inset-bottom,0px)] px-1 z-40">
        {quickItems.map((item) => {
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
              <span className="text-[9px] font-medium leading-tight">
                {item.shortLabel ?? item.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex flex-col items-center justify-center w-full h-full space-y-0.5 transition-colors ${
            moreActive ? "text-primary" : "text-muted-foreground"
          }`}
          aria-label="Další položky"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span className="text-[9px] font-medium leading-tight">Další</span>
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
                      <span className="text-[11px] font-medium leading-tight line-clamp-2">
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
                    <span className="text-[11px] font-medium leading-tight line-clamp-2">
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
