import { useState, useMemo, useEffect } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  useListActivities, getListActivitiesQueryKey,
  useCreateActivity, useDeleteActivity, useUpdateActivity,
  useListCustomers, getGetMyStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Hammer, Plus, Trash2, ChevronRight, Archive, ArchiveRestore, Clock,
  Play, X, CheckCircle2, Receipt, Camera, PlusCircle, User2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

function fmtH(n: number | null | undefined) {
  if (n == null || n === 0) return null;
  return `${Math.round(Number(n) * 100) / 100} h`;
}

function fmtKc(n: number | null | undefined) {
  if (n == null || n === 0) return null;
  return `${Math.round(n).toLocaleString("cs-CZ")} Kč`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("cs-CZ", { day: "numeric", month: "short" });
}

type Tab = "active" | "completed" | "archived";

const VALID_TABS: Tab[] = ["active", "completed", "archived"];

function readStateFromUrl(search: string) {
  const p = new URLSearchParams(search);
  const rawTab = p.get("tab");
  const tab: Tab = VALID_TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "active";
  return {
    tab,
    filterNoCustomer: p.get("noCustomer") === "1",
    filterWithMaterials: p.get("withMaterials") === "1",
    filterWithDocs: p.get("withDocs") === "1",
  };
}

function buildSearch(tab: Tab, noCustomer: boolean, withMaterials: boolean, withDocs: boolean) {
  const p = new URLSearchParams();
  if (tab !== "active") p.set("tab", tab);
  if (noCustomer) p.set("noCustomer", "1");
  if (withMaterials) p.set("withMaterials", "1");
  if (withDocs) p.set("withDocs", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

export default function Activities() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const search_ = useSearch();
  const [, setLocation] = useLocation();

  const [tab, setTabState] = useState<Tab>(() => readStateFromUrl(search_).tab);
  const [filterNoCustomer, setFilterNoCustomer] = useState(() => readStateFromUrl(search_).filterNoCustomer);
  const [filterWithMaterials, setFilterWithMaterials] = useState(() => readStateFromUrl(search_).filterWithMaterials);
  const [filterWithDocs, setFilterWithDocs] = useState(() => readStateFromUrl(search_).filterWithDocs);

  useEffect(() => {
    const s = readStateFromUrl(search_);
    setTabState(s.tab);
    setFilterNoCustomer(s.filterNoCustomer);
    setFilterWithMaterials(s.filterWithMaterials);
    setFilterWithDocs(s.filterWithDocs);
  }, [search_]);

  const setTab = (t: Tab) => {
    setTabState(t);
    setLocation(buildSearch(t, filterNoCustomer, filterWithMaterials, filterWithDocs), { replace: true });
  };

  const toggleNoCustomer = () => {
    const next = !filterNoCustomer;
    setFilterNoCustomer(next);
    setLocation(buildSearch(tab, next, filterWithMaterials, filterWithDocs), { replace: true });
  };

  const toggleWithMaterials = () => {
    const next = !filterWithMaterials;
    setFilterWithMaterials(next);
    setLocation(buildSearch(tab, filterNoCustomer, next, filterWithDocs), { replace: true });
  };

  const toggleWithDocs = () => {
    const next = !filterWithDocs;
    setFilterWithDocs(next);
    setLocation(buildSearch(tab, filterNoCustomer, filterWithMaterials, next), { replace: true });
  };

  const clearFilters = () => {
    setFilterNoCustomer(false);
    setFilterWithMaterials(false);
    setFilterWithDocs(false);
    setLocation(buildSearch(tab, false, false, false), { replace: true });
  };
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", customerId: "" as string });

  const archived = tab === "archived";
  const params = { archived };
  const queryKey = getListActivitiesQueryKey(params);
  const { data: allActivities, isLoading } = useListActivities(params, { query: { queryKey } });
  const { data: customers } = useListCustomers();

  const activities = useMemo(() => {
    if (!allActivities) return [];
    let list = allActivities;
    if (tab === "active") list = list.filter((a) => !a.completedAt);
    if (tab === "completed") list = list.filter((a) => !!a.completedAt);
    if (filterNoCustomer) list = list.filter((a) => !a.customerId);
    if (filterWithMaterials) list = list.filter((a) => (a.materialsTotalCost ?? 0) > 0);
    if (filterWithDocs) list = list.filter((a) => (a.attachmentsCount ?? 0) > 0);
    return list;
  }, [allActivities, tab, filterNoCustomer, filterWithMaterials, filterWithDocs]);

  const createActivity = useCreateActivity();
  const updateActivity = useUpdateActivity();
  const deleteActivity = useDeleteActivity();

  const invalidate = () => {
    invalidateData(queryClient, "activities");
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    createActivity.mutate(
      {
        data: {
          name: form.name.trim(),
          description: form.description.trim() || null,
          customerId: form.customerId ? Number(form.customerId) : null,
        },
      },
      {
        onSuccess: () => {
          setForm({ name: "", description: "", customerId: "" });
          setShowAdd(false);
          invalidate();
          toast({ title: "Akce přidána" });
        },
        onError: () => toast({ title: "Nepodařilo se přidat akci", variant: "destructive" }),
      },
    );
  };

  const toggleArchive = (id: number, isArchived: boolean) => {
    updateActivity.mutate(
      { id, data: { isArchived: !isArchived } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: isArchived ? "Akce obnovena" : "Akce archivována" });
        },
      },
    );
  };

  const handleDelete = (id: number, name: string) => {
    openConfirm(
      { title: `Opravdu smazat akci „${name}“?`, description: "Smažou se i materiály." },
      () => {
        deleteActivity.mutate(
          { id },
          {
            onSuccess: () => {
              invalidate();
              toast({ title: "Akce smazána" });
            },
          },
        );
      },
    );
  };

  const hasExtraFilters = filterNoCustomer || filterWithMaterials || filterWithDocs;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto w-full space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Hammer className="h-6 w-6 text-orange-500" /> Dlouhodobé akce
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Stavby a projekty s vlastním časovačem a materiálem, nezávislé na kalendáři.
          </p>
        </div>
        {can("write") && !showAdd && (
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Nová akce
          </Button>
        )}
      </div>

      {/* Tab filter */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
        {(["active", "completed", "archived"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = { active: "Aktivní", completed: "Dokončené", archived: "Archív" };
          return (
            <button
              key={t}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${tab === t ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab(t)}
            >
              {labels[t]}
            </button>
          );
        })}
      </div>

      {/* Extra filters */}
      <div className="flex flex-wrap gap-2">
        <button
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filterNoCustomer ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          onClick={toggleNoCustomer}
        >
          <User2 className="h-3.5 w-3.5" /> Bez zákazníka
        </button>
        <button
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filterWithMaterials ? "border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground hover:text-foreground"}`}
          onClick={toggleWithMaterials}
        >
          <Hammer className="h-3.5 w-3.5" /> S materiálem
        </button>
        <button
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filterWithDocs ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground hover:text-foreground"}`}
          onClick={toggleWithDocs}
        >
          <Receipt className="h-3.5 w-3.5" /> S doklady
        </button>
        {hasExtraFilters && (
          <button
            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={clearFilters}
          >
            <X className="h-3.5 w-3.5" /> Zrušit
          </button>
        )}
      </div>

      {showAdd && can("write") && (
        <Card>
          <CardContent className="pt-4">
            <form onSubmit={handleAdd} className="space-y-3">
              <Input
                placeholder="Název akce (např. RD Novákovi – fasáda)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoFocus
                required
              />
              <Textarea
                placeholder="Popis (nepovinné)"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
              />
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
              >
                <option value="">— Bez zákazníka —</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.companyName}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <Button type="submit" disabled={createActivity.isPending}>
                  Přidat
                </Button>
                <Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>
                  <X className="h-4 w-4 mr-1" /> Zrušit
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : !activities || activities.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Hammer className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">
              {tab === "archived" ? "Žádné archivované akce" : tab === "completed" ? "Žádné dokončené akce" : "Zatím žádné aktivní akce"}
            </p>
            {tab === "active" && can("write") && (
              <p className="text-sm mt-1">Klikněte na „Nová akce" pro založení první.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => {
            const running = !!a.timerStartedAt;
            const hoursStr = fmtH(a.hoursSpent);
            const matStr = fmtKc(a.materialsTotalCost);
            const extraAmtStr = fmtKc(a.extraWorksTotalAmount);
            const extraHrsStr = fmtH(a.extraWorksTotalHours);
            return (
              <Card key={a.id} className={running ? "border-emerald-500 border-2" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/activities/${a.id}`} className="flex-1 min-w-0">
                      <div className="font-semibold truncate flex items-center gap-2">
                        {running && <Play className="h-4 w-4 text-emerald-500 animate-pulse fill-emerald-500 shrink-0" />}
                        <span className={a.completedAt ? "line-through text-muted-foreground" : ""}>{a.name}</span>
                        {a.completedAt && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0">
                            <CheckCircle2 className="h-3 w-3" /> Dokončeno
                          </span>
                        )}
                      </div>
                      {a.customerName && (
                        <div className="text-xs text-muted-foreground mt-0.5">{a.customerName}</div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                        {hoursStr && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" /> {hoursStr}
                          </span>
                        )}
                        {matStr && (
                          <span className="inline-flex items-center gap-1">
                            <Hammer className="h-3.5 w-3.5" /> {matStr}
                          </span>
                        )}
                        {(extraAmtStr || extraHrsStr) && (
                          <span className="inline-flex items-center gap-1">
                            <PlusCircle className="h-3.5 w-3.5" />
                            {[extraHrsStr, extraAmtStr].filter(Boolean).join(" · ")}
                          </span>
                        )}
                        {(a.attachmentsCount ?? 0) > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Receipt className="h-3.5 w-3.5" /> {a.attachmentsCount}
                          </span>
                        )}
                        {(a.photosCount ?? 0) > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Camera className="h-3.5 w-3.5" /> {a.photosCount}
                          </span>
                        )}
                        {a.updatedAt && (
                          <span className="text-muted-foreground/70">{fmtDate(a.updatedAt)}</span>
                        )}
                      </div>
                    </Link>
                    <div className="flex items-center gap-1 shrink-0">
                      {can("write") && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => toggleArchive(a.id, a.isArchived)}
                            title={a.isArchived ? "Obnovit" : "Archivovat"}
                          >
                            {a.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-rose-500 hover:text-rose-600"
                            onClick={() => handleDelete(a.id, a.name)}
                            title="Smazat"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      <Link href={`/activities/${a.id}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
