import { useState } from "react";
import {
  useGetWarehouseMaterialBackfillReport,
  getGetWarehouseMaterialBackfillReportQueryKey,
  useRunWarehouseMaterialBackfill,
} from "@workspace/api-client-react";
import type { WarehouseMaterialBackfillAmbiguousGroup } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  PackageSearch,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: number | string;
  sub?: string;
  highlight?: "ok" | "warn" | "error";
}) {
  const color =
    highlight === "ok"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20"
      : highlight === "warn"
        ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20"
        : highlight === "error"
          ? "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20"
          : "border-border bg-card";
  return (
    <div className={cn("rounded-xl border p-4 flex flex-col gap-1", color)}>
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <p className="text-2xl font-bold font-mono">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function AmbiguousGroup({ group }: { group: WarehouseMaterialBackfillAmbiguousGroup }) {
  const [open, setOpen] = useState(false);
  const total = group.materialCount + group.activityMaterialCount;
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="font-medium text-sm">{group.name}</span>
          <span className="text-xs text-muted-foreground ml-1">
            {total} {total === 1 ? "řádek" : total < 5 ? "řádky" : "řádků"} bez odkazu
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {group.warehouseItems.length} karty skladu
        </span>
      </button>
      {open && (
        <div className="border-t bg-muted/10 px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Materiály zakázek bez odkazu</p>
              <p className="font-mono font-semibold">{group.materialCount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Materiály aktivit bez odkazu</p>
              <p className="font-mono font-semibold">{group.activityMaterialCount}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-2">Konfliktní skladové karty:</p>
            <div className="space-y-1">
              {group.warehouseItems.map((wi) => (
                <div
                  key={wi.id}
                  className="flex items-center gap-2 text-xs bg-background border rounded px-3 py-1.5"
                >
                  <span className="font-mono text-muted-foreground">#{wi.id}</span>
                  <span className="font-medium">{wi.name}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground italic">
            Automatické propojení není možné — opravte duplikátní karty ve skladu nebo propojte
            materiály ručně.
          </p>
        </div>
      )}
    </div>
  );
}

export default function AdminWarehouseBackfill() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [running, setRunning] = useState(false);

  const { data, isLoading, error, refetch } = useGetWarehouseMaterialBackfillReport({
    query: { queryKey: getGetWarehouseMaterialBackfillReportQueryKey() },
  });

  const runBackfill = useRunWarehouseMaterialBackfill();

  const handleRun = async () => {
    setRunning(true);
    try {
      const result = await runBackfill.mutateAsync();
      const total = result.materialsLinked + result.activityMaterialsLinked;
      toast({
        title: total > 0 ? `Propojeno ${total} řádků` : "Vše již bylo propojeno",
        description:
          total > 0
            ? `${result.materialsLinked} materiálů zakázek, ${result.activityMaterialsLinked} materiálů aktivit`
            : "Žádné nové unambiguous shody nenalezeny.",
      });
      queryClient.invalidateQueries({ queryKey: getGetWarehouseMaterialBackfillReportQueryKey() });
    } catch {
      toast({
        title: "Backfill selhal",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <ShieldAlert className="w-7 h-7 text-rose-600" />
          <h1 className="text-2xl font-bold">Sklad – propojení materiálů</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Migrace 0063 přidala cizí klíč ze zakázkových materiálů na skladové karty. Tato stránka
          ukazuje, kolik řádků ještě není propojeno, a umožňuje bezpečně spustit dopojení podle
          shody jmen.
        </p>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20 p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
            <p className="text-sm text-rose-700 dark:text-rose-300">Nepodařilo se načíst report.</p>
            <Button size="sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw className="w-4 h-4 mr-1" /> Zkusit znovu
            </Button>
          </div>
        )}

        {data && (
          <>
            {/* Summary stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <StatCard
                label="Celkem nepropojeno"
                value={data.totalUnlinked}
                sub="materiálů zakázek + aktivit bez odkazu na sklad"
                highlight={data.totalUnlinked === 0 ? "ok" : "warn"}
              />
              <StatCard
                label="Lze automaticky propojit"
                value={data.canLink}
                sub="jednoznačná shoda jména — bezpečné spustit"
                highlight={data.canLink === 0 ? "ok" : "warn"}
              />
              <StatCard
                label="Nelze automaticky propojit"
                value={data.totalAmbiguous}
                sub="více karet se stejným jménem — vyžaduje ruční zásah"
                highlight={data.totalAmbiguous === 0 ? "ok" : "error"}
              />
            </div>

            {/* Action */}
            <div className="rounded-xl border bg-card p-4 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <Link2 className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Spustit bezpečný backfill</p>
                  <p className="text-xs text-muted-foreground">
                    Propojí pouze řádky, kde existuje přesně jedna skladová karta se shodným jménem.
                    Již propojené řádky a víceznačné shody zůstanou nedotčeny.
                  </p>
                </div>
              </div>
              <Button
                onClick={handleRun}
                disabled={running || data.canLink === 0}
                className="shrink-0"
              >
                {running ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <PackageSearch className="w-4 h-4 mr-2" />
                )}
                {data.canLink === 0 ? "Vše propojeno" : `Propojit ${data.canLink} řádků`}
              </Button>
            </div>

            {/* All good */}
            {data.totalUnlinked === 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20 p-4 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                <p className="text-sm text-emerald-700 dark:text-emerald-300">
                  Všechny materiály jsou propojeny se skladovými kartami.
                </p>
              </div>
            )}

            {/* Ambiguous cases */}
            {data.ambiguousGroups.length > 0 && (
              <div>
                <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Víceznačné shody – vyžadují ruční řešení ({data.ambiguousGroups.length})
                </h2>
                <p className="text-xs text-muted-foreground mb-3">
                  Tato jména odpovídají více než jedné skladové kartě. Opravte duplikáty ve skladu
                  nebo propojte materiály ručně v detailu zakázky / aktivity.
                </p>
                <div className="space-y-2">
                  {data.ambiguousGroups.map((g) => (
                    <AmbiguousGroup key={g.name} group={g} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
