import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ClipboardList, GitCompareArrows, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  switchboardFetch,
  type SwitchboardChecklistDefinition,
  type SwitchboardChecklistDefinitionItem,
  type SwitchboardChecklistTemplate,
  type SwitchboardChecklistTemplateVersion,
} from "@/lib/switchboards-api";

const PHASE_LABELS: Record<string, string> = { assembly: "Sestavení a zapojení", inspection: "Kontrola před zapnutím", measurement: "Měření a dokončení" };
const KIND_LABELS: Record<string, string> = { check: "Kontrolní bod", measurement: "Měření", photo: "Fotografie" };

function emptyDefinition(): SwitchboardChecklistDefinition {
  return {
    schemaVersion: 1,
    phases: (["assembly", "inspection", "measurement"] as const).map((key) => ({
      key,
      title: PHASE_LABELS[key],
      items: [{ key: `${key}_item_1`, title: "Nový kontrolní bod", details: [], required: true, critical: false, kind: "check" }],
    })),
  };
}

function cloneDefinition(value: SwitchboardChecklistDefinition): SwitchboardChecklistDefinition {
  return JSON.parse(JSON.stringify(value)) as SwitchboardChecklistDefinition;
}

function normalizeDefinition(value: SwitchboardChecklistDefinition): SwitchboardChecklistDefinition {
  const normalized = cloneDefinition(value);
  for (const phase of normalized.phases) {
    phase.title = phase.title.trim();
    for (const item of phase.items) {
      item.key = item.key.trim();
      item.title = item.title.trim();
      item.details = item.details.map((detail) => detail.trim()).filter(Boolean);
      if (item.relevance) item.relevance.property = item.relevance.property.trim();
    }
  }
  return normalized;
}

function definitionErrors(definition: SwitchboardChecklistDefinition | null): string[] {
  if (!definition) return ["Šablona nemá definici."];
  const errors: string[] = []; const keys = new Set<string>();
  for (const phase of definition.phases) {
    if (!phase.title.trim() || phase.title.trim().length < 3) errors.push(`Fáze ${phase.key} nemá platný název.`);
    if (!phase.items.length) errors.push(`Fáze ${phase.title} musí obsahovat alespoň jednu položku.`);
    for (const item of phase.items) {
      if (!/^[a-z0-9_]+$/.test(item.key)) errors.push(`Klíč „${item.key}“ smí obsahovat jen malá písmena, čísla a podtržítko.`);
      if (keys.has(item.key)) errors.push(`Klíč „${item.key}“ je v šabloně dvakrát.`);
      keys.add(item.key);
      if (item.title.trim().length < 3) errors.push(`Položka ${item.key} nemá platný název.`);
      if (item.relevance && !item.relevance.property.trim()) errors.push(`Položka ${item.key} má prázdnou podmínku použití.`);
    }
  }
  return [...new Set(errors)];
}

type DefinitionChange = { key: string; label: string; kind: "added" | "removed" | "changed" };
function compareDefinitions(before: SwitchboardChecklistDefinition, after: SwitchboardChecklistDefinition): DefinitionChange[] {
  const flatten = (definition: SwitchboardChecklistDefinition) => new Map(definition.phases.flatMap((phase) => phase.items.map((item) => [item.key, { phaseKey: phase.key, ...item }] as const)));
  const left = flatten(before); const right = flatten(after); const changes: DefinitionChange[] = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const oldItem = left.get(key); const newItem = right.get(key);
    if (!oldItem && newItem) changes.push({ key, label: newItem.title, kind: "added" });
    else if (oldItem && !newItem) changes.push({ key, label: oldItem.title, kind: "removed" });
    else if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) changes.push({ key, label: newItem?.title ?? oldItem?.title ?? key, kind: "changed" });
  }
  return changes;
}

