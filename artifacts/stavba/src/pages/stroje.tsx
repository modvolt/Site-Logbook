import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListMachines,
  useCreateMachine,
  getListMachinesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Wrench, Plus, ChevronRight, QrCode } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { QrScannerDialog } from "@/components/qr-scanner-dialog";

export default function Stroje() {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();
  const [, setLocation] = useLocation();

  const { data: machines, isLoading } = useListMachines({
    query: { queryKey: getListMachinesQueryKey() },
  });

  const createMachine = useCreateMachine();

  const resetForm = () => {
    setName("");
    setType("");
    setManufacturer("");
    setSerialNumber("");
    setPurchaseDate("");
    setShowForm(false);
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    createMachine.mutate(
      {
        data: {
          name: name.trim(),
          type: type.trim() || null,
          manufacturer: manufacturer.trim() || null,
          serialNumber: serialNumber.trim() || null,
          purchaseDate: purchaseDate || null,
        },
      },
      {
        onSuccess: (created) => {
          resetForm();
          queryClient.invalidateQueries({ queryKey: getListMachinesQueryKey() });
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
    const match = text.match(/stroje\/(\d+)/);
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
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Název stroje *"
                className="h-12 bg-background"
                autoFocus
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="Typ" className="h-12 bg-background" />
                <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Výrobce" className="h-12 bg-background" />
                <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="Sériové číslo" className="h-12 bg-background" />
                <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} placeholder="Datum nákupu" className="h-12 bg-background" />
              </div>
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
          machines.map((m) => (
            <Link key={m.id} href={`/stroje/${m.id}`}>
              <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                <CardContent className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="bg-primary/10 p-2 rounded-full text-primary shrink-0">
                      <Wrench className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-lg truncate">{m.name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {[m.manufacturer, m.type].filter(Boolean).join(" · ") || "Bez bližšího určení"}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Wrench className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Zatím žádné stroje.</p>
          </div>
        )}
      </div>

      <QrScannerDialog open={scanOpen} onOpenChange={setScanOpen} onResult={handleScanResult} />
    </div>
  );
}
