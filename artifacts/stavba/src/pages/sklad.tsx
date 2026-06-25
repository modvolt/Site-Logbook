import { useState } from "react";
import { Link } from "wouter";
import {
  useListWarehouseItems,
  useCreateWarehouseItem,
  useUpdateWarehouseItem,
  useDeleteWarehouseItem,
  getListWarehouseItemsQueryKey,
} from "@workspace/api-client-react";
import type { WarehouseItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DecimalInput, decimalError } from "@/components/decimal-input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Package, Plus, Trash2, Pencil, Save, X, FileUp, History, ScrollText, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import WarehouseCsvImport from "@/components/warehouse-csv-import";
import { ItemMovementHistoryDialog, fmtQty } from "@/components/warehouse-movements";

type FormState = {
  name: string;
  code: string;
  unit: string;
  salePrice: string;
  minQuantity: string;
};

const EMPTY: FormState = { name: "", code: "", unit: "", salePrice: "", minQuantity: "" };

const getFormErrors = (f: FormState) => ({
  salePrice: decimalError(f.salePrice),
  minQuantity: decimalError(f.minQuantity),
});
const formHasErrors = (f: FormState) => Object.values(getFormErrors(f)).some(Boolean);

const num = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const fmtKc = (v: number | null | undefined) =>
  v != null ? `${v.toLocaleString("cs-CZ")} Kč` : "—";

