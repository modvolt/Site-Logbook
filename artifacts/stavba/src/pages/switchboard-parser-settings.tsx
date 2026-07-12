import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ScanText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch } from "@/lib/switchboards-api";

type RegistryField = { id: number; fieldKey: string; canonicalNameCs: string; aliases: string[]; dataType: string; required: boolean; minimumConfidence: number; labelOrder: number; protocolOrder: number; isActive: boolean; updatedAt: string };

function FieldEditor({ field }: { field: RegistryField }) {
  const qc = useQueryClient(); const { toast } = useToast();
  const [aliases, setAliases] = useState(field.aliases.join(", ")); const [required, setRequired] = useState(field.required); const [confidence, setConfidence] = useState(String(field.minimumConfidence)); const [active, setActive] = useState(field.isActive);
  const save = useMutation({ mutationFn: () => switchboardFetch<RegistryField>(`/api/switchboards/field-registry/${field.id}`, { method: "PATCH", body: JSON.stringify({ aliases: aliases.split(",").map((value) => value.trim()).filter(Boolean), required, minimumConfidence: Number(confidence), isActive: active }) }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["switchboard-field-registry"] }); toast({ title: `Pole ${field.canonicalNameCs} uloženo` }); }, onError: (error) => toast({ variant: "destructive", title: "Uložení selhalo", description: error.message }) });
  return <div className="p-4 border-b"><div className="flex items-start gap-3"><div className="flex-1"><div className="font-semibold">{field.canonicalNameCs}</div><div className="text-xs text-muted-foreground">{field.fieldKey} · {field.dataType}</div></div><Button size="sm" disabled={save.isPending || Number(confidence) < 0.5 || Number(confidence) > 1} onClick={() => save.mutate()}><Save className="h-4 w-4 mr-1" />Uložit</Button></div><div className="grid grid-cols-1 md:grid-cols-[1fr_9rem] gap-3 mt-3"><div className="space-y-1"><Label htmlFor={`aliases-${field.id}`}>Povolené aliasy, oddělené čárkou</Label><Input id={`aliases-${field.id}`} value={aliases} onChange={(event) => setAliases(event.target.value)} /></div><div className="space-y-1"><Label htmlFor={`confidence-${field.id}`}>Minimální jistota</Label><Input id={`confidence-${field.id}`} type="number" min="0.5" max="1" step="0.01" value={confidence} onChange={(event) => setConfidence(event.target.value)} /></div></div><div className="flex gap-6 mt-3 text-sm"><label className="flex items-center gap-2"><Checkbox checked={required} onCheckedChange={(value) => setRequired(value === true)} />Povinné pole</label><label className="flex items-center gap-2"><Checkbox checked={active} onCheckedChange={(value) => setActive(value === true)} />Aktivní</label></div></div>;
}

export default function SwitchboardParserSettings() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ["switchboard-field-registry"], queryFn: () => switchboardFetch<RegistryField[]>("/api/switchboards/field-registry") });
  return <div className="max-w-5xl mx-auto w-full p-4 md:p-6"><div className="mb-5"><h1 className="text-2xl font-bold flex items-center gap-2"><ScanText className="h-6 w-6 text-cyan-600" />Registr polí DBO parseru</h1><p className="text-sm text-muted-foreground mt-1">Parser vždy nejprve hledá zde definovaný název nebo alias a až potom hodnotu.</p></div>{isLoading && <div className="text-sm text-muted-foreground">Načítám registr…</div>}{error && <div className="text-sm text-destructive">{error.message}</div>}<div className="border-y bg-card">{data.map((field) => <FieldEditor key={`${field.id}-${field.updatedAt ?? ""}`} field={field} />)}</div></div>;
}
