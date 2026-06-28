import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListQuotes,
  useDeleteQuote,
  getListQuotesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, ChevronRight, FileText, Building2, CalendarCheck } from "lucide-react";
import { QuoteStatusBadge } from "@/components/quote-status-badge";

const STATUS_OPTIONS = [
  { value: "all", label: "Všechny stavy" },
  { value: "draft", label: "Koncept" },
  { value: "sent", label: "Odeslaná" },
  { value: "accepted", label: "Přijatá" },
  { value: "rejected", label: "Odmítnutá" },
  { value: "expired", label: "Expirovaná" },
];

export default function Quotes() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState("all");

  const params = status === "all" ? undefined : { status: status as "draft" | "sent" | "accepted" | "rejected" | "expired" };
  const { data, isLoading, isError } = useListQuotes(params, {
    query: { queryKey: getListQuotesQueryKey(params) },
  });

  const deleteQuote = useDeleteQuote();

  if (isLoading) {
    return (
      <div className="p-4 space-y-3 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">Načtení nabídek selhalo.</p>
        <Button className="mt-4" onClick={() => setLocation("/")}>Zpět</Button>
      </div>
    );
  }

  const quotes = data ?? [];

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-bold">Nabídky</h1>
          <Badge variant="secondary">{quotes.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setLocation("/quotes/new")} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Nová nabídka
          </Button>
        </div>
      </div>

      {quotes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>Žádné nabídky.</p>
            <Button className="mt-4" onClick={() => setLocation("/quotes/new")}>
              <Plus className="h-4 w-4 mr-1" /> Vytvořit nabídku
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {quotes.map((q) => (
            <Card
              key={q.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setLocation(`/quotes/${q.id}`)}
            >
              <CardContent className="py-3 px-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{q.title}</span>
                      {q.quoteNumber && (
                        <span className="text-xs text-muted-foreground font-mono">{q.quoteNumber}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                      {q.customerCompanyName && (
                        <span className="flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {q.customerCompanyName}
                        </span>
                      )}
                      {q.validUntil && (
                        <span className="flex items-center gap-1">
                          <CalendarCheck className="h-3 w-3" />
                          Platná do {fmtDate(q.validUntil)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="font-semibold">{fmtKc(q.totalWithVat)}</div>
                      <div className="text-xs text-muted-foreground">{q.itemCount} pol.</div>
                    </div>
                    <QuoteStatusBadge status={q.status} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
