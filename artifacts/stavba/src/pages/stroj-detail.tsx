import { useEffect, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import QRCode from "qrcode";
import {
  useGetMachine,
  useUpdateMachine,
  useDeleteMachine,
  getGetMachineQueryKey,
  getListMachinesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Wrench, Trash2, Pencil, Download, Save, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

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
  const [form, setForm] = useState({ name: "", type: "", manufacturer: "", serialNumber: "", purchaseDate: "", notes: "" });

  const { data: machine, isLoading } = useGetMachine(id, {
    query: { queryKey: getGetMachineQueryKey(id), enabled: Number.isFinite(id) },
  });

  const updateMachine = useUpdateMachine();
  const deleteMachine = useDeleteMachine();

  const detailLink = `${window.location.origin}${import.meta.env.BASE_URL}stroje/${id}`;

  useEffect(() => {
    QRCode.toDataURL(detailLink, { width: 320, margin: 2 })
      .then(setQrUrl)
      .catch(() => setQrUrl(null));
  }, [detailLink]);

  useEffect(() => {
    if (machine) {
      setForm({
        name: machine.name,
        type: machine.type ?? "",
        manufacturer: machine.manufacturer ?? "",
        serialNumber: machine.serialNumber ?? "",
        purchaseDate: machine.purchaseDate ?? "",
        notes: machine.notes ?? "",
      });
    }
  }, [machine]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    updateMachine.mutate(
      {
        id,
        data: {
          name: form.name.trim(),
          type: form.type.trim() || null,
          manufacturer: form.manufacturer.trim() || null,
          serialNumber: form.serialNumber.trim() || null,
          purchaseDate: form.purchaseDate || null,
          notes: form.notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMachineQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getListMachinesQueryKey() });
          setEditing(false);
          toast({ title: "Stroj upraven" });
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
          queryClient.invalidateQueries({ queryKey: getListMachinesQueryKey() });
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
            <Wrench className="h-6 w-6" />
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
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Název *" className="h-11" />
                <Input value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="Typ" className="h-11" />
                <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} placeholder="Výrobce" className="h-11" />
                <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} placeholder="Sériové číslo" className="h-11" />
                <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} className="h-11" />
                <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Poznámka" className="h-11" />
                <div className="flex gap-2 justify-end">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}><X className="h-4 w-4 mr-1" /> Zrušit</Button>
                  <Button type="submit" disabled={!form.name.trim() || updateMachine.isPending}><Save className="h-4 w-4 mr-1" /> Uložit</Button>
                </div>
              </form>
            ) : (
              <div className="text-sm">
                <DetailRow label="Typ" value={machine.type} />
                <DetailRow label="Výrobce" value={machine.manufacturer} />
                <DetailRow label="Sériové číslo" value={machine.serialNumber} />
                <DetailRow label="Datum nákupu" value={machine.purchaseDate} />
                <DetailRow label="Poznámka" value={machine.notes} />
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
              Vytiskněte a nalepte na stroj. Naskenováním v aplikaci otevřete tento detail.
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