function ItemEditor({ item, index, total, onChange, onMove, onRemove }: { item: SwitchboardChecklistDefinitionItem; index: number; total: number; onChange: (patch: Partial<SwitchboardChecklistDefinitionItem>) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void }) {
  return <div className="border-b p-4 last:border-b-0">
    <div className="flex items-start gap-2">
      <div className="grid grid-cols-1 md:grid-cols-[11rem_minmax(14rem,1fr)_10rem] gap-3 flex-1 min-w-0">
        <div className="space-y-1"><Label>Interní klíč</Label><Input value={item.key} onChange={(event) => onChange({ key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></div>
        <div className="space-y-1"><Label>Název kontrolního bodu</Label><Input value={item.title} onChange={(event) => onChange({ title: event.target.value })} /></div>
        <div className="space-y-1"><Label>Typ záznamu</Label><Select value={item.kind} onValueChange={(kind: "check" | "measurement" | "photo") => onChange({ kind })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(KIND_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="flex shrink-0">
        <Button type="button" size="icon" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} title="Posunout nahoru"><ArrowUp className="h-4 w-4" /></Button>
        <Button type="button" size="icon" variant="ghost" disabled={index + 1 === total} onClick={() => onMove(1)} title="Posunout dolů"><ArrowDown className="h-4 w-4" /></Button>
        <Button type="button" size="icon" variant="ghost" disabled={total === 1} onClick={onRemove} title="Odebrat položku"><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(16rem,1fr)_14rem] gap-3 mt-3">
      <div className="space-y-1"><Label>Podrobnosti, každá na samostatném řádku</Label><Textarea rows={2} value={item.details.join("\n")} onChange={(event) => onChange({ details: event.target.value.split("\n") })} /></div>
      <div className="space-y-2"><Label>Podmíněné zobrazení</Label><Input value={item.relevance?.property ?? ""} onChange={(event) => onChange({ relevance: event.target.value ? { property: event.target.value, equals: item.relevance?.equals ?? true } : undefined })} placeholder="např. hasRcd" /><label className="flex items-center gap-2 text-sm"><Checkbox disabled={!item.relevance} checked={item.relevance?.equals ?? true} onCheckedChange={(value) => item.relevance && onChange({ relevance: { ...item.relevance, equals: value === true } })} />Vlastnost musí platit</label></div>
    </div>
    <div className="flex flex-wrap gap-5 mt-3 text-sm"><label className="flex items-center gap-2"><Checkbox checked={item.required} onCheckedChange={(value) => onChange({ required: value === true })} />Povinné</label><label className="flex items-center gap-2"><Checkbox checked={item.critical} onCheckedChange={(value) => onChange({ critical: value === true })} />Kritické</label></div>
  </div>;
}

export default function SwitchboardTemplateSettings() {
  const { toast } = useToast(); const qc = useQueryClient();
  const { data = [], isLoading, error } = useQuery({ queryKey: ["switchboard-checklist-templates"], queryFn: () => switchboardFetch<SwitchboardChecklistTemplate[]>("/api/switchboards/checklist-templates") });
  const [templateId, setTemplateId] = useState(""); const [versionId, setVersionId] = useState(""); const [compareVersionId, setCompareVersionId] = useState("");
  const [definition, setDefinition] = useState<SwitchboardChecklistDefinition | null>(null); const [name, setName] = useState(""); const [boardType, setBoardType] = useState("");
  const [createOpen, setCreateOpen] = useState(false); const [newName, setNewName] = useState(""); const [newBoardType, setNewBoardType] = useState("");
  const template = data.find((item) => String(item.id) === templateId) ?? data[0] ?? null;
  const version = template?.versions.find((item) => String(item.id) === versionId) ?? template?.versions[0] ?? null;
  const compareVersion = compareVersionId ? template?.versions.find((item) => String(item.id) === compareVersionId) ?? null : null;
  useEffect(() => { if (!templateId && data[0]) setTemplateId(String(data[0].id)); }, [data, templateId]);
  useEffect(() => { if (!template) return; setName(template.name); setBoardType(template.boardType ?? ""); if (!template.versions.some((item) => String(item.id) === versionId)) setVersionId(String(template.versions[0]?.id ?? "")); }, [template?.id]);
  useEffect(() => { if (version) setDefinition(cloneDefinition(version.definition)); }, [version?.id]);
  useEffect(() => { if (!template || !version) return; if (!template.versions.some((item) => String(item.id) === compareVersionId && item.id !== version.id)) setCompareVersionId(String(template.versions.find((item) => item.id !== version.id)?.id ?? "")); }, [template?.id, template?.versions.length, version?.id]);
  const preparedDefinition = useMemo(() => definition ? normalizeDefinition(definition) : null, [definition]);
  const errors = definitionErrors(preparedDefinition); const metadataDirty = !!template && (name.trim() !== template.name || (boardType.trim() || null) !== template.boardType);
  const versionDirty = !!preparedDefinition && !!version && JSON.stringify(preparedDefinition) !== JSON.stringify(version.definition);
  const differences = useMemo(() => version && compareVersion ? compareDefinitions(compareVersion.definition, version.definition) : [], [version, compareVersion]);

  const create = useMutation({ mutationFn: () => switchboardFetch<{ template: SwitchboardChecklistTemplate; version: SwitchboardChecklistTemplateVersion }>("/api/switchboards/checklist-templates", { method: "POST", body: JSON.stringify({ name: newName.trim(), boardType: newBoardType.trim() || null, definition: emptyDefinition() }) }), onSuccess: (result) => { void qc.invalidateQueries({ queryKey: ["switchboard-checklist-templates"] }); setTemplateId(String(result.template.id)); setCreateOpen(false); setNewName(""); setNewBoardType(""); toast({ title: "Checklistová šablona byla založena" }); }, onError: (reason) => toast({ variant: "destructive", title: "Šablonu nelze založit", description: reason.message }) });
  const saveMetadata = useMutation({ mutationFn: () => switchboardFetch(`/api/switchboards/checklist-templates/${template!.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), boardType: boardType.trim() || null }) }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["switchboard-checklist-templates"] }); toast({ title: "Název a typ šablony byly uloženy" }); }, onError: (reason) => toast({ variant: "destructive", title: "Metadata nelze uložit", description: reason.message }) });
  const saveVersion = useMutation({ mutationFn: () => switchboardFetch<SwitchboardChecklistTemplateVersion>(`/api/switchboards/checklist-templates/${template!.id}/versions`, { method: "POST", body: JSON.stringify({ definition: preparedDefinition }) }), onSuccess: (created) => { void qc.invalidateQueries({ queryKey: ["switchboard-checklist-templates"] }); setVersionId(String(created.id)); toast({ title: `Byla vytvořena verze ${created.version}` }); }, onError: (reason) => toast({ variant: "destructive", title: "Novou verzi nelze vytvořit", description: reason.message }) });
  const activate = useMutation({ mutationFn: () => switchboardFetch(`/api/switchboards/checklist-templates/${template!.id}/active`, { method: "PATCH", body: JSON.stringify({ isActive: !template!.isActive }) }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["switchboard-checklist-templates"] }); toast({ title: template?.isActive ? "Šablona byla deaktivována" : "Šablona byla aktivována" }); } });

  const changePhase = (phaseIndex: number, patch: Partial<SwitchboardChecklistDefinition["phases"][number]>) => setDefinition((current) => { if (!current) return current; const next = cloneDefinition(current); next.phases[phaseIndex] = { ...next.phases[phaseIndex], ...patch }; return next; });
  const changeItem = (phaseIndex: number, itemIndex: number, patch: Partial<SwitchboardChecklistDefinitionItem>) => setDefinition((current) => { if (!current) return current; const next = cloneDefinition(current); next.phases[phaseIndex].items[itemIndex] = { ...next.phases[phaseIndex].items[itemIndex], ...patch }; return next; });
  const moveItem = (phaseIndex: number, itemIndex: number, direction: -1 | 1) => setDefinition((current) => { if (!current) return current; const next = cloneDefinition(current); const items = next.phases[phaseIndex].items; const [item] = items.splice(itemIndex, 1); items.splice(itemIndex + direction, 0, item); return next; });
  const removeItem = (phaseIndex: number, itemIndex: number) => setDefinition((current) => { if (!current) return current; const next = cloneDefinition(current); next.phases[phaseIndex].items.splice(itemIndex, 1); return next; });
  const addItem = (phaseIndex: number) => setDefinition((current) => { if (!current) return current; const next = cloneDefinition(current); const phase = next.phases[phaseIndex]; let suffix = phase.items.length + 1; while (next.phases.some((candidate) => candidate.items.some((item) => item.key === `${phase.key}_item_${suffix}`))) suffix += 1; phase.items.push({ key: `${phase.key}_item_${suffix}`, title: "Nový kontrolní bod", details: [], required: true, critical: false, kind: "check" }); return next; });

  return <div className="max-w-7xl mx-auto w-full p-4 md:p-6">
    <div className="mb-5 flex flex-wrap items-start gap-3"><div className="flex-1"><h1 className="text-2xl font-bold flex items-center gap-2"><ClipboardList className="h-6 w-6 text-cyan-600" />Checklistové šablony</h1><p className="text-sm text-muted-foreground mt-1">Neměnné verze pro tři pracovní fáze rozvaděče.</p></div><Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" />Nová šablona</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Nová checklistová šablona</DialogTitle></DialogHeader><div className="space-y-3"><div className="space-y-1"><Label>Název</Label><Input value={newName} onChange={(event) => setNewName(event.target.value)} /></div><div className="space-y-1"><Label>Typ rozvaděče</Label><Input value={newBoardType} onChange={(event) => setNewBoardType(event.target.value)} placeholder="Nepovinné" /></div></div><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>Zrušit</Button><Button disabled={newName.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>Založit</Button></DialogFooter></DialogContent></Dialog></div>
    {isLoading && <div className="text-sm text-muted-foreground">Načítám šablony…</div>}{error && <div className="text-sm text-destructive">{error.message}</div>}
    {template && version && definition && <>
      <div className="border-y bg-card p-4 grid grid-cols-1 lg:grid-cols-[minmax(14rem,1fr)_minmax(14rem,1fr)_12rem_auto] gap-3 items-end">
        <div className="space-y-1"><Label>Šablona</Label><Select value={String(template.id)} onValueChange={(value) => { setTemplateId(value); setVersionId(""); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{data.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}{item.isActive ? "" : " (neaktivní)"}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label>Název</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="space-y-1"><Label>Typ rozvaděče</Label><Input value={boardType} onChange={(event) => setBoardType(event.target.value)} placeholder="Všechny typy" /></div>
        <div className="flex gap-2"><Button variant="outline" disabled={!metadataDirty || name.trim().length < 3 || saveMetadata.isPending} onClick={() => saveMetadata.mutate()}><Save className="h-4 w-4 mr-1" />Metadata</Button><Button variant={template.isActive ? "outline" : "default"} disabled={activate.isPending} onClick={() => activate.mutate()}>{template.isActive ? "Deaktivovat" : "Aktivovat"}</Button></div>
      </div>
      <div className="border-b bg-muted/20 p-4 grid grid-cols-1 md:grid-cols-[16rem_16rem_1fr] gap-3 items-end">
        <div className="space-y-1"><Label>Editovaná verze</Label><Select value={String(version.id)} onValueChange={setVersionId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{template.versions.map((item) => <SelectItem key={item.id} value={String(item.id)}>Verze {item.version} · {new Date(item.createdAt).toLocaleString("cs-CZ")}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label>Porovnat s</Label><Select value={compareVersion ? String(compareVersion.id) : "none"} onValueChange={(value) => setCompareVersionId(value === "none" ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Bez porovnání</SelectItem>{template.versions.filter((item) => item.id !== version.id).map((item) => <SelectItem key={item.id} value={String(item.id)}>Verze {item.version}</SelectItem>)}</SelectContent></Select></div>
        <div className="text-xs text-muted-foreground md:text-right">Historická verze se nikdy nepřepisuje. Uložení editoru vytvoří novou verzi.</div>
      </div>
      {compareVersion && <div className="border-b p-4 bg-blue-50/60 dark:bg-blue-950/20"><div className="font-medium text-sm flex items-center gap-2"><GitCompareArrows className="h-4 w-4" />Rozdíly verze {compareVersion.version} → {version.version}</div>{differences.length ? <div className="mt-2 flex flex-wrap gap-2">{differences.map((change) => <span key={change.key} className={`text-xs px-2 py-1 border ${change.kind === "added" ? "border-emerald-300 text-emerald-700" : change.kind === "removed" ? "border-red-300 text-red-700" : "border-amber-300 text-amber-700"}`}>{change.kind === "added" ? "Přidáno" : change.kind === "removed" ? "Odebráno" : "Změněno"}: {change.label}</span>)}</div> : <p className="text-xs text-muted-foreground mt-2">Verze nemají rozdíly v položkách.</p>}</div>}
      {definition.phases.map((phase, phaseIndex) => <section key={phase.key} className="mt-5 border-y bg-card"><div className="p-4 border-b flex flex-wrap items-end gap-3"><div className="space-y-1 flex-1 min-w-64"><Label>Název fáze · {phase.key}</Label><Input value={phase.title} onChange={(event) => changePhase(phaseIndex, { title: event.target.value })} /></div><Button type="button" variant="outline" onClick={() => addItem(phaseIndex)}><Plus className="h-4 w-4 mr-1" />Přidat bod</Button></div>{phase.items.map((item, itemIndex) => <ItemEditor key={`${item.key}-${itemIndex}`} item={item} index={itemIndex} total={phase.items.length} onChange={(patch) => changeItem(phaseIndex, itemIndex, patch)} onMove={(direction) => moveItem(phaseIndex, itemIndex, direction)} onRemove={() => removeItem(phaseIndex, itemIndex)} />)}</section>)}
      <div className="sticky bottom-4 mt-5 border bg-background/95 backdrop-blur p-3 flex flex-wrap items-center gap-3 shadow-lg"><div className="flex-1 min-w-48 text-sm">{errors.length ? <span className="text-destructive">{errors[0]}{errors.length > 1 ? ` (+${errors.length - 1})` : ""}</span> : versionDirty ? <span>Editor obsahuje neuložené změny.</span> : <span className="text-emerald-700 flex items-center gap-1"><Check className="h-4 w-4" />Definice odpovídá vybrané verzi.</span>}</div><Button variant="outline" disabled={!versionDirty} onClick={() => setDefinition(cloneDefinition(version.definition))}>Vrátit změny</Button><Button disabled={!versionDirty || errors.length > 0 || saveVersion.isPending} onClick={() => saveVersion.mutate()}><Save className="h-4 w-4 mr-1" />Vytvořit novou verzi</Button></div>
    </>}
  </div>;
}
