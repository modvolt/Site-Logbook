import { useLocation } from "wouter";
import {
  useListUnbilledCustomers,
  getListUnbilledCustomersQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtKc } from "@/lib/billing-format";
import { Building2, ChevronRight, ArrowLeft, CheckCircle2 } from "lucide-react";
import { QueryErrorState } from "@/components/query-error-state";

export default function BillingUnbilled() {
  const [, setLocation] = useLocation();
  const { data, isLoading, isError, refetch } = useListUnbilledCustomers({
    query: { queryKey: getListUnbilledCustomersQueryKey() },
  });

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Fakturace
      </Button>
      <h1 className="text-2xl font-bold mb-1">Nevyfakturované zakázky</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Hotové zakázky seskupené podle zákazníka. Vyberte zákazníka a vytvořte fakturu.
      </p>

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : isError ? (
          <QueryErrorState
            title="Nepodařilo se načíst nevyfakturované zakázky"
            onRetry={() => refetch()}
          />
        ) : data && data.length > 0 ? (
          data.map((c) => (
            <Card key={c.customerId} className="overflow-hidden">
              <button
                type="button"
                className="w-full text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => setLocation(`/billing/unbilled/${c.customerId}`)}
                aria-label={`Otevřít zakázky zákazníka ${c.companyName}`}
              >
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="bg-primary/10 p-2.5 rounded-full text-primary shrink-0">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-base truncate">{c.companyName}</p>
                    <p className="text-sm text-muted-foreground">
                      {unbilledCountLabel(c.jobCount, c.activityCount)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold">{fmtKc(c.orientationalTotal, 0)}</div>
                    <div className="text-xs text-muted-foreground">orientačně bez DPH</div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 ml-1" />
                </CardContent>
              </button>
            </Card>
          ))
        ) : (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Žádné nevyfakturované hotové zakázky.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function jobCountLabel(n: number): string {
  if (n === 1) return "zakázka";
  if (n >= 2 && n <= 4) return "zakázky";
  return "zakázek";
}

function activityCountLabel(n: number): string {
  if (n === 1) return "akce";
  if (n >= 2 && n <= 4) return "akce";
  return "akcí";
}

function unbilledCountLabel(jobCount: number, activityCount: number): string {
  const parts: string[] = [];
  if (jobCount > 0) parts.push(`${jobCount} ${jobCountLabel(jobCount)}`);
  if (activityCount > 0) parts.push(`${activityCount} ${activityCountLabel(activityCount)}`);
  if (parts.length === 0) return "0 zakázek";
  return parts.join(" · ");
}
