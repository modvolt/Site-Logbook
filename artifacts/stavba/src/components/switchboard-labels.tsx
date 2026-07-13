import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, GitCompareArrows, QrCode, RefreshCw, ShieldCheck, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch, type Switchboard, type SwitchboardLabel, type SwitchboardLabelComparison } from "@/lib/switchboards-api";

const SNAPSHOT_LABELS: Record<string, string> = { designation: "Označení", serialNumber: "Výrobní číslo", productionDate: "Datum výroby", typeDesignation: "Typ", manufacturer: "Výrobce", standards: "Normy", networkSystem: "Soustava", ratedVoltage: "Napětí", ratedFrequency: "Frekvence", ratedCurrent: "Jmenovitý proud", dimensions: "Rozměry", weight: "Hmotnost", ipRating: "IP", ikRating: "IK", companyAddress: "Adresa firmy", companyPhone: "Telefon firmy" };
const displaySnapshotValue = (value: unknown) => value == null || value === "" ? "—" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);

export function SwitchboardLabels({ board }: { board: Switchboard }) {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [compareFromId, setCompareFromId] = useState(""); const [compareToId, setCompareToId] = useState("");
  const key = ["switchboard-labels", board.id];
  const { data = [] } = useQuery({
    queryKey: key,
    queryFn: () => switchboardFetch<SwitchboardLabel[]>(`/api/switchboards/${board.id}/labels`),
  });
  useEffect(() => { if (data.length < 2) return; if (!data.some((label) => String(label.id) === compareFromId)) setCompareFromId(String(data[1].id)); if (!data.some((label) => String(label.id) === compareToId)) setCompareToId(String(data[0].id)); }, [data, compareFromId, compareToId]);
  const compareEnabled = !!compareFromId && !!compareToId && compareFromId !== compareToId;
  const comparison = useQuery({ queryKey: ["switchboard-label-comparison", board.id, compareFromId, compareToId], queryFn: () => switchboardFetch<SwitchboardLabelComparison>(`/api/switchboards/${board.id}/labels/compare?from=${compareFromId}&to=${compareToId}`), enabled: compareEnabled });
  const rotate = useMutation({
    mutationFn: () => switchboardFetch<{ publicUrl: string }>(`/api/switchboards/${board.id}/qr/rotate`, { method: "POST", body: JSON.stringify({ expiresAt: null }) }),
    onSuccess: (result) => {
      setLastUrl(result.publicUrl);
      void qc.invalidateQueries({ queryKey: ["switchboards", board.id] });
      toast({ title: "QR přístup byl aktivován", description: "Starší QR token byl zneplatněn." });
    },
    onError: (error) => toast({ variant: "destructive", title: "QR nelze aktivovat", description: error.message }),
  });
  const deactivate = useMutation({
    mutationFn: () => switchboardFetch(`/api/switchboards/${board.id}/qr/deactivate`, { method: "POST" }),
    onSuccess: () => {
      setLastUrl(null);
      void qc.invalidateQueries({ queryKey: ["switchboards", board.id] });
      toast({ title: "QR přístup byl deaktivován" });
    },
  });
  const generate = useMutation({
    mutationFn: () => switchboardFetch<SwitchboardLabel>(`/api/switchboards/${board.id}/labels/generate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast({ title: "Nová verze štítku byla vytvořena" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Štítek nelze vytvořit", description: error.message }),
  });
  const approve = useMutation({
    mutationFn: (labelId: number) => switchboardFetch(`/api/switchboards/${board.id}/labels/${labelId}/approve`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast({ title: "Typový štítek byl schválen" });
    },
  });

  return (
    <section className="mt-5 border-y bg-card">
      <div className="p-4 border-b flex items-center gap-3">
        <Tag className="h-5 w-5 text-cyan-600" />
        <div className="flex-1">
          <h2 className="font-semibold">QR a typové štítky</h2>
          <p className="text-xs text-muted-foreground">Verzované PDF 100 × 60 mm a PNG 300 DPI</p>
        </div>
      </div>
      <div className="p-4 border-b flex gap-2 flex-wrap items-center">
        <div className={`text-sm mr-auto ${board.qrEnabled ? "text-emerald-600" : "text-muted-foreground"}`}>
          <QrCode className="h-4 w-4 inline mr-1" />
          {board.qrEnabled ? `QR aktivní · ${board.qrTokenPrefix}…` : "QR není aktivní"}
        </div>
        {can("switchboards.qr.manage") && (
          <>
            <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              <RefreshCw className="h-4 w-4 mr-1" />{board.qrEnabled ? "Rotovat QR" : "Aktivovat QR"}
            </Button>
            {board.qrEnabled && (
              <>
                <Button size="icon" variant="outline" asChild title="Stáhnout samostatný QR kód">
                  <a href={`/api/switchboards/${board.id}/qr/png`}><Download className="h-4 w-4" /></a>
                </Button>
                <Button size="sm" variant="outline" onClick={() => deactivate.mutate()}>Deaktivovat</Button>
              </>
            )}
          </>
        )}
        {can("switchboards.labels.generate") && (
          <Button size="sm" disabled={!board.qrEnabled || generate.isPending} onClick={() => generate.mutate()}>
            Vygenerovat štítek
          </Button>
        )}
      </div>
      {lastUrl && (
        <div className="p-3 border-b bg-amber-50 dark:bg-amber-950/20 text-xs break-all">
          <strong>Nový veřejný odkaz:</strong>{" "}
          <a className="text-blue-600 underline" href={lastUrl} target="_blank" rel="noreferrer">{lastUrl}</a>
        </div>
      )}
      {data.length >= 2 && <div className="p-4 border-b bg-muted/20"><div className="text-sm font-medium flex items-center gap-2 mb-2"><GitCompareArrows className="h-4 w-4" />Porovnání verzí štítku</div><div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><Select value={compareFromId} onValueChange={setCompareFromId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{data.map((label) => <SelectItem key={label.id} value={String(label.id)}>Původní: verze {label.version}</SelectItem>)}</SelectContent></Select><Select value={compareToId} onValueChange={setCompareToId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{data.map((label) => <SelectItem key={label.id} value={String(label.id)}>Nová: verze {label.version}</SelectItem>)}</SelectContent></Select></div>{compareFromId === compareToId && <p className="text-xs text-destructive mt-2">Vyberte dvě rozdílné verze.</p>}{comparison.isLoading && <p className="text-xs text-muted-foreground mt-2">Porovnávám…</p>}{comparison.data && <div className="mt-3"><div className="text-xs text-muted-foreground mb-2">Verze {comparison.data.from.version} → {comparison.data.to.version} · změn: {comparison.data.changes.length}</div>{comparison.data.changes.length ? <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b"><th className="text-left py-2">Pole</th><th className="text-left py-2">Původní</th><th className="text-left py-2">Nová hodnota</th></tr></thead><tbody>{comparison.data.changes.map((change) => <tr key={change.fieldKey} className="border-b last:border-0"><td className="py-2 pr-3 font-medium">{SNAPSHOT_LABELS[change.fieldKey] ?? change.fieldKey}</td><td className="py-2 pr-3 text-red-700">{displaySnapshotValue(change.before)}</td><td className="py-2 text-emerald-700">{displaySnapshotValue(change.after)}</td></tr>)}</tbody></table></div> : <p className="text-xs text-emerald-700">Vstupní data štítků jsou shodná.</p>}</div>}</div>}
      <div className="divide-y">
        {data.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">Zatím nebyl vytvořen žádný štítek.</div>
        ) : data.map((label) => (
          <div key={label.id} className="p-4 flex items-center gap-3">
            <div className="flex-1">
              <div className="font-medium">Typový štítek · verze {label.version}</div>
              <div className="text-xs text-muted-foreground">
                {label.status === "approved" ? "Schválený" : "Návrh ke kontrole"} · generátor {label.generatorVersion}
              </div>
            </div>
            {label.status !== "approved" && can("switchboards.labels.approve") && (
              <Button size="sm" variant="outline" onClick={() => approve.mutate(label.id)}>
                <ShieldCheck className="h-4 w-4 mr-1" />Schválit
              </Button>
            )}
            <Button size="icon" variant="ghost" asChild title="PNG">
              <a href={`/api/switchboards/${board.id}/labels/${label.id}/png`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
            </Button>
            <Button size="icon" variant="ghost" asChild title="PDF">
              <a href={`/api/switchboards/${board.id}/labels/${label.id}/pdf`}><Download className="h-4 w-4" /></a>
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
