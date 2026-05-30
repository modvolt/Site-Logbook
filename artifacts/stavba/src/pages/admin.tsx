import { useState, useMemo } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  useListJobs, getListJobsQueryKey,
  useUpdateJob, useDeleteJob, getGetJobQueryKey,
  useListCustomers, getListCustomersQueryKey,
  useListPeople, getListPeopleQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePicker } from "@/components/time-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_STATUSES, JOB_TYPES } from "@/components/badges";
import { Trash2, Save, X, Edit3, Search, ExternalLink, ShieldAlert, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type EditDraft = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  type: string;
  customerId: number | null;
  assignedPersonId: number | null;
  hoursSpent: string;
  price: string;
  clientSite: string;
};

function jobToDraft(job: any): EditDraft {
  return {
    title: job.title || "",
    date: job.date || "",
    startTime: job.startTime || "",
    endTime: job.endTime || "",
    status: job.status || "planned",
    type: job.type || "planned_work",
    customerId: job.customerId ?? null,
    assignedPersonId: job.assignedPersonId ?? null,
    hoursSpent: job.hoursSpent != null ? String(job.hoursSpent) : "",
    price: job.price != null ? String(job.price) : "",
    clientSite: job.clientSite || "",
  };
}

export default function Admin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const queryParams: any = {};
  if (fromDate) queryParams.from = fromDate;
  if (toDate) queryParams.to = toDate;

  const { data: jobs, isLoading } = useListJobs(queryParams, {
    query: { queryKey: getListJobsQueryKey(queryParams) }
  });
  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey() } });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const updateJob = useUpdateJob();
  const deleteJob = useDeleteJob();

  const filtered = useMemo(() => {
    if (!jobs) return [];
    const q = search.toLowerCase().trim();
    return jobs.filter(j => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (typeFilter !== "all" && j.type !== typeFilter) return false;
      if (q) {
        const hay = `${j.title} ${j.clientSite || ""} ${j.customerCompanyName || ""} ${j.assignedPersonName || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [jobs, search, statusFilter, typeFilter]);

  const startEdit = (job: any) => {
    setEditingId(job.id);
    setDraft(jobToDraft(job));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = () => {
    if (!draft || editingId == null) return;
    if (!draft.title.trim()) { toast({ title: "Název je povinný", variant: "destructive" }); return; }
    if (!draft.date) { toast({ title: "Datum je povinné", variant: "destructive" }); return; }
    updateJob.mutate({
      id: editingId,
      data: {
        title: draft.title,
        date: draft.date,
        startTime: draft.startTime || null,
        endTime: draft.endTime || null,
        status: draft.status,
        type: draft.type,
        customerId: draft.customerId,
        assignedPersonId: draft.assignedPersonId,
        clientSite: draft.clientSite || null,
        hoursSpent: draft.hoursSpent ? parseFloat(draft.hoursSpent) : null,
        price: draft.price ? parseFloat(draft.price) : null,
      },
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(editingId), data);
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        toast({ title: "Zakázka uložena" });
        cancelEdit();
      },
      onError: () => toast({ title: "Uložení selhalo", variant: "destructive" }),
    });
  };

  const deleteOne = (id: number, title: string) => {
    if (!confirm(`Smazat „${title}"? Tato akce je nevratná.`)) return;
    deleteJob.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        toast({ title: "Zakázka smazána" });
        setSelected(s => { const n = new Set(s); n.delete(id); return n; });
      },
      onError: () => toast({ title: "Smazání selhalo", variant: "destructive" }),
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Smazat ${selected.size} zakázek? Tato akce je nevratná.`)) return;
    let ok = 0, fail = 0;
    for (const id of Array.from(selected)) {
      try {
        await deleteJob.mutateAsync({ id });
        ok++;
      } catch { fail++; }
    }
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    setSelected(new Set());
    toast({ title: `Smazáno ${ok}, selhalo ${fail}` });
  };

  const toggleSelect = (id: number) => {
    setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(j => j.id)));
  };

  const updateDraft = <K extends keyof EditDraft>(key: K, value: EditDraft[K]) => {
    setDraft(d => d ? { ...d, [key]: value } : d);
  };

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1400px] mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <ShieldAlert className="w-7 h-7 text-rose-600" />
          <h1 className="text-2xl font-bold">Admin – Správa zakázek</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          Hromadná editace všech zakázek. Změny zde se ihned ukládají na server.
        </p>

        {/* Filters */}
        <div className="bg-card border rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Hledat</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Název, zákazník, pracovník…" className="pl-9 h-10" />
            </div>
          </div>
          <div className="w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Stav</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Všechny</SelectItem>
                {Object.entries(JOB_STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Typ</label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Všechny</SelectItem>
                {Object.entries(JOB_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[140px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Od</label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-10" />
          </div>
          <div className="w-[140px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Do</label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-10" />
          </div>
          {(search || statusFilter !== "all" || typeFilter !== "all" || fromDate || toDate) && (
            <Button variant="ghost" onClick={() => { setSearch(""); setStatusFilter("all"); setTypeFilter("all"); setFromDate(""); setToDate(""); }} className="h-10">
              <X className="w-4 h-4 mr-1" /> Resetovat
            </Button>
          )}
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="bg-rose-50 border border-rose-200 dark:bg-rose-950/30 dark:border-rose-900 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
            <span className="text-sm font-medium">Vybráno: {selected.size}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Zrušit výběr</Button>
              <Button variant="destructive" size="sm" onClick={deleteSelected} disabled={deleteJob.isPending}>
                <Trash2 className="w-4 h-4 mr-1" /> Smazat vybrané
              </Button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && selected.size === filtered.length}
                      onChange={toggleAll}
                      className="w-4 h-4 cursor-pointer"
                    />
                  </th>
                  <th className="px-3 py-3 text-left">Datum</th>
                  <th className="px-3 py-3 text-left">Čas</th>
                  <th className="px-3 py-3 text-left">Název</th>
                  <th className="px-3 py-3 text-left">Typ</th>
                  <th className="px-3 py-3 text-left">Stav</th>
                  <th className="px-3 py-3 text-left">Zákazník / Stavba</th>
                  <th className="px-3 py-3 text-left">Pracovník</th>
                  <th className="px-3 py-3 text-right">Hod.</th>
                  <th className="px-3 py-3 text-right">Cena</th>
                  <th className="px-3 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [1, 2, 3, 4, 5].map(i => (
                    <tr key={i} className="border-t">
                      <td colSpan={11} className="px-3 py-2"><Skeleton className="h-8 w-full" /></td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">Žádné zakázky</td></tr>
                ) : filtered.map(job => {
                  const isEditing = editingId === job.id;
                  if (isEditing && draft) {
                    return (
                      <tr key={job.id} className="border-t bg-amber-50/50 dark:bg-amber-950/20">
                        <td className="px-3 py-2"></td>
                        <td className="px-2 py-2">
                          <Input type="date" value={draft.date} onChange={e => updateDraft("date", e.target.value)} className="h-9 text-xs" />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <TimePicker value={draft.startTime} onChange={v => updateDraft("startTime", v)} className="h-9 text-xs w-24" />
                            <TimePicker value={draft.endTime} onChange={v => updateDraft("endTime", v)} className="h-9 text-xs w-24" />
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <Input value={draft.title} onChange={e => updateDraft("title", e.target.value)} className="h-9 text-xs min-w-[180px]" />
                        </td>
                        <td className="px-2 py-2">
                          <Select value={draft.type} onValueChange={v => updateDraft("type", v)}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(JOB_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <Select value={draft.status} onValueChange={v => updateDraft("status", v)}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(JOB_STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <Select
                            value={draft.customerId != null ? String(draft.customerId) : "none"}
                            onValueChange={v => updateDraft("customerId", v === "none" ? null : parseInt(v))}
                          >
                            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— Žádný —</SelectItem>
                              {customers?.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.companyName}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <Select
                            value={draft.assignedPersonId != null ? String(draft.assignedPersonId) : "none"}
                            onValueChange={v => updateDraft("assignedPersonId", v === "none" ? null : parseInt(v))}
                          >
                            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— Nepřiřazeno —</SelectItem>
                              {people?.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <Input type="number" step="0.25" value={draft.hoursSpent} onChange={e => updateDraft("hoursSpent", e.target.value)} className="h-9 text-xs w-20 text-right" />
                        </td>
                        <td className="px-2 py-2">
                          <Input type="number" step="1" value={draft.price} onChange={e => updateDraft("price", e.target.value)} className="h-9 text-xs w-24 text-right" />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1 justify-end">
                            <Button size="sm" onClick={saveEdit} disabled={updateJob.isPending} className="h-8 px-2">
                              <Save className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-8 px-2">
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const typeCfg = JOB_TYPES[job.type as keyof typeof JOB_TYPES];
                  const statusCfg = JOB_STATUSES[job.status as keyof typeof JOB_STATUSES];
                  return (
                    <tr key={job.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(job.id)}
                          onChange={() => toggleSelect(job.id)}
                          className="w-4 h-4 cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{format(new Date(job.date), "d.M.yyyy")}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">
                        {job.startTime || ""}{job.endTime ? ` – ${job.endTime}` : ""}
                      </td>
                      <td className="px-3 py-2 font-medium max-w-[260px] truncate" title={job.title}>{job.title}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${typeCfg?.color || ""}`}>{typeCfg?.label || job.type}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg?.color || ""}`}>{statusCfg?.label || job.status}</span>
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate" title={job.customerCompanyName || job.clientSite || ""}>
                        {job.customerCompanyName || job.clientSite || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{job.assignedPersonName || "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{job.hoursSpent != null ? Number(job.hoursSpent).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{job.price != null ? Number(job.price).toLocaleString("cs-CZ") : "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1 justify-end">
                          <Link href={`/jobs/${job.id}`}>
                            <Button size="sm" variant="ghost" className="h-8 px-2" title="Otevřít detail">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Button>
                          </Link>
                          <Button size="sm" variant="ghost" onClick={() => startEdit(job)} className="h-8 px-2" title="Upravit">
                            <Edit3 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteOne(job.id, job.title)} className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10" title="Smazat">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-3">
          Celkem: <strong>{filtered.length}</strong>{jobs && filtered.length !== jobs.length ? ` z ${jobs.length}` : ""}
        </p>
      </div>
    </div>
  );
}
