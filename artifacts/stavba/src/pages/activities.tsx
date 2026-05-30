import { useState } from "react";
import { Link } from "wouter";
import {
  useListActivities, getListActivitiesQueryKey,
  useCreateActivity, useDeleteActivity, useUpdateActivity,
  useListCustomers, getGetMyStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Hammer, Plus, Trash2, ChevronRight, Archive, ArchiveRestore, Clock, Play, X, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

function fmtH(n: number | null | undefined) {
  if (n == null) return "—";
  return `${Math.round(Number(n) * 100) / 100} h`;
}

export default function Activities() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const [showArchived, setShowArchived] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", customerId: "" as string });

  const params = { archived: showArchived };
  const queryKey = getListActivitiesQueryKey(params);
  const { data: activities, isLoading } = useListActivities(params, { query: { queryKey } });
  const { data: customers } = useListCustomers();

  const createActivity = useCreateActivity();
  const updateActivity = useUpdateActivity();
  const deleteActivity = useDeleteActivity();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/activities"] });
    queryClient.invalidateQueries({ queryKey: getGetMyStatsQueryKey() });
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
    if (!confirm(`Opravdu smazat akci „${name}“? Smažou se i materiály.`)) return;
    deleteActivity.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Akce smazána" });
        },
      },
    );
  };

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
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? <ArchiveRestore className="h-4 w-4 mr-1.5" /> : <Archive className="h-4 w-4 mr-1.5" />}
            {showArchived ? "Aktivní" : "Archív"}
          </Button>
          {can("write") && !showAdd && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Nová akce
            </Button>
          )}
        </div>
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
            <p className="font-medium">{showArchived ? "Žádné archivované akce" : "Zatím žádné akce"}</p>
            {!showArchived && can("write") && (
              <p className="text-sm mt-1">Klikněte na „Nová akce" pro založení první.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => {
            const running = !!a.timerStartedAt;
            return (
              <Card key={a.id} className={running ? "border-emerald-500 border-2" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/activities/${a.id}`} className="flex-1 min-w-0">
                      <div className="font-semibold truncate flex items-center gap-2">
                        {running && <Play className="h-4 w-4 text-emerald-500 animate-pulse fill-emerald-500" />}
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
                      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> {fmtH(a.hoursSpent)}
                        </span>
                        {(a.materialsTotalCost ?? 0) > 0 && (
                          <span>Materiál: {Math.round(a.materialsTotalCost ?? 0).toLocaleString("cs-CZ")} Kč</span>
                        )}
                        {a.createdByUserName && <span>· {a.createdByUserName}</span>}
                      </div>
                    </Link>
                    <div className="flex items-center gap-1">
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
    </div>
  );
}
