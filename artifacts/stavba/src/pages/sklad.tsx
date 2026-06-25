import { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  useListWarehouseItems,
  useCreateWarehouseItem,
  useUpdateWarehouseItem,
  useDeleteWarehouseItem,
  useGetWarehouseSummary,
  getListWarehouseItemsQueryKey,
  getGetWarehouseSummaryQueryKey,
} from "@workspace/api-client-react";
import type { WarehouseItem, ListWarehouseItemsParams } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DecimalInput, decimalError } from "@/components/decimal-input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Package,
  Plus,
  Trash2,
  Pencil,
  Save,
  X,
  FileUp,
  History,
  ScrollText,
  AlertTriangle,
  TrendingUp,
  Clock,
  Euro,
  PackageX,
  FileQuestion,
  Filter,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
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

const fmtKcShort = (v: number | null | undefined) =>
  v != null
    ? v >= 1_000_000
      ? `${(v / 1_000_000).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} M Kč`
      : v >= 1_000
      ? `${(v / 1_000).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} tis Kč`
      : `${v.toLocaleString("cs-CZ")} Kč`
    : "—";

/** True when the item's latest known price is older than 90 days. */
function isPriceStale(item: WarehouseItem): boolean {
  if (!item.latestPriceDate) return false;
  const d = new Date(item.latestPriceDate);
  const ago90 = new Date();
  ago90.setDate(ago90.getDate() - 90);
  return d < ago90;
}

function margin(item: WarehouseItem): string | null {
  if (item.purchasePrice == null || item.salePrice == null) return null;
  if (item.purchasePrice <= 0) return null;
  const m = ((item.salePrice - item.purchasePrice) / item.purchasePrice) * 100;
  return `${m.toFixed(1)} %`;
}

