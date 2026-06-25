import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListPeople, useCreatePerson, useDeletePerson, getListPeopleQueryKey,
  useGetPeopleStats, getGetPeopleStatsQueryKey,
  type PersonStats,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { User, Trash2, Plus, UserPlus, Briefcase, Clock, Wrench, Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function extractServerError(err: unknown): string | null {
  const msg =
    (err as any)?.response?.data?.error ??
    (err as any)?.data?.error ??
    (err as any)?.message;
  return typeof msg === "string" ? msg : null;
}

function PersonCard({
  person,
  stats,
  onDelete,
  isDeleting,
  onNavigate,
}: {
  person: { id: number; name: string };
  stats: PersonStats | undefined;
  onDelete: (id: number) => void;
  isDeleting: boolean;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card className="hover:bg-muted/30 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 p-2.5 rounded-full text-primary shrink-0 mt-0.5">
            <User className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-base">{person.name}</span>
              {stats?.hasActiveTimer && (
                <Badge variant="outline" className="border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-950/30 text-xs gap-1 px-1.5">
                  <Timer className="h-3 w-3" /> Časovač běží
                </Badge>
              )}
            </div>
            {stats ? (
              <div className="flex flex-wrap gap-3 mt-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
                  onClick={() => onNavigate(`/jobs?assignedPersonId=${person.id}`)}
                  title="Dnešní zakázky"
                >
                  <Briefcase className="h-3.5 w-3.5" />
                  <span>
                    Dnes: <strong>{stats.todayJobsCount}</strong>
                  </span>
                </button>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Hodiny tento týden">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    Týden: <strong>{stats.weekHours.toFixed(1)} h</strong>
                  </span>
                </div>
                {stats.assignedMachinesCount > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Přiřazené stroje">
                    <Wrench className="h-3.5 w-3.5" />
                    <span>
                      Stroje: <strong>{stats.assignedMachinesCount}</strong>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex gap-3 mt-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
            onClick={() => onDelete(person.id)}
            disabled={isDeleting}
          >
            <Trash2 className="h-5 w-5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function People() {
  const [newPersonName, setNewPersonName] = useState("");
  const [nameError, setNameError] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const [, setLocation] = useLocation();

  const { data: people, isLoading: loadingPeople } = useListPeople({
    query: { queryKey: getListPeopleQueryKey() },
  });

  const { data: statsData } = useGetPeopleStats({
    query: { queryKey: getGetPeopleStatsQueryKey() },
  });

  const statsMap = new Map((statsData ?? []).map((s) => [s.personId, s]));

  const createPerson = useCreatePerson();
  const deletePerson = useDeletePerson();

  const handleAddPerson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonName.trim()) {
      setNameError("Jméno pracovníka je povinné");
      return;
    }
    setNameError("");

    createPerson.mutate({ data: { name: newPersonName.trim() } }, {
      onSuccess: () => {
        setNewPersonName("");
        setNameError("");
        invalidateData(queryClient, "people");
        toast({ title: "Pracovník přidán" });
      },
      onError: (err) => {
        const serverMsg = extractServerError(err);
        if (serverMsg) {
          setNameError(serverMsg);
        } else {
          toast({ title: "Nepodařilo se přidat pracovníka", variant: "destructive" });
        }
      },
    });
  };

  const handleDeletePerson = (id: number) => {
    openConfirm("Opravdu chcete odebrat tohoto pracovníka?", () => {
      deletePerson.mutate({ id }, {
        onSuccess: () => {
          invalidateData(queryClient, "people");
          toast({ title: "Pracovník odebrán" });
        },
        onError: () => {
          toast({ title: "Nepodařilo se odebrat pracovníka", variant: "destructive" });
        },
      });
    });
  };

  const activeTimerCount = statsData?.filter((s) => s.hasActiveTimer).length ?? 0;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold flex-1">Tým</h1>
        {activeTimerCount > 0 && (
          <Badge variant="outline" className="border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-950/30 gap-1">
            <Timer className="h-3.5 w-3.5" />
            {activeTimerCount} {activeTimerCount === 1 ? "aktivní časovač" : "aktivní časovače"}
          </Badge>
        )}
      </div>

      <Card className="mb-8 border-primary/20 bg-primary/5">
        <CardContent className="p-4">
          <form onSubmit={handleAddPerson} className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <UserPlus className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  value={newPersonName}
                  onChange={(e) => {
                    setNewPersonName(e.target.value);
                    if (nameError) setNameError("");
                  }}
                  placeholder="Jméno pracovníka..."
                  className={`pl-10 h-14 text-base bg-background${nameError ? " border-destructive" : ""}`}
                  aria-invalid={!!nameError}
                />
              </div>
              <Button type="submit" disabled={createPerson.isPending} className="h-14 px-6">
                <Plus className="h-5 w-5 md:mr-2" />
                <span className="hidden md:inline">Přidat</span>
              </Button>
            </div>
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {loadingPeople ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : people && people.length > 0 ? (
          people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              stats={statsMap.get(person.id)}
              onDelete={handleDeletePerson}
              isDeleting={deletePerson.isPending}
              onNavigate={setLocation}
            />
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <User className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Zatím žádní pracovníci.</p>
            <p className="text-sm mt-1">Přidejte prvního pomocí formuláře výše.</p>
          </div>
        )}
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
