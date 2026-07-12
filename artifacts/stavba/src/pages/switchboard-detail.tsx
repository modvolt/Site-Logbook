import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircuitBoard, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { SwitchboardDocuments } from "@/components/switchboard-documents";
import { useToast } from "@/hooks/use-toast";
import { SWITCHBOARD_STATUS_LABELS, switchboardFetch, type Switchboard } from "@/lib/switchboards-api";

type Form = Pick<Switchboard, "internalName" | "designation" | "installationLocation" | "serialNumber" | "productionDate" | "typeDesignation" | "manufacturer" | "networkSystem" | "ratedVoltage" | "ratedFrequency" | "ratedCurrent" | "ipRating" | "ikRating" | "dimensions" | "weight" | "notes" | "status"> & { standards: string };
const empty: Form = { internalName: "", designation: "", installationLocation: "", serialNumber: "", productionDate: "", typeDesignation: "", manufacturer: "Modvolt s.r.o.", networkSystem: "", ratedVoltage: "", ratedFrequency: "", ratedCurrent: "", ipRating: "", ikRating: "", dimensions: "", weight: "", notes: "", status: "created", standards: "" };

export default function SwitchboardDetail() {
  const id = Number(useParams().id || 0);
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(empty);
  const { data: board, isLoading, error } = useQuery({ queryKey: ["switchboards", id], queryFn: () => switchboardFetch<Switchboard>(`/api/switchboards/${id}`), enabled: id > 0 });
  useEffect(() => { if (board) setForm({ ...empty, ...board, standards: board.standards.join(", ") }); }, [board]);
  const save = useMutation({
    mutationFn: () => switchboardFetch<Switchboard>(`/api/switchboards/${id}`, { method: "PATCH", body: JSON.stringify({
      ...form,
      installationLocation: form.installationLocation || null, serialNumber: form.serialNumber || null,
      productionDate: form.productionDate || null, typeDesignation: form.typeDesignation || null,
      networkSystem: form.networkSystem || null, ratedVoltage: form.ratedVoltage || null,
      ratedFrequency: form.ratedFrequency || null, ratedCurrent: form.ratedCurrent || null,
      ipRating: form.ipRating || null, ikRating: form.ikRating || null, dimensions: form.dimensions || null,
      weight: form.weight || null, notes: form.notes || null,
      standards: form.standards.split(",").map((v) => v.trim()).filter(Boolean),
    }) }),
    onSuccess: (data) => { qc.setQueryData(["switchboards", id], data); void qc.invalidateQueries({ queryKey: ["switchboards"] }); toast({ title: "Rozvaděč uložen" }); },
    onError: (err) => toast({ variant: "destructive", title: "Uložení selhalo", description: err.message }),
  });
  const set = (key: keyof Form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Načítám rozvaděč…</div>;
  if (error || !board) return <div className="p-8 text-center text-destructive">{error?.message ?? "Rozvaděč nebyl nalezen."}</div>;
  const disabled = !can("switchboards.update");
  const fields: Array<[keyof Form, string, string]> = [
    ["designation", "Označení rozvaděče", "R1"], ["internalName", "Interní název", "Hlavní rozvaděč"],
    ["installationLocation", "Místo instalace", "1. NP"], ["serialNumber", "Výrobní číslo", ""],
    ["productionDate", "Datum výroby", ""], ["typeDesignation", "Typ", ""], ["manufacturer", "Výrobce", ""],
    ["networkSystem", "Soustava", "TN-C-S"], ["ratedVoltage", "Jmenovité napětí", "400 V"],
    ["ratedFrequency", "Frekvence", "50 Hz"], ["ratedCurrent", "Jmenovitý proud", "63 A"],
    ["ipRating", "IP", "IP40"], ["ikRating", "IK", "IK08"], ["dimensions", "Rozměry", "600 × 800 × 250 mm"], ["weight", "Hmotnost", "35 kg"],
  ];
  return (
    <div className="max-w-4xl mx-auto w-full p-4 md:p-6 pb-24">
      <div className="flex items-center gap-3 mb-5"><Button variant="ghost" size="icon" asChild><Link href="/switchboards"><ArrowLeft className="h-5 w-5" /></Link></Button><CircuitBoard className="h-6 w-6 text-cyan-600" /><div className="flex-1"><h1 className="text-xl font-bold">{board.designation}</h1><p className="text-xs text-muted-foreground">Zakázka #{board.job?.jobNumber ?? board.jobId} · {board.job?.title}</p></div></div>
      <div className="border-y bg-card p-4 md:p-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fields.map(([key, label, placeholder]) => <div className="space-y-1.5" key={key}><Label htmlFor={`board-${key}`}>{label}</Label><Input id={`board-${key}`} type={key === "productionDate" ? "date" : "text"} value={String(form[key] ?? "")} placeholder={placeholder} disabled={disabled} onChange={(e) => set(key, e.target.value)} /></div>)}
          <div className="space-y-1.5"><Label>Stav</Label><Select value={form.status} disabled={disabled} onValueChange={(value) => set("status", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(SWITCHBOARD_STATUS_LABELS).filter(([value]) => value !== "archived").map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="board-standards">Použité normy</Label><Input id="board-standards" value={form.standards} disabled={disabled} onChange={(e) => set("standards", e.target.value)} placeholder="ČSN EN 61439-1, ČSN EN 61439-3" /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="board-notes">Poznámka</Label><Textarea id="board-notes" rows={4} value={form.notes ?? ""} disabled={disabled} onChange={(e) => set("notes", e.target.value)} /></div>
        {!disabled && <Button className="w-full md:w-auto" disabled={!form.designation.trim() || !form.internalName.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}Uložit změny</Button>}
      </div>
      <SwitchboardDocuments switchboardId={id} />
    </div>
  );
}
