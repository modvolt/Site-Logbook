import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListMachines,
  useCreateMachine,
  useListPeople,
  getListMachinesQueryKey,
  getListPeopleQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Wrench, Plus, ChevronRight, QrCode, User, Hammer, Car, ShieldCheck, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { BarcodeScanner } from "@/components/barcode-scanner";

export const MACHINE_KINDS: Record<string, { label: string; icon: typeof Wrench }> = {
  stroj: { label: "Stroj", icon: Wrench },
  naradi: { label: "Nářadí", icon: Hammer },
  auto: { label: "Auto", icon: Car },
};

export default function Stroje() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("stroj");
  const [type, setType] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [vin, setVin] = useState("");
  const [mileageKm, setMileageKm] = useState("");
  const [inspectionDate, setInspectionDate] = useState("");
  const [assignedPersonId, setAssignedPersonId] = useState("none");
  const [showForm, setShowForm] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [snScanOpen, setSnScanOpen] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();
  const [, setLocation] = useLocation();

  const { data: machines, isLoading } = useListMachines({
    query: { queryKey: getListMachinesQueryKey() },
  });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const createMachine = useCreateMachine();

  const resetForm = () => {
    setName("");
    setKind("stroj");
    setType("");
    setManufacturer("");
    setSerialNumber("");
    setPurchaseDate("");
    setLicensePlate("");
    setVin("");
    setMileageKm("");
    setInspectionDate("");
    setAssignedPersonId("none");
    setShowForm(false);
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const isAuto = kind === "auto";
    createMachine.mutate(
      {
        data: {
          name: name.trim(),
          kind,
          type: !isAuto ? type.trim() || null : null,
          manufacturer: !isAuto ? manufacturer.trim() || null : null,
          serialNumber: !isAuto ? serialNumber.trim() || null : null,
          purchaseDate: !isAuto ? purchaseDate || null : null,
          licensePlate: isAuto ? licensePlate.trim() || null : null,
          vin: isAuto ? vin.trim() || null : null,
          mileageKm: isAuto && mileageKm ? parseInt(mileageKm) : null,
          inspectionDate: inspectionDate || null,
          assignedPersonId: assignedPersonId !== "none" ? parseInt(assignedPersonId) : null,
        },
      },
      {
        onSuccess: (created) => {
          resetForm();
          invalidateData(queryClient, "machines");
          toast({ title: "Stroj přidán", description: "Otevřete detail pro QR kód." });
          setLocation(`/stroje/${created.id}`);
        },
        onError: () => {
          toast({ title: "Nepodařilo se přidat stroj", variant: "destructive" });
        },
      },
    );
  };

  const handleScanResult = (text: string) => {
    setScanOpen(false);
    const match = text.match(/ID stroje:\s*(\d+)/i) ?? text.match(/stroje\/(\d+)/);
    if (match) {
      setLocation(`/stroje/${match[1]}`);
    } else {
      toast({ title: "Neplatný QR kód", description: "Tento kód nepatří žádnému stroji.", variant: "destructive" });
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6 gap-2">
        <h1 className="text-2xl font-bold">Stroje</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setScanOpen(true)} className="h-10">
            <QrCode className="h-5 w-5 md:mr-2" />
            <span className="hidden md:inline">Skenovat</span>
          </Button>
          {can("write") && (
            <Button onClick={() => setShowForm((s) => !s)} className="h-10">
              <Plus className="h-5 w-5 md:mr-2" />
              <span className="hidden md:inline">Přidat stroj</span>
            </Button>
          )}
        </div>
      </div>

      {can("write") && showForm && (
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(MACHINE_KINDS).map(([key, cfg]) => {
                  const Icon = cfg.icon;
                  const selected = kind === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setKind(key)}
                      className={`flex flex-col items-center justify-center gap-1 rounded-lg border p-3 transition-colors ${selected ? "border-primary bg-primary/10 text-primary" : "border-input bg-background text-muted-foreground hover:bg-muted"}`}
                    >
                      <Icon className="h-5 w-5" />
                      <span className="text-sm font-medium">{cfg.label}</span>
                    </button>
                  );
                })}
              </div>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "auto" ? "Název vozidla *" : "Název *"}
                className="h-12 bg-background"
                autoFocus
              />
              {kind === "auto" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input value={licensePlate} onChange={(e) => setLicensePlate(e.target.value)} placeholder="SPZ" className="h-12 bg-background" />
                  <Input value={vin} onChange={(e) => setVin(e.target.value)} placeholder="VIN" className="h-12 bg-background" />
                  <Input type="number" value={mileageKm} onChange={(e) => setMileageKm(e.target.value)} placeholder="Stav tachometru (km)" className="h-12 bg-background" />
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground ml-1">STK do</label>
                    <Input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} className="h-12 bg-background" />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="Typ" className="h-12 bg-background" />
                  <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Výrobce" className="h-12 bg-background" />
                  <div className="flex gap-2">
                    <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="Sériové číslo" className="h-12 bg-background flex-1" />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-12 w-12 shrink-0"
                      onClick={() => setSnScanOpen(true)}
                      aria-label="Naskenovat sériové číslo fotoaparátem"
                      title="Naskenovat sériové číslo fotoaparátem"
                    >
                      <ScanLine className="h-5 w-5" />
                    </Button>
                  </div>
                  <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} placeholder="Datum nákupu" className="h-12 bg-background" />
                  <div className="space-y-1 md:col-span-2">
                    <label className="text-xs text-muted-foreground ml-1">Revize do</label>
                    <Input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} className="h-12 bg-background" />
                  </div>
                </div>
              )}
              <Select value={assignedPersonId} onValueChange={setAssignedPersonId}>
                <SelectTrigger className="h-12 bg-background">
                  <SelectValue placeholder="Přiřadit zaměstnanci" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nepřiřazeno</SelectItem>
                  {people?.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="ghost" onClick={resetForm}>Zrušit</Button>
                <Button type="submit" disabled={!name.trim() || createMachine.isPending}>Uložit</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : machines && machines.length > 0 ? (
          machines.map((m) => {
            const kindCfg = MACHINE_KINDS[m.kind] ?? MACHINE_KINDS.stroj;
            const KindIcon = kindCfg.icon;
            const subtitle = m.kind === "auto"
              ? [m.licensePlate, m.mileageKm != null ? `${m.mileageKm.toLocaleString("cs-CZ")} km` : null].filter(Boolean).join(" · ")
              : [m.manufacturer, m.type].filter(Boolean).join(" · ");
            return (
            <Link key={m.id} href={`/stroje/${m.id}`}>
              <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                <CardContent className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="bg-primary/10 p-2 rounded-full text-primary shrink-0">
                      <KindIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-lg truncate">{m.name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {subtitle || kindCfg.label}
                      </p>
                      {m.assignedPersonName && (
                        <p className="text-sm text-primary truncate flex items-center gap-1 mt-0.5">
                          <User className="h-3.5 w-3.5 shrink-0" /> {m.assignedPersonName}
                        </p>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
            );
          })
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Wrench className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Zatím žádné stroje.</p>
          </div>
        )}
      </div>

      <BarcodeScanner open={scanOpen} onOpenChange={setScanOpen} onResult={handleScanResult} />
      <BarcodeScanner
        open={snScanOpen}
        onOpenChange={setSnScanOpen}
        onResult={(text) => {
          setSerialNumber(text);
          toast({ title: "Sériové číslo naskenováno" });
        }}
      />
    </div>
  );
}
