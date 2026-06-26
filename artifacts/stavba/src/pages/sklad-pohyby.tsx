import { useState } from "react";
import { Link } from "wouter";
import {
  useListWarehouseMovements,
  getListWarehouseMovementsQueryKey,
  useListWarehouseItems,
  getListWarehouseItemsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useGetWarehouseJobMarginSummary,
  getGetWarehouseJobMarginSummaryQueryKey,
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
import { ScrollText, ArrowLeft, TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import { MovementRow } from "@/components/warehouse-movements";

const ALL = "all";

function MarginIcon({ pct }: { pct: number | null }) {
  if (pct === null) return <Minus className="h-4 w-4 text-muted-foreground" />;
  if (pct >= 0) return <TrendingUp className="h-4 w-4 text-emerald-500" />;
  return <TrendingDown className="h-4 w-4 text-destructive" />;
}

export default function SkladPohyby() {
  const [itemId, setItemId] = useState<string>(ALL);
  const [jobId, setJobId] = useState<string>(ALL);
  const [direction, setDirection] = useState<string>(ALL);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const { data: items } = useListWarehouseItems(undefined, {
    query: { queryKey: getListWarehouseItemsQueryKey() },
  });

  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const selectedJobId = jobId !== ALL ? Number(jobId) : undefined;

  const params: ListWarehouseMovementsParams = {
    ...(itemId !== ALL ? { warehouseItemId: Number(itemId) } : {}),
    ...(selectedJobId != null ? { jobId: selectedJobId } : {}),
    ...(direction !== ALL ? { direction: direction as "in" | "out" } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: 500,
  };

  const { data: movements, isLoading } = useListWarehouseMovements(params, {
    query: { queryKey: getListWarehouseMovementsQueryKey(params) },
  });

  const marginParams = selectedJobId != null ? { jobId: selectedJobId } : undefined;
  const { data: margin } = useGetWarehouseJobMarginSummary(
    marginParams!,
    { query: { enabled: selectedJobId != null, queryKey: getGetWarehouseJobMarginSummaryQueryKey(marginParams) } },
  );

  const hasCostOrSale = margin && (margin.totalQtyOut > 0);

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

      <div className="flex flex-col sm:flex-row flex-wrap gap-3 mb-6">
        <Select value={jobId} onValueChange={setJobId}>
          <SelectTrigger className="h-11 sm:max-w-xs">
            <SelectValue placeholder="Zakázka" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Všechny zakázky</SelectItem>
            {jobs?.map((j) => (
              <SelectItem key={j.id} value={String(j.id)}>
                {j.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      {selectedJobId != null && hasCostOrSale && margin && (
        <div className="mb-4 space-y-2">
          <div className="rounded-xl border bg-card p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Vydáno (ks)</p>
              <p className="font-semibold tabular-nums">{margin.totalQtyOut.toLocaleString("cs-CZ")}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Prodejní hodnota</p>
              <p className="font-semibold tabular-nums text-emerald-600">
                {margin.coveredQtyOut > 0
                  ? `${margin.totalSaleValue.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} Kč`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Nákupní náklady</p>
              <p className="font-semibold tabular-nums text-orange-600">
                {margin.coveredCostQtyOut > 0
                  ? `${margin.totalCostValue.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} Kč`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Marže</p>
              <div className="flex items-center gap-1">
                <MarginIcon pct={margin.marginPercent ?? null} />
                <p
                  className={`font-semibold tabular-nums ${
                    margin.marginPercent == null
                      ? "text-muted-foreground"
                      : margin.marginPercent >= 0
                      ? "text-emerald-600"
                      : "text-destructive"
                  }`}
                >
                  {margin.marginPercent != null
                    ? `${margin.marginPercent.toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} %`
                    : "—"}
                </p>
              </div>
            </div>
          </div>
          {margin.coveredCostQtyOut < margin.totalQtyOut && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {(margin.totalQtyOut - margin.coveredCostQtyOut).toLocaleString("cs-CZ")} vydaných ks bez nákupní ceny — marže je podhodnocena.{" "}
                <Link href="/sklad" className="font-medium underline underline-offset-2">
                  Doplnit nákupní ceny ve skladu
                </Link>
              </span>
            </div>
          )}
        </div>
      )}

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
