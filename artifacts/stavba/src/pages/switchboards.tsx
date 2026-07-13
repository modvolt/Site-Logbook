import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, CircuitBoard, ClipboardList, Download, MapPin, ScanText, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { SWITCHBOARD_STATUS_LABELS, switchboardFetch, type Switchboard } from "@/lib/switchboards-api";

const PHASES = [
  { key: "assemblyStatus", label: "Sestavení" },
  { key: "inspectionStatus", label: "Kontrola" },
  { key: "measurementStatus", label: "Měření" },
] as const;
const PHASE_STYLE: Record<string, string> = { completed: "bg-emerald-500", in_progress: "bg-amber-500", not_started: "bg-muted-foreground/30" };

function csvValue(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function exportBoards(boards: Switchboard[]) {
  const header = ["Rozvaděč", "Interní název", "Výrobní číslo", "Zakázka", "Pracovníci", "Stav", "Sestavení", "Kontrola", "Měření", "Otevřené závady", "Kritické závady"];
  const rows = boards.map((board) => [board.designation, board.internalName, board.serialNumber, board.job ? `${board.job.jobNumber ?? board.job.id} - ${board.job.title}` : board.jobId, board.assignees.map((item) => item.personName).join(", "), SWITCHBOARD_STATUS_LABELS[board.status] ?? board.status, board.assemblyStatus, board.inspectionStatus, board.measurementStatus, board.openDefectCount, board.criticalOpenDefectCount]);
  const blob = new Blob(["\uFEFF", [header, ...rows].map((row) => row.map(csvValue).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `rozvadece-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
}

export default function Switchboards() {
  const { can } = useAuth();
  const [search, setSearch] = useState(""); const [jobId, setJobId] = useState("all"); const [status, setStatus] = useState("all"); const [personId, setPersonId] = useState("all"); const [openDefects, setOpenDefects] = useState("all");
  const catalog = useQuery({ queryKey: ["switchboards", "catalog"], queryFn: () => switchboardFetch<Switchboard[]>("/api/switchboards?includeArchived=true") });
  const params = new URLSearchParams(); if (jobId !== "all") params.set("jobId", jobId); if (status !== "all") params.set("status", status); if (personId !== "all") params.set("personId", personId); if (openDefects !== "all") params.set("openDefects", openDefects); if (status === "archived") params.set("includeArchived", "true");
  const filterKey = params.toString();
  const boards = useQuery({ queryKey: ["switchboards", "overview", filterKey], queryFn: () => switchboardFetch<Switchboard[]>(`/api/switchboards${filterKey ? `?${filterKey}` : ""}`) });
  const jobs = useMemo(() => [...new Map((catalog.data ?? []).filter((board) => board.job).map((board) => [board.job!.id, board.job!])).values()].sort((a, b) => (a.jobNumber ?? a.id) - (b.jobNumber ?? b.id)), [catalog.data]);
  const people = useMemo(() => [...new Map((catalog.data ?? []).flatMap((board) => board.assignees).map((person) => [person.personId, person])).values()].sort((a, b) => a.personName.localeCompare(b.personName, "cs")), [catalog.data]);
  const filtered = useMemo(() => { const needle = search.trim().toLocaleLowerCase("cs-CZ"); if (!needle) return boards.data ?? []; return (boards.data ?? []).filter((board) => [board.designation, board.internalName, board.serialNumber, board.installationLocation, board.job?.title, board.job?.jobNumber, ...board.assignees.map((item) => item.personName)].some((value) => String(value ?? "").toLocaleLowerCase("cs-CZ").includes(needle))); }, [boards.data, search]);
  const stats = useMemo(() => ({ total: filtered.length, completed: filtered.filter((board) => board.status === "protocol_completed" || board.status === "ready_for_handover" || board.status === "handed_over").length, defects: filtered.filter((board) => board.openDefectCount > 0).length, critical: filtered.filter((board) => board.criticalOpenDefectCount > 0).length }), [filtered]);
  const hasFilters = search || jobId !== "all" || status !== "all" || personId !== "all" || openDefects !== "all";
  return <div className="max-w-7xl mx-auto w-full p-4 md:p-6">
    <div className="mb-5 flex flex-wrap items-start gap-3"><div className="flex-1"><h1 className="text-2xl font-bold flex items-center gap-2"><CircuitBoard className="h-6 w-6 text-cyan-600" />Rozvaděče</h1><p className="text-sm text-muted-foreground mt-1">Výroba, kontroly, měření, dokumentace a dohled nad závadami.</p></div><div className="flex flex-wrap gap-2">{can("switchboards.templates.manage") && <Button variant="outline" asChild><Link href="/admin/switchboard-templates"><ClipboardList className="h-4 w-4 mr-1" />Šablony</Link></Button>}{can("switchboards.parser.manage") && <Button variant="outline" asChild><Link href="/admin/switchboard-parser"><ScanText className="h-4 w-4 mr-1" />DBO parser</Link></Button>}<Button variant="outline" disabled={!filtered.length} onClick={() => exportBoards(filtered)}><Download className="h-4 w-4 mr-1" />CSV</Button></div></div>
    <div className="border-y grid grid-cols-2 lg:grid-cols-4 bg-card"><div className="p-3 border-r border-b lg:border-b-0"><div className="text-xs text-muted-foreground">Ve výběru</div><div className="text-xl font-semibold">{stats.total}</div></div><div className="p-3 lg:border-r border-b lg:border-b-0"><div className="text-xs text-muted-foreground">Dokončený protokol</div><div className="text-xl font-semibold text-emerald-700">{stats.completed}</div></div><div className="p-3 border-r"><div className="text-xs text-muted-foreground">S otevřenou závadou</div><div className="text-xl font-semibold text-amber-700">{stats.defects}</div></div><div className="p-3"><div className="text-xs text-muted-foreground">S kritickou závadou</div><div className="text-xl font-semibold text-red-700">{stats.critical}</div></div></div>
    <div className="border-b bg-muted/20 p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[minmax(12rem,1.35fr)_repeat(3,minmax(9rem,1fr))_minmax(10rem,1fr)_auto] gap-3 items-end">
      <div className="space-y-1"><label className="text-xs font-medium">Hledat</label><div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Označení, sériové číslo, zakázka…" /></div></div>
      <div className="space-y-1"><label className="text-xs font-medium">Zakázka</label><Select value={jobId} onValueChange={setJobId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Všechny</SelectItem>{jobs.map((job) => <SelectItem key={job.id} value={String(job.id)}>#{job.jobNumber ?? job.id} {job.title}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><label className="text-xs font-medium">Stav</label><Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Všechny</SelectItem>{Object.entries(SWITCHBOARD_STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><label className="text-xs font-medium">Pracovník</label><Select value={personId} onValueChange={setPersonId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Všichni</SelectItem>{people.map((person) => <SelectItem key={person.personId} value={String(person.personId)}>{person.personName}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><label className="text-xs font-medium">Otevřené závady</label><Select value={openDefects} onValueChange={setOpenDefects}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Nerozhoduje</SelectItem><SelectItem value="true">Ano</SelectItem><SelectItem value="false">Ne</SelectItem></SelectContent></Select></div>
      <Button variant="ghost" disabled={!hasFilters} onClick={() => { setSearch(""); setJobId("all"); setStatus("all"); setPersonId("all"); setOpenDefects("all"); }}>Resetovat</Button>
    </div>
    {boards.isLoading && <div className="space-y-2 mt-4"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}
    {boards.error && <div className="border-b bg-destructive/5 p-4 text-sm text-destructive">{boards.error.message}</div>}
    {!boards.isLoading && !boards.error && filtered.length === 0 && <div className="border-b border-dashed p-10 text-center text-sm text-muted-foreground">Filtru neodpovídá žádný rozvaděč.</div>}
    {filtered.length > 0 && <div className="border-b bg-card overflow-x-auto"><table className="w-full min-w-[980px] text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="text-left p-3">Rozvaděč</th><th className="text-left p-3">Zakázka / umístění</th><th className="text-left p-3">Pracovníci</th><th className="text-left p-3">Průběh fází</th><th className="text-left p-3">Závady</th><th className="text-left p-3">Stav</th><th className="w-10" /></tr></thead><tbody>{filtered.map((board) => <tr key={board.id} className="border-t hover:bg-muted/30"><td className="p-3"><div className="font-semibold">{board.designation}</div><div className="text-xs text-muted-foreground">{board.internalName}{board.serialNumber ? ` · ${board.serialNumber}` : ""}</div></td><td className="p-3"><div>{board.job ? `#${board.job.jobNumber ?? board.job.id} ${board.job.title}` : `#${board.jobId}`}</div>{board.installationLocation && <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1"><MapPin className="h-3 w-3" />{board.installationLocation}</div>}</td><td className="p-3"><div className="flex items-start gap-1.5"><Users className="h-4 w-4 mt-0.5 text-muted-foreground" /><span>{board.assignees.map((item) => item.personName).join(", ") || "Nepřiřazeno"}</span></div></td><td className="p-3"><div className="flex gap-3">{PHASES.map((phase) => <div key={phase.key} className="flex items-center gap-1.5" title={`${phase.label}: ${board[phase.key]}`}><span className={`h-2.5 w-2.5 rounded-full ${PHASE_STYLE[board[phase.key]] ?? PHASE_STYLE.not_started}`} /><span className="text-xs">{phase.label}</span></div>)}</div></td><td className="p-3">{board.openDefectCount ? <div className={`flex items-center gap-1.5 ${board.criticalOpenDefectCount ? "text-red-700" : "text-amber-700"}`}><AlertTriangle className="h-4 w-4" />{board.openDefectCount}{board.criticalOpenDefectCount ? ` (${board.criticalOpenDefectCount} krit.)` : ""}</div> : <span className="text-emerald-700">Bez otevřených</span>}</td><td className="p-3">{SWITCHBOARD_STATUS_LABELS[board.status] ?? board.status}</td><td className="p-2"><Button variant="ghost" size="icon" asChild title="Otevřít rozvaděč"><Link href={`/switchboards/${board.id}`}><ChevronRight className="h-5 w-5" /></Link></Button></td></tr>)}</tbody></table></div>}
  </div>;
}
