import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Save, ScanText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch, type SwitchboardFieldRegistry } from "@/lib/switchboards-api";

const TYPE_LABELS: Record<string, string> = {
  text: "Text", date: "Datum", dimensions: "Rozměry", current: "Elektrický proud",
  ip_rating: "Krytí IP", ik_rating: "Odolnost IK", network_system: "Síťová soustava",
  voltage: "Napětí", frequency: "Frekvence", weight: "Hmotnost", standards: "Normy",
};

function aliasesFromText(value: string): string[] {
  return value.split(/[,\n]+/).map((alias) => alias.trim()).filter(Boolean);
}

function FieldEditor({ field }: { field: SwitchboardFieldRegistry }) {
  const qc = useQueryClient(); const { toast } = useToast();
  const [aliases, setAliases] = useState(field.aliases.join(", "));
  const [required, setRequired] = useState(field.required);
  const [confidence, setConfidence] = useState(String(field.minimumConfidence));
  const [labelOrder, setLabelOrder] = useState(String(field.labelOrder));
  const [protocolOrder, setProtocolOrder] = useState(String(field.protocolOrder));
  const [active, setActive] = useState(field.isActive);
  const parsedAliases = useMemo(() => aliasesFromText(aliases), [aliases]);
  const confidenceNumber = Number(confidence); const labelOrderNumber = Number(labelOrder); const protocolOrderNumber = Number(protocolOrder);
  const valid = Number.isFinite(confidenceNumber) && confidenceNumber >= 0.5 && confidenceNumber <= 1 && Number.isInteger(labelOrderNumber) && labelOrderNumber >= 0 && Number.isInteger(protocolOrderNumber) && protocolOrderNumber >= 0;
  const dirty = aliases !== field.aliases.join(", ") || required !== field.required || confidenceNumber !== field.minimumConfidence || labelOrderNumber !== field.labelOrder || protocolOrderNumber !== field.protocolOrder || active !== field.isActive;
  const save = useMutation({
    mutationFn: () => switchboardFetch<SwitchboardFieldRegistry>(`/api/switchboards/field-registry/${field.id}`, { method: "PATCH", body: JSON.stringify({ aliases: parsedAliases, required, minimumConfidence: confidenceNumber, labelOrder: labelOrderNumber, protocolOrder: protocolOrderNumber, isActive: active }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["switchboard-field-registry"] }); toast({ title: `Pole ${field.canonicalNameCs} bylo uloženo` }); },
    onError: (error) => toast({ variant: "destructive", title: "Konfiguraci nelze uložit", description: error.message }),
  });
  return <div className={`p-4 border-b ${active ? "" : "bg-muted/30"}`}>
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0"><div className="font-semibold">{field.canonicalNameCs}</div><div className="text-xs text-muted-foreground">{field.fieldKey} · {TYPE_LABELS[field.dataType] ?? field.dataType} · {parsedAliases.length} aliasů</div></div>
      <Button size="sm" disabled={save.isPending || !dirty || !valid} onClick={() => save.mutate()}><Save className="h-4 w-4 mr-1" />Uložit</Button>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(16rem,1fr)_9rem_8rem_8rem] gap-3 mt-3">
      <div className="space-y-1"><Label htmlFor={`aliases-${field.id}`}>Povolené aliasy</Label><Input id={`aliases-${field.id}`} value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Alias 1, Alias 2" /></div>
      <div className="space-y-1"><Label htmlFor={`confidence-${field.id}`}>Min. jistota</Label><Input id={`confidence-${field.id}`} type="number" min="0.5" max="1" step="0.01" value={confidence} onChange={(event) => setConfidence(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor={`label-order-${field.id}`}>Pořadí štítek</Label><Input id={`label-order-${field.id}`} type="number" min="0" step="1" value={labelOrder} onChange={(event) => setLabelOrder(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor={`protocol-order-${field.id}`}>Pořadí protokol</Label><Input id={`protocol-order-${field.id}`} type="number" min="0" step="1" value={protocolOrder} onChange={(event) => setProtocolOrder(event.target.value)} /></div>
    </div>
    <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm">
      <label className="flex items-center gap-2"><Checkbox checked={required} onCheckedChange={(value) => setRequired(value === true)} />Povinné pole</label>
      <label className="flex items-center gap-2"><Checkbox checked={active} onCheckedChange={(value) => setActive(value === true)} />Aktivní v parseru</label>
    </div>
  </div>;
}

export default function SwitchboardParserSettings() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ["switchboard-field-registry"], queryFn: () => switchboardFetch<SwitchboardFieldRegistry[]>("/api/switchboards/field-registry") });
  return <div className="max-w-6xl mx-auto w-full p-4 md:p-6">
    <div className="mb-5"><h1 className="text-2xl font-bold flex items-center gap-2"><ScanText className="h-6 w-6 text-cyan-600" />Registr polí DBO parseru</h1><p className="text-sm text-muted-foreground mt-1">Centrální názvy, aliasy, jistota a pořadí v generovaných výstupech.</p></div>
    <div className="mb-4 flex gap-2 text-sm border-l-4 border-amber-500 bg-amber-50 dark:bg-amber-950/20 p-3"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-700" /><span>Kolizní alias nelze uložit. Změna se použije až při novém zpracování dokumentu; historické vytěžení zůstává zachováno.</span></div>
    {isLoading && <div className="text-sm text-muted-foreground">Načítám registr…</div>}
    {error && <div className="text-sm text-destructive">{error.message}</div>}
    <div className="border-y bg-card">{data.map((field) => <FieldEditor key={`${field.id}-${field.updatedAt}`} field={field} />)}</div>
  </div>;
}
