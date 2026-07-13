import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, FileText, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch, type SwitchboardProtocol, type SwitchboardProtocolReadiness } from "@/lib/switchboards-api";

const STATUS: Record<string, string> = { generating: "Generuje se", final: "Finální", failed: "Generování selhalo" };

export function SwitchboardProtocols({ switchboardId }: { switchboardId: number }) {
  const { can } = useAuth(); const { toast } = useToast(); const qc = useQueryClient(); const [overrideReason, setOverrideReason] = useState("");
  const key = ["switchboard-protocols", switchboardId]; const readinessKey = ["switchboard-protocol-readiness", switchboardId];
  const protocols = useQuery({ queryKey: key, queryFn: () => switchboardFetch<SwitchboardProtocol[]>(`/api/switchboards/${switchboardId}/protocols`) });
  const readiness = useQuery({ queryKey: readinessKey, queryFn: () => switchboardFetch<SwitchboardProtocolReadiness>(`/api/switchboards/${switchboardId}/protocols/readiness`) });
  const generate = useMutation({
    mutationFn: () => switchboardFetch<SwitchboardProtocol>(`/api/switchboards/${switchboardId}/protocols/generate`, { method: "POST", body: JSON.stringify(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}) }),
    onSuccess: (protocol) => { setOverrideReason(""); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: readinessKey }); void qc.invalidateQueries({ queryKey: ["switchboards", switchboardId] }); void qc.invalidateQueries({ queryKey: ["switchboards"] }); void qc.invalidateQueries({ queryKey: ["switchboard-checklist", switchboardId] }); toast({ title: `Protokol ${protocol.protocolNumber} byl vytvořen` }); },
    onError: (reason) => toast({ variant: "destructive", title: "Protokol nelze vytvořit", description: reason.message }),
  });
  const blockers = readiness.data?.blockers ?? []; const canOverride = can("switchboards.protocol.override");
  const disabled = generate.isPending || readiness.isLoading || protocols.isLoading || (blockers.length > 0 && (!canOverride || overrideReason.trim().length < 10));
  return <section className="mt-5 border-y bg-card">
    <div className="p-4 border-b flex flex-col sm:flex-row sm:items-center gap-3"><div className="flex items-start gap-3 flex-1"><FileCheck2 className="h-5 w-5 mt-0.5 text-cyan-600" /><div><h2 className="font-semibold">Finální výrobní protokol</h2><p className="text-xs text-muted-foreground">Neměnné verzované PDF A4 ze snapshotu aktuálních dat</p></div></div>{can("switchboards.protocol.complete") && <Button disabled={disabled} onClick={() => generate.mutate()}>{generate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileText className="h-4 w-4 mr-1" />}Vygenerovat protokol</Button>}</div>
    {readiness.error && <div className="p-4 text-sm text-destructive">{readiness.error.message}</div>}
    {readiness.data && <div className="p-4 border-b space-y-3">
      {blockers.length === 0 ? <div className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />Podklady jsou úplné a protokol lze vytvořit.</div> : <><div className="flex items-center gap-2 text-sm font-medium text-amber-700"><ShieldAlert className="h-4 w-4" />Před vytvořením zbývá vyřešit {blockers.length} blokací.</div><ul className="space-y-1.5">{blockers.map((blocker, index) => <li key={`${blocker.code}-${blocker.itemKey ?? index}`} className="flex gap-2 text-xs text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />{blocker.message}</li>)}</ul></>}
      {blockers.length > 0 && canOverride && <div className="space-y-1.5"><Label htmlFor={`protocol-override-${switchboardId}`} className="text-xs">Zdůvodnění administrátorské výjimky</Label><Textarea id={`protocol-override-${switchboardId}`} rows={3} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Uveďte, proč lze finální protokol vytvořit i přes uvedené blokace (min. 10 znaků)." /></div>}
      {blockers.length > 0 && !canOverride && <p className="text-xs text-muted-foreground">Blokace musí být odstraněny. Administrátorskou výjimku může použít pouze uživatel se samostatným oprávněním.</p>}
    </div>}
    <div className="divide-y">{protocols.isLoading ? <div className="p-5 text-sm text-muted-foreground text-center">Načítám historii protokolů…</div> : protocols.error ? <div className="p-5 text-sm text-destructive text-center">{protocols.error.message}</div> : protocols.data?.length ? protocols.data.map((protocol) => <div key={protocol.id} className="p-4 flex items-center gap-3"><FileText className={`h-5 w-5 ${protocol.status === "final" ? "text-emerald-600" : protocol.status === "failed" ? "text-red-600" : "text-amber-600"}`} /><div className="flex-1 min-w-0"><div className="font-medium text-sm truncate">{protocol.protocolNumber}</div><div className="text-xs text-muted-foreground">Verze {protocol.version} · {STATUS[protocol.status] ?? protocol.status} · {protocol.createdByName ?? "Neznámý uživatel"} · {new Date(protocol.createdAt).toLocaleString("cs-CZ")}</div></div>{protocol.downloadUrl && <Button variant="outline" size="icon" asChild><a href={protocol.downloadUrl} target="_blank" rel="noreferrer" title="Otevřít PDF protokolu"><Download className="h-4 w-4" /></a></Button>}</div>) : <div className="p-5 text-sm text-muted-foreground text-center">Zatím nebyla vytvořena žádná verze protokolu.</div>}</div>
  </section>;
}
