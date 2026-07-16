import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Upload, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch, type SwitchboardDocument } from "@/lib/switchboards-api";
import { openFilePicker } from "@/lib/file-picker";

const TYPES: Record<string, string> = { schrack_norm_dbo: "SchrackNorm DBO PDF", schrack_design: "Schrack Design", measurement_protocol: "Protokol měření", checklist_protocol: "Kontrolní protokol", other: "Ostatní" };
const STATUS: Record<string, string> = { pending: "Čeká", queued: "Ve frontě", analyzing_pdf: "Analyzuje PDF", ocr: "Probíhá OCR", generating_label: "Generuje QR a štítek", completed: "Dokončeno", needs_review: "Vyžaduje kontrolu", failed: "Zpracování selhalo", stored: "Uloženo" };

export function SwitchboardDocuments({ switchboardId }: { switchboardId: number }) {
  const { can } = useAuth(); const { toast } = useToast(); const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null); const [type, setType] = useState("schrack_norm_dbo");
  const key = ["switchboard-documents", switchboardId];
  const { data = [], isLoading } = useQuery({ queryKey: key, queryFn: () => switchboardFetch<SwitchboardDocument[]>(`/api/switchboards/${switchboardId}/documents`), enabled: can("switchboards.documents.view"), refetchInterval: (query) => (query.state.data as SwitchboardDocument[] | undefined)?.some((d) => ["queued", "analyzing_pdf", "ocr", "generating_label"].includes(d.processingStatus)) ? 5000 : false });
  const upload = useMutation({ mutationFn: async (file: File) => {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("Vyberte PDF soubor.");
    const params = new URLSearchParams({ type, name: file.name });
    const response = await fetch(`/api/switchboards/${switchboardId}/documents?${params}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error || `Nahrání selhalo (${response.status}).`);
    return body;
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); toast({ title: "Dokument nahrán", description: type === "schrack_norm_dbo" ? "Automatické zpracování bylo zařazeno do fronty." : "Dokument byl bezpečně uložen." }); }, onError: (error) => toast({ variant: "destructive", title: "Nahrání selhalo", description: error.message }) });
  const publish = useMutation({ mutationFn: ({ id, isPublic }: { id: number; isPublic: boolean }) => switchboardFetch(`/api/switchboards/${switchboardId}/documents/${id}/public`, { method: "PATCH", body: JSON.stringify({ isPublic }) }), onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); toast({ title: "Veřejná dostupnost dokumentu byla změněna" }); }, onError: (error) => toast({ variant: "destructive", title: "Změna zveřejnění selhala", description: error.message }) });
  if (!can("switchboards.documents.view")) return null;
  return <section className="mt-5 border-y bg-card">
    <div className="p-4 flex items-center gap-3 border-b"><FileText className="h-5 w-5 text-cyan-600" /><div className="flex-1"><h2 className="font-semibold">Dokumentace</h2><p className="text-xs text-muted-foreground">Originály a jejich neměnné verze</p></div></div>
    {can("switchboards.documents.upload") && <div className="p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 border-b"><Select value={type} onValueChange={setType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(TYPES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><Button disabled={upload.isPending} onClick={() => openFilePicker(input.current)}>{upload.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}Nahrát PDF</Button><input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); event.target.value = ""; }} /></div>}
    {isLoading ? <div className="p-4 text-sm text-muted-foreground">Načítám dokumentaci…</div> : data.length === 0 ? <div className="p-4 text-sm text-muted-foreground">Zatím nebyl nahrán žádný dokument.</div> : <div className="divide-y">{data.map((doc) => <div key={doc.id} className="p-4 flex items-start gap-3"><FileText className="h-5 w-5 mt-0.5 text-muted-foreground" /><div className="flex-1 min-w-0"><div className="font-medium truncate">{doc.originalFileName}</div><div className="text-xs text-muted-foreground mt-1">{TYPES[doc.documentType] ?? doc.documentType} · verze {doc.version} · {(doc.sizeBytes / 1024 / 1024).toFixed(1)} MB</div><div className={`text-xs mt-1 ${doc.processingStatus === "failed" ? "text-destructive" : doc.processingStatus === "needs_review" ? "text-amber-600" : "text-emerald-600"}`}>{STATUS[doc.processingStatus] ?? doc.processingStatus}</div>{doc.isPublic && <div className="text-xs text-blue-600 mt-1">Veřejný přes QR stránku</div>}{doc.processingErrorMessage && <div className="text-xs text-destructive flex gap-1 mt-1"><AlertCircle className="h-3 w-3 shrink-0" />{doc.processingErrorMessage}</div>}</div>{can("switchboards.documents.publish") && <Button size="sm" variant="outline" disabled={publish.isPending} onClick={() => publish.mutate({ id: doc.id, isPublic: !doc.isPublic })}>{doc.isPublic ? "Skrýt" : "Zveřejnit"}</Button>}<Button size="icon" variant="ghost" asChild title="Otevřít originál"><a href={`/api/switchboards/${switchboardId}/documents/${doc.id}/download`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a></Button></div>)}</div>}
  </section>;
}
