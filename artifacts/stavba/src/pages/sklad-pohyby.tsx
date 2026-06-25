import { useState } from "react";
import { Link } from "wouter";
import {
  useListWarehouseMovements,
  getListWarehouseMovementsQueryKey,
  useListWarehouseItems,
  getListWarehouseItemsQueryKey,
} from "@workspace/api-client-react";
import type { ListWarehouseMovementsParams } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollText, ArrowLeft } from "lucide-react";
import { MovementRow } from "@/components/warehouse-movements";

const ALL = "all";

export default function SkladPohyby() {
  const [itemId, setItemId] = useState<string>(ALL);
  const [direction, setDirection] = useState<string>(ALL);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const { data: items } = useListWarehouseItems(undefined, {
    query: { queryKey: getListWarehouseItemsQueryKey() },
  });

  const params: ListWarehouseMovementsParams = {
    ...(itemId !== ALL ? { warehouseItemId: Number(itemId) } : {}),
    ...(direction !== ALL ? { direction: direction as "in" | "out" } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: 500,
  };

  const { data: movements, isLoading } = useListWarehouseMovements(params, {
    query: { queryKey: getListWarehouseMovementsQueryKey(params) },
  });

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/sklad">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ScrollText className="h-6 w-6 text-cyan-500" /> Kniha pohybů
        </h1>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <Select value={itemId} onValueChange={setItemId}>
          <SelectTrigger className="h-11 sm:max-w-xs">
            <SelectValue placeholder="Položka" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Všechny položky</SelectItem>
            {items?.map((it) => (
              <SelectItem key={it.id} value={String(it.id)}>
                {it.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger className="h-11 sm:w-44">
            <SelectValue placeholder="Směr" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Příjem i výdej</SelectItem>
            <SelectItem value="in">Jen příjem (+)</SelectItem>
            <SelectItem value="out">Jen výdej (−)</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="Od data"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="h-11 sm:w-40"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="date"
            aria-label="Do data"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="h-11 sm:w-40"
          />
        </div>
        {(from || to) && (
          <Button
            variant="ghost"
            className="h-11"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Zrušit období
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : movements && movements.length > 0 ? (
            <div>
              {movements.map((m) => (
                <MovementRow key={m.id} m={m} showItem />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <ScrollText className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p>Žádné pohyby neodpovídají filtru.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
