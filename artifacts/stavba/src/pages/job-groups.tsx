import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, FolderKanban, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchJson,
  formatDate,
  formatKc,
  type JobGroupSummary,
} from "@/lib/job-groups-api";

type CreateGroupPayload = {
  name: string;
  address?: string | null;
  notes?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

function statusLabel(status: string): string {
  if (status === "closed") return "Uzavřená";
  if (status === "paused") return "Pozastavená";
  return "Otevřená";
}

export default function JobGroups() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["job-groups"],
    queryFn: () => fetchJson<JobGroupSummary[]>("/api/job-groups"),
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateGroupPayload) =>
      fetchJson<JobGroupSummary>("/api/job-groups", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ["job-groups"] });
      setName("");
      setAddress("");
      setNotes("");
      setDateFrom("");
      setDateTo("");
      toast.success("Akce byla vytvořena.");
      setLocation(`/job-groups/${group.id}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Akci se nepodařilo vytvořit.");
    },
  });

  const groups = (data ?? []).filter((group) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [
      group.name,
      group.address ?? "",
      group.customerCompanyName ?? "",
      group.jobNumbers.join(" "),
    ].some((value) => value.toLowerCase().includes(q));
  });

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Zadejte název akce.");
      return;
    }
    createMutation.mutate({
      name: trimmed,
      address: address.trim() || null,
      notes: notes.trim() || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    });
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FolderKanban className="h-7 w-7 text-violet-500" />
            Akce zakázek
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Seskupení více zakázek do jedné akce a společného zakázkového listu.
          </p>
        </div>
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Hledat akci nebo zakázku"
            className="pl-9"
          />
        </div>
      </div>

      <section className="rounded-lg border bg-card p-4 md:p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <Plus className="h-5 w-5" />
          Nová akce
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Název akce" />
          <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Adresa / místo" />
          <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </div>
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Poznámka" />
        <Button onClick={handleCreate} disabled={createMutation.isPending}>
          <Plus className="h-4 w-4 mr-2" />
          Vytvořit akci
        </Button>
      </section>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          Žádná akce neodpovídá filtru.
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <Link key={group.id} href={`/job-groups/${group.id}`}>
              <a className="block rounded-lg border bg-card p-4 hover:bg-accent/40 transition-colors">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="font-semibold text-lg truncate">{group.name}</h2>
                      <Badge variant="outline">{statusLabel(group.status)}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {group.address || group.customerCompanyName || "Bez adresy"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 flex items-center gap-2">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {formatDate(group.dateFrom)} - {formatDate(group.dateTo)}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center md:min-w-80">
                    <div className="rounded-md bg-muted px-3 py-2">
                      <div className="text-xs text-muted-foreground">Zakázky</div>
                      <div className="font-semibold">{group.jobsCount}</div>
                    </div>
                    <div className="rounded-md bg-muted px-3 py-2">
                      <div className="text-xs text-muted-foreground">Hodiny</div>
                      <div className="font-semibold">{group.totalHours.toLocaleString("cs-CZ")}</div>
                    </div>
                    <div className="rounded-md bg-muted px-3 py-2">
                      <div className="text-xs text-muted-foreground">Materiál</div>
                      <div className="font-semibold">{formatKc(group.materialTotalCost)}</div>
                    </div>
                  </div>
                </div>
              </a>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
