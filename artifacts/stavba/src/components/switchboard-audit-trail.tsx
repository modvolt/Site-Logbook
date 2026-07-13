import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { switchboardFetch, type Switchboard, type SwitchboardEvent, type SwitchboardEventPage } from "@/lib/switchboards-api";

const EVENT_LABELS: Record<string, string> = {
  switchboard_created: "Rozvaděč založen", switchboard_updated: "Údaje rozvaděče změněny", switchboard_archived: "Rozvaděč archivován",
  document_uploaded: "Dokument nahrán", document_processing_started: "Zpracování zahájeno", document_processing_completed: "Zpracování dokončeno", document_processing_failed: "Zpracování selhalo", document_reprocessing_requested: "Vyžádáno nové zpracování", document_published: "Dokument zveřejněn", document_unpublished: "Zveřejnění zrušeno",
  extracted_field_corrected: "Vytěžené pole opraveno", extracted_field_manually_added: "Pole ručně doplněno", field_registry_updated: "Registr parseru změněn",
  checklist_started: "Checklist zahájen", checklist_response_recorded: "Kontrolní bod vyplněn", checklist_response_changed: "Kontrolní bod změněn", checklist_phase_completed: "Fáze dokončena", checklist_phase_completed_with_override: "Fáze dokončena s výjimkou", checklist_template_created: "Šablona vytvořena", checklist_template_version_created: "Verze šablony vytvořena", checklist_template_metadata_updated: "Metadata šablony změněna", checklist_template_activation_changed: "Aktivace šablony změněna",
  measurement_recorded: "Měření zaznamenáno", defect_created: "Závada vytvořena", defect_created_from_checklist: "Závada z checklistu", defect_created_from_measurement: "Závada z měření", defect_updated: "Závada změněna", defect_closed: "Závada uzavřena", defect_reopened: "Závada znovu otevřena", photo_uploaded: "Fotografie nahrána",
  qr_token_rotated: "QR token vytvořen nebo rotován", qr_token_deactivated: "QR token deaktivován", label_generated: "Typový štítek vytvořen", label_approved: "Typový štítek schválen", protocol_generation_started: "Generování protokolu zahájeno", protocol_generated: "Protokol vytvořen", protocol_generation_failed: "Generování protokolu selhalo",
};

function eventSummary(event: SwitchboardEvent): string {
  const payload = event.payload;
  const parts = [payload.protocolNumber, payload.fileName, payload.fieldKey, payload.phaseKey, payload.itemKey, payload.version != null ? `v${payload.version}` : null].filter((value) => value != null && value !== "");
  return parts.map(String).join(" · ") || `${event.entityType}${event.entityId == null ? "" : ` #${event.entityId}`}`;
}

export function SwitchboardAuditTrail({ boardId, compact = false }: { boardId?: number; compact?: boolean }) {
  const [page, setPage] = useState(0); const [eventType, setEventType] = useState("all"); const [selectedBoard, setSelectedBoard] = useState(boardId ? String(boardId) : "all"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const pageSize = compact ? 15 : 40; const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
  const effectiveBoard = boardId ? String(boardId) : selectedBoard; if (effectiveBoard !== "all") params.set("boardId", effectiveBoard); if (eventType !== "all") params.set("eventType", eventType); if (from) params.set("from", `${from}T00:00:00`); if (to) params.set("to", `${to}T23:59:59`);
  const events = useQuery({ queryKey: ["switchboard-events", boardId ?? selectedBoard, eventType, from, to, page], queryFn: () => switchboardFetch<SwitchboardEventPage>(`/api/switchboard-events?${params}`) });
  const boards = useQuery({ queryKey: ["switchboards", "audit-filter"], queryFn: () => switchboardFetch<Switchboard[]>("/api/switchboards?includeArchived=true"), enabled: !boardId });
  const totalPages = Math.max(1, Math.ceil((events.data?.total ?? 0) / pageSize)); const resetPage = () => setPage(0);
  return <section className={compact ? "mt-5 border-y bg-card" : ""}>
    {compact && <div className="p-4 border-b flex items-center gap-2"><ScrollText className="h-5 w-5 text-cyan-600" /><div><h2 className="font-semibold">Auditní historie</h2><p className="text-xs text-muted-foreground">Neměnná chronologie změn rozvaděče</p></div></div>}
    <div className="border-b bg-muted/20 p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1fr)_10rem_10rem] gap-2">
      {!boardId && <Select value={selectedBoard} onValueChange={(value) => { setSelectedBoard(value); resetPage(); }}><SelectTrigger><SelectValue placeholder="Rozvaděč" /></SelectTrigger><SelectContent><SelectItem value="all">Všechny rozvaděče a nastavení</SelectItem>{boards.data?.map((board) => <SelectItem key={board.id} value={String(board.id)}>{board.designation} · {board.internalName}</SelectItem>)}</SelectContent></Select>}
      <Select value={eventType} onValueChange={(value) => { setEventType(value); resetPage(); }}><SelectTrigger><SelectValue placeholder="Typ události" /></SelectTrigger><SelectContent><SelectItem value="all">Všechny události</SelectItem>{events.data?.eventTypes.map((value) => <SelectItem key={value} value={value}>{EVENT_LABELS[value] ?? value}</SelectItem>)}</SelectContent></Select>
      <Input type="date" aria-label="Audit od data" value={from} onChange={(event) => { setFrom(event.target.value); resetPage(); }} />
      <Input type="date" aria-label="Audit do data" value={to} onChange={(event) => { setTo(event.target.value); resetPage(); }} />
    </div>
    {events.isLoading && <div className="p-5 text-sm text-muted-foreground">Načítám audit…</div>}{events.error && <div className="p-5 text-sm text-destructive">{events.error.message}</div>}
    {events.data && <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr><th className="text-left p-3">Čas</th><th className="text-left p-3">Událost</th>{!boardId && <th className="text-left p-3">Rozvaděč</th>}<th className="text-left p-3">Pracovník</th><th className="text-left p-3">Detail</th></tr></thead><tbody>{events.data.items.length ? events.data.items.map((event) => <tr key={event.id} className="border-t align-top"><td className="p-3 whitespace-nowrap text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString("cs-CZ")}</td><td className="p-3 font-medium">{EVENT_LABELS[event.eventType] ?? event.eventType}</td>{!boardId && <td className="p-3">{event.board ? <Link className="text-primary hover:underline inline-flex items-center gap-1" href={`/switchboards/${event.board.id}`}>{event.board.designation} <ExternalLink className="h-3 w-3" /></Link> : <span className="text-muted-foreground">Globální nastavení</span>}</td>}<td className="p-3">{event.actorName ?? "Systém"}</td><td className="p-3 max-w-lg"><div className="text-xs">{eventSummary(event)}</div><details className="mt-1"><summary className="text-xs text-muted-foreground cursor-pointer">Auditní data</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words bg-muted p-2 text-[11px]">{JSON.stringify(event.payload, null, 2)}</pre></details></td></tr>) : <tr><td colSpan={boardId ? 4 : 5} className="p-8 text-center text-muted-foreground">Žádné auditní záznamy</td></tr>}</tbody></table></div>}
    {events.data && events.data.total > pageSize && <div className="border-t p-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">Celkem {events.data.total}</span><div className="flex items-center gap-2"><Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft className="h-4 w-4" /></Button><span className="text-xs">{page + 1} / {totalPages}</span><Button size="icon" variant="ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
  </section>;
}