export default function Sklad() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY);
  const [historyItem, setHistoryItem] = useState<WarehouseItem | null>(null);

  const { data: items, isLoading } = useListWarehouseItems({
    query: { queryKey: getListWarehouseItemsQueryKey() },
  });

  const createItem = useCreateWarehouseItem();
  const updateItem = useUpdateWarehouseItem();
  const deleteItem = useDeleteWarehouseItem();

  const invalidate = () => invalidateData(queryClient, "warehouse");

  const toPayload = (f: FormState) => ({
    name: f.name.trim(),
    code: f.code.trim() || null,
    unit: f.unit.trim() || null,
    salePrice: num(f.salePrice),
    minQuantity: num(f.minQuantity),
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    createItem.mutate(
      { data: toPayload(form) },
      {
        onSuccess: () => {
          setForm(EMPTY);
          setShowForm(false);
          invalidate();
          toast({ title: "Položka přidána" });
        },
        onError: () => toast({ title: "Nepodařilo se přidat položku", variant: "destructive" }),
      },
    );
  };

  const startEdit = (item: WarehouseItem) => {
    setEditId(item.id);
    setEditForm({
      name: item.name,
      code: item.code ?? "",
      unit: item.unit ?? "",
      salePrice: item.salePrice != null ? String(item.salePrice) : "",
      minQuantity: item.minQuantity != null ? String(item.minQuantity) : "",
    });
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (editId == null || !editForm.name.trim()) return;
    updateItem.mutate(
      { id: editId, data: toPayload(editForm) },
      {
        onSuccess: () => {
          setEditId(null);
          invalidate();
          toast({ title: "Položka upravena" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("Opravdu chcete smazat tuto položku?")) return;
    deleteItem.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Položka smazána" });
        },
        onError: (err: any) => {
          const msg = err?.data?.error ?? err?.message ?? "Nepodařilo se smazat položku.";
          toast({ title: "Nelze smazat", description: msg, variant: "destructive" });
        },
      },
    );
  };

  const formFields = (f: FormState, set: (f: FormState) => void) => {
    const errs = getFormErrors(f);
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input value={f.name} onChange={(e) => set({ ...f, name: e.target.value })} placeholder="Název *" className="h-12 bg-background md:col-span-2" />
        <Input value={f.code} onChange={(e) => set({ ...f, code: e.target.value })} placeholder="Kód / katalogové číslo" className="h-12 bg-background" />
        <Input value={f.unit} onChange={(e) => set({ ...f, unit: e.target.value })} placeholder="Jednotka (ks, m, kg…)" className="h-12 bg-background" />
        <div>
          <DecimalInput value={f.salePrice} onChange={(v) => set({ ...f, salePrice: v })} placeholder="Prodejní cena (Kč)" className="h-12 bg-background" error={errs.salePrice} />
        </div>
        <div>
          <DecimalInput value={f.minQuantity} onChange={(v) => set({ ...f, minQuantity: v })} placeholder="Min. množství (alert)" className="h-12 bg-background" error={errs.minQuantity} />
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6 gap-2">
        <h1 className="text-2xl font-bold">Sklad</h1>
        <div className="flex gap-2">
          <Link href="/sklad/pohyby">
            <Button variant="outline" className="h-10">
              <ScrollText className="h-5 w-5 md:mr-2" />
              <span className="hidden md:inline">Kniha pohybů</span>
            </Button>
          </Link>
          {can("write") && (
            <>
              <Button variant="outline" onClick={() => setShowImport(true)} className="h-10">
                <FileUp className="h-5 w-5 md:mr-2" />
                <span className="hidden md:inline">Import ceníku</span>
              </Button>
              <Button onClick={() => setShowForm((s) => !s)} className="h-10">
                <Plus className="h-5 w-5 md:mr-2" />
                <span className="hidden md:inline">Přidat položku</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {can("write") && (
        <WarehouseCsvImport
          open={showImport}
          onOpenChange={setShowImport}
          onImported={invalidate}
        />
      )}

      {can("write") && showForm && (
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <form onSubmit={handleAdd} className="space-y-3">
              {formFields(form, setForm)}
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="ghost" onClick={() => { setForm(EMPTY); setShowForm(false); }}>Zrušit</Button>
                <Button type="submit" disabled={!form.name.trim() || createItem.isPending || formHasErrors(form)}>Uložit</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : items && items.length > 0 ? (
          items.map((item) => {
            if (editId === item.id) {
              return (
                <Card key={item.id} className="border-primary/30">
                  <CardContent className="p-4">
                    <form onSubmit={handleUpdate} className="space-y-3">
                      {formFields(editForm, setEditForm)}
                      <div className="flex gap-2 justify-end">
                        <Button type="button" variant="ghost" onClick={() => setEditId(null)}><X className="h-4 w-4 mr-1" /> Zrušit</Button>
                        <Button type="submit" disabled={!editForm.name.trim() || updateItem.isPending || formHasErrors(editForm)}><Save className="h-4 w-4 mr-1" /> Uložit</Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              );
            }
            return (
              <Card key={item.id} className="hover:bg-muted/50 transition-colors">
                <CardContent className="p-4 flex justify-between items-center gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-full shrink-0 bg-primary/10 text-primary">
                      <Package className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-lg truncate">{item.name}</p>
                      <p className="text-sm text-muted-foreground truncate">{item.code || "—"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      {(() => {
                        const low = item.minQuantity != null && item.quantity <= item.minQuantity;
                        return (
                          <Badge
                            variant={low ? "destructive" : "secondary"}
                            className="font-semibold tabular-nums gap-1"
                          >
                            {low && <AlertTriangle className="h-3 w-3" />}
                            {fmtQty(item.quantity)}
                            {item.unit ? ` ${item.unit}` : ""}
                          </Badge>
                        );
                      })()}
                      <p className="text-sm text-muted-foreground mt-1">{fmtKc(item.salePrice)}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" title="Pohyby" onClick={() => setHistoryItem(item)}>
                        <History className="h-4 w-4" />
                      </Button>
                      {can("write") && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => startEdit(item)}><Pencil className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => handleDelete(item.id)} disabled={deleteItem.isPending}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Package className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Sklad je prázdný.</p>
          </div>
        )}
      </div>

      {historyItem && (
        <ItemMovementHistoryDialog
          itemId={historyItem.id}
          itemName={historyItem.name}
          unit={historyItem.unit}
          canCorrect={can("write")}
          open={historyItem !== null}
          onOpenChange={(o) => !o && setHistoryItem(null)}
        />
      )}
    </div>
  );
}
