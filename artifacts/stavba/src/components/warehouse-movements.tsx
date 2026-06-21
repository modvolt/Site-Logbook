import { useState } from "react";
import {
  useListWarehouseItemMovements,
  useCreateWarehouseMovement,
  getListWarehouseItemMovementsQueryKey,
  getListWarehouseItemsQueryKey,
  getListWarehouseMovementsQueryKey,
} from "@workspace/api-client-react";
import type { WarehouseMovement } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ArrowDownToLine, ArrowUpFromLine, History } from "lucide-react";
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

/** A single movement row, used both in the per-item history and the book. */
export function MovementRow({
  m,
  showItem = false,
}: {
  m: WarehouseMovement;
  showItem?: boolean;
}) {
  const isIn = m.direction === "in";
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
      <div
        className={`font-semibold shrink-0 tabular-nums ${
          isIn ? "text-emerald-600" : "text-amber-600"
        }`}
      >
        {isIn ? "+" : "−"}
        {fmtQty(m.quantity)}
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

  const { data: movements, isLoading } = useListWarehouseItemMovements(itemId, {
    query: {
      queryKey: getListWarehouseItemMovementsQueryKey(itemId),
      enabled: open,
    },
  });

  const createMovement = useCreateWarehouseMovement();

  const [direction, setDirection] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");

  const qty = Number(quantity.replace(",", "."));
  const qtyValid = Number.isFinite(qty) && qty > 0;

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getListWarehouseItemMovementsQueryKey(itemId),
    });
    queryClient.invalidateQueries({ queryKey: getListWarehouseItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListWarehouseMovementsQueryKey() });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!qtyValid) return;
    createMovement.mutate(
      {
        id: itemId,
        data: { direction, quantity: qty, note: note.trim() || null },
      },
      {
        onSuccess: () => {
          setQuantity("");
          setNote("");
          setDirection("in");
          refresh();
          toast({ title: "Pohyb zaznamenán" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se zaznamenat pohyb", variant: "destructive" }),
      },
    );
  };

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
              <Input
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={`Množství${unit ? ` (${unit})` : ""}`}
                className="h-11"
              />
            </div>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Poznámka (volitelné)"
              className="h-11"
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={!qtyValid || createMovement.isPending}>
                Zaznamenat pohyb
              </Button>
            </div>
          </form>
        )}

        <ScrollArea className="max-h-[50vh] pr-3">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : movements && movements.length > 0 ? (
            <div>
              {movements.map((m) => (
                <MovementRow key={m.id} m={m} />
              ))}
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground text-sm">
              Zatím žádné pohyby.
            </p>
          )}
        </ScrollArea>

        <DialogFooter>
          <Badge variant="secondary" className="mr-auto">
            {movements?.length ?? 0} pohybů
          </Badge>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Zavřít
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
