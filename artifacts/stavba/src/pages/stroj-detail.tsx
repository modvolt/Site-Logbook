import { useEffect, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import QRCode from "qrcode";
import {
  useGetMachine,
  useUpdateMachine,
  useDeleteMachine,
  useListPeople,
  getGetMachineQueryKey,
  getListMachinesQueryKey,
  getListPeopleQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Pencil, Download, Save, X, User, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { BarcodeScanner } from "@/components/barcode-scanner";
import { MACHINE_KINDS } from "./stroje";

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between py-2 border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value || "—"}</span>
    </div>
  );
}

export default function StrojDetail() {
  const params = useParams();
  const id = Number(params.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [form, setForm] = useState({
    name: "", kind: "stroj", type: "", manufacturer: "", serialNumber: "", purchaseDate: "",
    licensePlate: "", vin: "", mileageKm: "", inspectionDate: "", assignedPersonId: "none", notes: "",
  });

  const { data: machine, isLoading } = useGetMachine(id, {
    query: { queryKey: getGetMachineQueryKey(id), enabled: Number.isFinite(id) },
  });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const updateMachine = useUpdateMachine();
  const deleteMachine = useDeleteMachine();

  const qrText = machine
    ? [
        "STAVBA STROJ",
        `Název: ${machine.name}`,
        `Druh: ${MACHINE_KINDS[machine.kind]?.label ?? machine.kind}`,
        machine.type ? `Typ: ${machine.type}` : null,
        machine.manufacturer ? `Výrobce: ${machine.manufacturer}` : null,
        machine.serialNumber ? `Sériové číslo: ${machine.serialNumber}` : null,
        machine.licensePlate ? `SPZ: ${machine.licensePlate}` : null,
        machine.vin ? `VIN: ${machine.vin}` : null,
        machine.mileageKm != null ? `Stav km: ${machine.mileageKm}` : null,
        machine.inspectionDate ? `STK / revize: ${machine.inspectionDate}` : null,
        machine.assignedPersonName ? `Přiřazeno: ${machine.assignedPersonName}` : null,
        `ID stroje: ${id}`,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  useEffect(() => {
    if (!qrText) {
      setQrUrl(null);
      return;
    }
    QRCode.toDataURL(qrText, { width: 320, margin: 2 })
      .then(setQrUrl)
      .catch(() => setQrUrl(null));
  }, [qrText]);

  useEffect(() => {
    if (machine) {
      setForm({
        name: machine.name,
        kind: machine.kind ?? "stroj",
        type: machine.type ?? "",
        manufacturer: machine.manufacturer ?? "",
        serialNumber: machine.serialNumber ?? "",
        purchaseDate: machine.purchaseDate ?? "",
        licensePlate: machine.licensePlate ?? "",
        vin: machine.vin ?? "",
        mileageKm: machine.mileageKm != null ? String(machine.mileageKm) : "",
        inspectionDate: machine.inspectionDate ?? "",
        assignedPersonId: machine.assignedPersonId != null ? machine.assignedPersonId.toString() : "none",
        notes: machine.notes ?? "",
      });
    }
  }, [machine]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const isAuto = form.kind === "auto";
    updateMachine.mutate(
      {
        id,
        data: {
          name: form.name.trim(),
          kind: form.kind,
          type: !isAuto ? form.type.trim() || null : null,
          manufacturer: !isAuto ? form.manufacturer.trim() || null : null,
          serialNumber: !isAuto ? form.serialNumber.trim() || null : null,
          purchaseDate: !isAuto ? form.purchaseDate || null : null,
          licensePlate: isAuto ? form.licensePlate.trim() || null : null,
          vin: isAuto ? form.vin.trim() || null : null,
          mileageKm: isAuto && form.mileageKm ? parseInt(form.mileageKm) : null,
          inspectionDate: form.inspectionDate || null,
          assignedPersonId: form.assignedPersonId !== "none" ? parseInt(form.assignedPersonId) : null,
          notes: form.notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateData(queryClient, "machines");
          setEditing(false);
          toast({ title: "Uloženo" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      },
    );
  };

  const handleAssign = (value: string) => {
    if (!machine) return;
    updateMachine.mutate(
      { id, data: { assignedPersonId: value !== "none" ? parseInt(value) : null } },
      {
        onSuccess: () => {
          invalidateData(queryClient, "machines");
          toast({ title: value !== "none" ? "Přiřazeno" : "Přiřazení zrušeno" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      },
    );
  };

  const handleDelete = () => {
    if (!confirm("Opravdu chcete smazat tento stroj?")) return;
    deleteMachine.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateData(queryClient, "machines");
          toast({ title: "Stroj smazán" });
          setLocation("/stroje");
        },
        onError: () => toast({ title: "Nepodařilo se smazat", variant: "destructive" }),
      },
    );
  };

  const handleDownloadQr = () => {
    if (!qrUrl || !machine) return;
    const a = document.createElement("a");
    a.href = qrUrl;
    a.download = `qr-${machine.name.replace(/\s+/g, "-")}.png`;
    a.click();
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!machine) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        <p>Stroj nenalezen.</p>
        <Link href="/stroje" className="text-primary underline mt-4 inline-block">Zpět na stroje</Link>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <Link href="/stroje" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-4 w-4" /> Zpět na stroje
      </Link>

      <div className="flex items-center justify-between mb-6 gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="bg-primary/10 p-3 rounded-full text-primary shrink-0">
            {(() => {
              const HeaderIcon = (MACHINE_KINDS[machine.kind] ?? MACHINE_KINDS.stroj).icon;
              return <HeaderIcon className="h-6 w-6" />;
            })()}
          </div>
          <h1 className="text-2xl font-bold truncate">{machine.name}</h1>
        </div>
        {can("write") && !editing && (
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="icon" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></Button>
            <Button variant="outline" size="icon" className="text-destructive" onClick={handleDelete} disabled={deleteMachine.isPending}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Údaje o stroji</CardTitle>
          </CardHeader>
          <CardContent>
            {editing ? (
              <form onSubmit={handleSave} className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(MACHINE_KINDS).map(([key, cfg]) => {
                    const Icon = cfg.icon;
                    const selected = form.kind === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setForm({ ...form, kind: key })}
                        className={`flex flex-col items-center justify-center gap-1 rounded-lg border p-2.5 transition-colors ${selected ? "border-primary bg-primary/10 text-primary" : "border-input bg-background text-muted-foreground hover:bg-muted"}`}
                      >
                        <Icon className="h-5 w-5" />
                        <span className="text-xs font-medium">{cfg.label}</span>
                      </button>
                    );
                  })}
                </div>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Název *" className="h-11" />
                {form.kind === "auto" ? (
                  <>
                    <Input value={form.licensePlate} onChange={(e) => setForm({ ...form, licensePlate: e.target.value })} placeholder="SPZ" className="h-11" />
                    <Input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} placeholder="VIN" className="h-11" />
                    <Input type="number" value={form.mileageKm} onChange={(e) => setForm({ ...form, mileageKm: e.target.value })} placeholder="Stav tachometru (km)" className="h-11" />
                    <div>
                      <label className="text-xs text-muted-foreground ml-1">STK do</label>
                      <Input type="date" value={form.inspectionDate} onChange={(e) => setForm({ ...form, inspectionDate: e.target.value })} className="h-11" />
                    </div>
                  </>
                ) : (
                  <>
                    <Input value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="Typ" className="h-11" />
                    <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} placeholder="Výrobce" className="h-11" />
                    <div className="flex gap-2">
                      <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} placeholder="Sériové číslo" className="h-11 flex-1" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-11 w-11 shrink-0"
                        onClick={() => setScannerOpen(true)}
                        aria-label="Naskenovat sériové číslo fotoaparátem"
                        title="Naskenovat sériové číslo fotoaparátem"
                      >
                        <ScanLine className="h-5 w-5" />
                      </Button>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground ml-1">Datum nákupu</label>
                      <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} className="h-11" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground ml-1">Revize do</label>
                      <Input type="date" value={form.inspectionDate} onChange={(e) => setForm({ ...form, inspectionDate: e.target.value })} className="h-11" />
                    </div>
                  </>
                )}
                <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Poznámka" className="h-11" />
                <BarcodeScanner
                  open={scannerOpen}
                  onOpenChange={setScannerOpen}
                  onResult={(text) => {
                    setForm((f) => ({ ...f, serialNumber: text }));
                    toast({ title: "Sériové číslo naskenováno" });
                  }}
                />
                <div className="flex gap-2 justify-end">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}><X className="h-4 w-4 mr-1" /> Zrušit</Button>
                  <Button type="submit" disabled={!form.name.trim() || updateMachine.isPending}><Save className="h-4 w-4 mr-1" /> Uložit</Button>
                </div>
              </form>
            ) : (
              <div className="text-sm">
                <DetailRow label="Druh" value={(MACHINE_KINDS[machine.kind] ?? MACHINE_KINDS.stroj).label} />
                {machine.kind === "auto" ? (
                  <>
                    <DetailRow label="SPZ" value={machine.licensePlate} />
                    <DetailRow label="VIN" value={machine.vin} />
                    <DetailRow label="Stav tachometru" value={machine.mileageKm != null ? `${machine.mileageKm.toLocaleString("cs-CZ")} km` : null} />
                    <DetailRow label="STK do" value={machine.inspectionDate} />
                  </>
                ) : (
                  <>
                    <DetailRow label="Typ" value={machine.type} />
                    <DetailRow label="Výrobce" value={machine.manufacturer} />
                    <DetailRow label="Sériové číslo" value={machine.serialNumber} />
                    <DetailRow label="Datum nákupu" value={machine.purchaseDate} />
                    <DetailRow label="Revize do" value={machine.inspectionDate} />
                  </>
                )}
                <DetailRow label="Poznámka" value={machine.notes} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><User className="h-4 w-4" /> Přiřazení</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Komu je {machine.kind === "auto" ? "vozidlo" : machine.kind === "naradi" ? "nářadí" : "stroj"} aktuálně přiřazeno. Změna se uloží okamžitě.
            </p>
            {can("write") ? (
              <Select value={form.assignedPersonId} onValueChange={handleAssign} disabled={updateMachine.isPending}>
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Přiřadit zaměstnanci" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nepřiřazeno</SelectItem>
                  {people?.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center gap-2 text-base font-medium">
                <User className="h-4 w-4 text-primary" /> {machine.assignedPersonName || "Nepřiřazeno"}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">QR kód</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {qrUrl ? (
              <img src={qrUrl} alt="QR kód stroje" className="w-56 h-56 rounded-lg border bg-white" />
            ) : (
              <Skeleton className="w-56 h-56" />
            )}
            <p className="text-xs text-muted-foreground text-center">
              Vytiskněte a nalepte na stroj. Kód obsahuje údaje o stroji jako text –
              libovolná čtečka je zobrazí. Naskenováním v aplikaci otevřete tento detail.
            </p>
            <Button variant="outline" onClick={handleDownloadQr} disabled={!qrUrl} className="w-full">
              <Download className="h-4 w-4 mr-2" /> Stáhnout QR kód
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