function SummaryCard({
  icon,
  label,
  value,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <Card className={alert ? "border-amber-400/60 bg-amber-50 dark:bg-amber-950/20" : ""}>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-full ${alert ? "bg-amber-100 text-amber-600 dark:bg-amber-900/50" : "bg-primary/10 text-primary"}`}>
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground leading-none mb-1">{label}</p>
          <p className="text-lg font-bold leading-none tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Sklad() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();

  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY);
  const [historyItem, setHistoryItem] = useState<WarehouseItem | null>(null);

  // Filter state
  const [filterCategory, setFilterCategory] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterBelowMin, setFilterBelowMin] = useState(false);
  const [filterNoPrice, setFilterNoPrice] = useState(false);
  const [filterChangedAfter, setFilterChangedAfter] = useState("");

  const activeFilterCount =
    (filterCategory ? 1 : 0) +
    (filterSupplier ? 1 : 0) +
    (filterBelowMin ? 1 : 0) +
    (filterNoPrice ? 1 : 0) +
    (filterChangedAfter ? 1 : 0);

  const listParams: ListWarehouseItemsParams | undefined = useMemo(() => {
    const p: ListWarehouseItemsParams = {};
    if (filterCategory) p.category = filterCategory;
    if (filterSupplier) p.supplierName = filterSupplier;
    if (filterBelowMin) p.belowMin = true;
    if (filterNoPrice) p.noPrice = true;
    if (filterChangedAfter) p.changedAfter = filterChangedAfter;
    return Object.keys(p).length ? p : undefined;
  }, [filterCategory, filterSupplier, filterBelowMin, filterNoPrice, filterChangedAfter]);

  const { data: items, isLoading } = useListWarehouseItems(listParams, {
    query: { queryKey: getListWarehouseItemsQueryKey(listParams) },
  });

  const { data: summary } = useGetWarehouseSummary({
    query: { queryKey: getGetWarehouseSummaryQueryKey() },
  });

  const createItem = useCreateWarehouseItem();
  const updateItem = useUpdateWarehouseItem();
  const deleteItem = useDeleteWarehouseItem();

  const invalidate = () => {
    invalidateData(queryClient, "warehouse");
    queryClient.invalidateQueries({ queryKey: getGetWarehouseSummaryQueryKey() });
  };

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

      {/* Warehouse summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <SummaryCard
            icon={<Euro className="h-4 w-4" />}
            label="Hodnota skladu"
            value={fmtKcShort(summary.stockValue)}
          />
          <SummaryCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Pohyby dnes"
            value={summary.movementsToday}
          />
          <SummaryCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Pod minimem"
            value={summary.itemsBelowMin}
            alert={summary.itemsBelowMin > 0}
          />
          <SummaryCard
            icon={<PackageX className="h-4 w-4" />}
            label="Bez nákupní ceny"
            value={summary.itemsWithoutPrice}
            alert={summary.itemsWithoutPrice > 0}
          />
          <SummaryCard
            icon={<FileQuestion className="h-4 w-4" />}
            label="Čeká na fakturu"
            value={summary.waitingForInvoice}
            alert={summary.waitingForInvoice > 0}
          />
          <SummaryCard
            icon={<Package className="h-4 w-4" />}
            label="Celkem položek"
            value={summary.itemCount}
          />
        </div>
      )}

      {/* Filters */}
      <div className="mb-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((s) => !s)}
          className="h-9 gap-2"
        >
          <Filter className="h-4 w-4" />
          Filtry
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1 text-xs">
              {activeFilterCount}
            </Badge>
          )}
          {showFilters ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>

        {showFilters && (
          <Card className="mt-2 border-muted">
            <CardContent className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs mb-1 block text-muted-foreground">Kategorie</Label>
                  <Input
                    value={filterCategory}
                    onChange={(e) => setFilterCategory(e.target.value)}
                    placeholder="Filtrovat dle kategorie…"
                    className="h-10"
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block text-muted-foreground">Dodavatel</Label>
                  <Input
                    value={filterSupplier}
                    onChange={(e) => setFilterSupplier(e.target.value)}
                    placeholder="Filtrovat dle dodavatele…"
                    className="h-10"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="belowMin"
                    checked={filterBelowMin}
                    onCheckedChange={setFilterBelowMin}
                  />
                  <Label htmlFor="belowMin" className="cursor-pointer">Pod minimálním množstvím</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="noPrice"
                    checked={filterNoPrice}
                    onCheckedChange={setFilterNoPrice}
                  />
                  <Label htmlFor="noPrice" className="cursor-pointer">Bez nákupní ceny</Label>
                </div>
                <div>
                  <Label className="text-xs mb-1 block text-muted-foreground">Pohyb od (poslední změna)</Label>
                  <Input
                    type="date"
                    value={filterChangedAfter}
                    onChange={(e) => setFilterChangedAfter(e.target.value)}
                    className="h-10"
                  />
                </div>
              </div>
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3 h-8 text-xs"
                  onClick={() => {
                    setFilterCategory("");
                    setFilterSupplier("");
                    setFilterBelowMin(false);
                    setFilterNoPrice(false);
                    setFilterChangedAfter("");
                  }}
                >
                  <X className="h-3 w-3 mr-1" /> Zrušit filtry
                </Button>
              )}
            </CardContent>
          </Card>
        )}
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

            const noPrice = item.purchasePrice == null;
            const stalePrice = !noPrice && isPriceStale(item);
            const low = item.minQuantity != null && item.quantity <= item.minQuantity;
            const mar = margin(item);

            // Card border style
            const cardClass = noPrice
              ? "border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/10"
              : stalePrice
              ? "border-yellow-400/50 bg-yellow-50/30 dark:bg-yellow-950/10"
              : "hover:bg-muted/50";

            return (
              <Card key={item.id} className={`transition-colors ${cardClass}`}>
                <CardContent className="p-4 flex justify-between items-start gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`p-2 rounded-full shrink-0 mt-0.5 ${noPrice ? "bg-amber-100 text-amber-600 dark:bg-amber-900/40" : "bg-primary/10 text-primary"}`}>
                      <Package className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-base truncate">{item.name}</p>
                        {noPrice && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 font-medium">
                            <AlertTriangle className="h-3 w-3" /> Bez ceny
                          </span>
                        )}
                        {stalePrice && (
                          <span className="inline-flex items-center gap-1 text-xs text-yellow-700 dark:text-yellow-400 font-medium">
                            <Clock className="h-3 w-3" /> Zastaralá cena
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {item.code || "—"}
                        {item.category ? ` · ${item.category}` : ""}
                        {item.supplierName ? ` · ${item.supplierName}` : ""}
                      </p>
                      {/* Price info row */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                        <span className="text-xs text-muted-foreground">
                          Nákup: <span className={`font-medium ${noPrice ? "text-amber-600" : "text-foreground"}`}>{fmtKc(item.purchasePrice)}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Prodej: <span className="font-medium text-foreground">{fmtKc(item.salePrice)}</span>
                        </span>
                        {mar && (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                            Marže: {mar}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <Badge
                        variant={low ? "destructive" : "secondary"}
                        className="font-semibold tabular-nums gap-1"
                      >
                        {low && <AlertTriangle className="h-3 w-3" />}
                        {fmtQty(item.quantity)}
                        {item.unit ? ` ${item.unit}` : ""}
                      </Badge>
                      {item.latestPriceDate && (
                        <p className="text-xs text-muted-foreground mt-1">
                          cena: {new Date(item.latestPriceDate).toLocaleDateString("cs-CZ")}
                        </p>
                      )}
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
            {activeFilterCount > 0 ? (
              <p>Žádné položky neodpovídají filtru.</p>
            ) : (
              <p>Sklad je prázdný.</p>
            )}
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
