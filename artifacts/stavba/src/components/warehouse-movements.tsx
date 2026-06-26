import { useState, useEffect, useRef, useCallback } from "react";
import {
  useListWarehouseItemMovements,
  useCreateWarehouseMovement,
  useCancelLastWarehouseMovement,
  useUpdateWarehouseMovement,
  useListWarehouseItemPriceHistory,
  getListWarehouseItemMovementsQueryKey,
  getListWarehouseItemsQueryKey,
  getListWarehouseMovementsQueryKey,
  getListWarehouseItemPriceHistoryQueryKey,
  getGetWarehouseSummaryQueryKey,
} from "@workspace/api-client-react";
import type { WarehouseMovement, WarehousePriceHistory } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DecimalInput, decimalError } from "@/components/decimal-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDownToLine, ArrowUpFromLine, History, RotateCcw, TrendingDown, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SOURCE_LABELS: Record<string, string> = {
  manual: "Ruční korekce",
  billing_document_line: "Doklad (příjem)",
  material: "Materiál zakázky",
  activity_material: "Materiál akce",
};

export function sourceLabel(t: string): string {
  return SOURCE_LABELS[t] ?? t;
}

export function fmtQty(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("cs-CZ", { maximumFractionDigits: 2 });
}

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("cs-CZ", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "—";

const fmtKc = (v: number | null | undefined) =>
  v != null ? `${v.toLocaleString("cs-CZ")} Kč` : "—";

/** Generate a client-side UUID for idempotency. */
function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A single movement row, used both in the per-item history and the book. */
export function MovementRow({
  m,
  showItem = false,
  canEditCostPrice = false,
  onEdited,
}: {
  m: WarehouseMovement;
  showItem?: boolean;
  canEditCostPrice?: boolean;
  onEdited?: () => void;
}) {
  const isIn = m.direction === "in";
  const { toast } = useToast();
  const updateMovement = useUpdateWarehouseMovement();

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setEditValue(m.costPriceAtTime != null ? String(m.costPriceAtTime) : "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (saving || updateMovement.isPending) return;
    const raw = editValue.trim().replace(",", ".");
    const parsed = raw === "" ? null : Number(raw);
    if (raw !== "" && (Number.isNaN(parsed) || (parsed as number) < 0)) {
      toast({ title: "Neplatná hodnota", description: "Zadejte kladné číslo nebo nechte prázdné pro vymazání.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await new Promise<void>((resolve, reject) => {
        updateMovement.mutate(
          { id: m.id, data: { costPriceAtTime: parsed } },
          {
            onSuccess: () => {
              setEditing(false);
              setEditValue("");
              toast({ title: "Nákupní cena uložena" });
              onEdited?.();
              resolve();
            },
            onError: (err: any) => {
              const msg = err?.data?.error ?? err?.message ?? "Nepodařilo se uložit cenu.";
              toast({ title: "Chyba ukládání", description: msg, variant: "destructive" });
              reject(err);
            },
          },
        );
      });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void saveEdit(); }
    if (e.key === "Escape") cancelEdit();
  };

  const showEditButton = canEditCostPrice && !isIn;

  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b last:border-0">
      <div className="flex items-start gap-2.5 min-w-0">
        <div
          className={`p-1.5 rounded-full shrink-0 mt-0.5 ${
            isIn
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40"
              : "bg-amber-100 text-amber-600 dark:bg-amber-950/40"
          }`}
        >
          {isIn ? (
            <ArrowDownToLine className="h-4 w-4" />
          ) : (
            <ArrowUpFromLine className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0">
          {showItem && (
            <p className="font-medium truncate">{m.warehouseItemName ?? "—"}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {sourceLabel(m.sourceType)}
            {m.documentNumber ? ` · ${m.documentNumber}` : ""}
            {m.jobTitle ? ` · ${m.jobTitle}` : ""}
          </p>
          {m.note && <p className="text-sm truncate">{m.note}</p>}
          <p className="text-xs text-muted-foreground">
            {fmtDateTime(m.createdAt)}
            {m.createdByName ? ` · ${m.createdByName}` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <div
          className={`font-semibold tabular-nums ${
            isIn ? "text-emerald-600" : "text-amber-600"
          }`}
        >
          {isIn ? "+" : "−"}
          {fmtQty(m.quantity)}
        </div>
        {!isIn && (
          <div className="flex items-center gap-1">
            {editing ? (
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Nák. cena"
                  className="h-6 w-24 text-xs px-1.5 tabular-nums"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={saving}
                  onClick={() => void saveEdit()}
                  title="Uložit"
                >
                  <Check className="h-3 w-3 text-emerald-600" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={cancelEdit}
                  title="Zrušit"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            ) : (
              <>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Nák.&nbsp;{fmtKc(m.costPriceAtTime)}
                </span>
                {showEditButton && (
                  <button
                    type="button"
                    onClick={startEdit}
                    className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    title="Opravit nákupní cenu"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Price history row. */
function PriceHistoryRow({ ph }: { ph: WarehousePriceHistory }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {ph.supplierName ?? "Neznámý dodavatel"}
        </p>
        <p className="text-xs text-muted-foreground">
          {ph.documentNumber ? `Doklad ${ph.documentNumber}` : ""}
          {ph.documentNumber && ph.documentDate ? " · " : ""}
          {ph.documentDate ? fmtDate(ph.documentDate) : ""}
        </p>
        {ph.note && <p className="text-xs text-muted-foreground truncate">{ph.note}</p>}
        <p className="text-xs text-muted-foreground">{fmtDate(ph.createdAt)}</p>
      </div>
      <div className="font-semibold shrink-0 tabular-nums text-primary">
        {fmtKc(ph.purchasePrice)}
      </div>
    </div>
  );
}

/** Per-item movement history + manual correction form. */
export function ItemMovementHistoryDialog({
  itemId,
  itemName,
  unit,
  canCorrect,
  open,
  onOpenChange,
}: {
  itemId: number;
  itemName: string;
  unit?: string | null;
  canCorrect: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: movements, isLoading: movLoading } = useListWarehouseItemMovements(itemId, {
    query: {
      queryKey: getListWarehouseItemMovementsQueryKey(itemId),
      enabled: open,
    },
  });

  const { data: priceHistory, isLoading: priceLoading } = useListWarehouseItemPriceHistory(
    itemId,
    {
      query: {
        queryKey: getListWarehouseItemPriceHistoryQueryKey(itemId),
        enabled: open,
      },
    },
  );

  const createMovement = useCreateWarehouseMovement();
  const cancelLast = useCancelLastWarehouseMovement();

  const [direction, setDirection] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  // Idempotency key: generated once per form-fill; reset after successful submit.
  const [idemKey, setIdemKey] = useState<string>(() => newIdempotencyKey());

  const qty = Number(quantity.replace(",", "."));
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const quantityErr = decimalError(quantity, { positiveOnly: true });

  const refresh = useCallback(() => {
    invalidateData(queryClient, "warehouse");
    queryClient.invalidateQueries({ queryKey: getGetWarehouseSummaryQueryKey() });
  }, [queryClient]);

  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ direction: "in" | "out"; qty: number } | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qtyValid || submitting || createMovement.isPending) return;
    setSubmitting(true);
    try {
      await new Promise<void>((resolve, reject) => {
        createMovement.mutate(
          {
            id: itemId,
            data: {
              direction,
              quantity: qty,
              note: note.trim() || null,
              idempotencyKey: idemKey,
            },
          },
          {
            onSuccess: () => {
              const saved = { direction, qty };
              setQuantity("");
              setNote("");
              setDirection("in");
              // Reset idempotency key for the next movement
              setIdemKey(newIdempotencyKey());
              refresh();
              toast({ title: "Pohyb zaznamenán" });
              setLastSaved(saved);
              if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
              savedTimerRef.current = setTimeout(() => setLastSaved(null), 4000);
              resolve();
            },
            onError: (err: any) => {
              // 409 = idempotent duplicate — treat as success to avoid confusing the user
              if (err?.status === 409) {
                toast({ title: "Pohyb byl již zaznamenán" });
                setIdemKey(newIdempotencyKey());
                resolve();
              } else {
                toast({ title: "Nepodařilo se zaznamenat pohyb", variant: "destructive" });
                reject(err);
              }
            },
          },
        );
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelLast = async () => {
    if (cancelling || cancelLast.isPending) return;
    if (!confirm("Stornovat poslední ruční pohyb? Tato akce přidá opačný pohyb do knihy.")) return;
    setCancelling(true);
    try {
      await new Promise<void>((resolve, reject) => {
        cancelLast.mutate(
          { id: itemId },
          {
            onSuccess: () => {
              refresh();
              toast({ title: "Pohyb stornován" });
              resolve();
            },
            onError: (err: any) => {
              const msg = err?.data?.error ?? err?.message ?? "Nepodařilo se stornovat pohyb.";
              toast({ title: "Storno selhalo", description: msg, variant: "destructive" });
              reject(err);
            },
          },
        );
      });
    } finally {
      setCancelling(false);
    }
  };

  // Has at least one manual movement that can be reversed
  const hasManualMovements = movements?.some((m) => m.sourceType === "manual");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" /> Pohyby — {itemName}
          </DialogTitle>
        </DialogHeader>

        {canCorrect && (
          <form onSubmit={submit} className="space-y-3 border-b pb-4">
            <Label className="text-sm font-medium">Ruční korekce skladu</Label>
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={direction}
                onValueChange={(v) => setDirection(v as "in" | "out")}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">Příjem (+)</SelectItem>
                  <SelectItem value="out">Výdej (−)</SelectItem>
                </SelectContent>
              </Select>
              <div>
                <DecimalInput
                  value={quantity}
                  onChange={(v) => setQuantity(v)}
                  placeholder={`Množství${unit ? ` (${unit})` : ""}`}
                  className="h-11"
                  error={quantityErr}
                />
              </div>
            </div>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Poznámka (volitelné)"
              className="h-11"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {lastSaved ? (
                  <span className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    ✓ {lastSaved.direction === "in" ? "+" : "−"}{lastSaved.qty} {unit ?? ""} uloženo
                  </span>
                ) : (
                  <span />
                )}
              </div>
              <div className="flex gap-2">
                {hasManualMovements && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs gap-1"
                    disabled={cancelling || cancelLast.isPending}
                    onClick={handleCancelLast}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {cancelling || cancelLast.isPending ? "Stornuji…" : "Storno posl."}
                  </Button>
                )}
                <Button type="submit" disabled={!qtyValid || submitting || createMovement.isPending}>
                  {submitting || createMovement.isPending ? "Ukládám pohyb…" : "Zaznamenat pohyb"}
                </Button>
              </div>
            </div>
          </form>
        )}

        <Tabs defaultValue="movements">
          <TabsList className="w-full">
            <TabsTrigger value="movements" className="flex-1">
              Pohyby <Badge variant="secondary" className="ml-1 h-5 px-1 text-xs">{movements?.length ?? 0}</Badge>
            </TabsTrigger>
            <TabsTrigger value="prices" className="flex-1">
              <TrendingDown className="h-3 w-3 mr-1" />
              Historie cen
              {priceHistory && priceHistory.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1 text-xs">{priceHistory.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="movements" className="mt-0">
            <ScrollArea className="max-h-[40vh] pr-3">
              {movLoading ? (
                <div className="space-y-2 pt-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : movements && movements.length > 0 ? (
                <div>
                  {movements.map((m) => (
                    <MovementRow key={m.id} m={m} canEditCostPrice={canCorrect} onEdited={refresh} />
                  ))}
                </div>
              ) : (
                <p className="text-center py-8 text-muted-foreground text-sm">
                  Zatím žádné pohyby.
                </p>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="prices" className="mt-0">
            <ScrollArea className="max-h-[40vh] pr-3">
              {priceLoading ? (
                <div className="space-y-2 pt-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : priceHistory && priceHistory.length > 0 ? (
                <div>
                  {priceHistory.map((ph) => (
                    <PriceHistoryRow key={ph.id} ph={ph} />
                  ))}
                </div>
              ) : (
                <p className="text-center py-8 text-muted-foreground text-sm">
                  Žádná cenová historie.
                </p>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Zavřít
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
