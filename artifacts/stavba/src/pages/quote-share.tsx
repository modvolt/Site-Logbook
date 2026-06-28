import { useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtKc, fmtDate } from "@/lib/billing-format";

interface PublicQuoteItem {
  id: number;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  vatRate: number | null;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

interface PublicQuoteDetail {
  quoteNumber: string | null;
  title: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  validUntil: string | null;
  notes: string | null;
  customerCompanyName: string | null;
  supplierName: string | null;
  supplierAddress: string | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  items: PublicQuoteItem[];
  subtotalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  vatPayer: boolean;
  createdAt: string;
}

type PageState = "loading" | "error" | "loaded" | "confirming" | "accepted" | "rejected" | "already_done";

function StatusBanner({ status }: { status: PublicQuoteDetail["status"] }) {
  if (status === "accepted") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-green-800 dark:bg-green-950/30 dark:border-green-800 dark:text-green-300">
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <span className="font-medium">Tato nabídka byla přijata.</span>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-red-800 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300">
        <XCircle className="h-5 w-5 shrink-0" />
        <span className="font-medium">Tato nabídka byla odmítnuta.</span>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300">
        <AlertCircle className="h-5 w-5 shrink-0" />
        <span className="font-medium">Platnost této nabídky vypršela.</span>
      </div>
    );
  }
  return null;
}

export default function QuoteShare() {
  const [location] = useLocation();
  const token = location.replace(/^\/quote-share\//, "").split("?")[0];

  const [pageState, setPageState] = useState<PageState>("loading");
  const [quote, setQuote] = useState<PublicQuoteDetail | null>(null);
  const [error, setError] = useState<string>("");
  const [actionPending, setActionPending] = useState(false);
  const [fetchDone, setFetchDone] = useState(false);

  if (!fetchDone) {
    setFetchDone(true);
    fetch(`/api/quotes/public/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error ?? "Nabídka nebyla nalezena.");
          setPageState("error");
          return;
        }
        const data: PublicQuoteDetail = await r.json();
        setQuote(data);
        if (["accepted", "rejected", "expired"].includes(data.status)) {
          setPageState("already_done");
        } else {
          setPageState("loaded");
        }
      })
      .catch(() => {
        setError("Nepodařilo se načíst nabídku. Zkuste to prosím znovu.");
        setPageState("error");
      });
  }

  async function handleAccept() {
    setActionPending(true);
    try {
      const r = await fetch(`/api/quotes/public/${encodeURIComponent(token)}/accept`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? "Přijetí nabídky selhalo.");
        setPageState("error");
        return;
      }
      setPageState("accepted");
    } catch {
      setError("Přijetí nabídky selhalo. Zkuste to prosím znovu.");
      setPageState("error");
    } finally {
      setActionPending(false);
    }
  }

  async function handleReject() {
    setActionPending(true);
    try {
      const r = await fetch(`/api/quotes/public/${encodeURIComponent(token)}/reject`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? "Odmítnutí nabídky selhalo.");
        setPageState("error");
        return;
      }
      setPageState("rejected");
    } catch {
      setError("Odmítnutí nabídky selhalo. Zkuste to prosím znovu.");
      setPageState("error");
    } finally {
      setActionPending(false);
    }
  }

  if (pageState === "loading") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (pageState === "error") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4">
        <div className="max-w-sm text-center space-y-3">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
          <h1 className="text-xl font-semibold">Nabídka nenalezena</h1>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (pageState === "accepted") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4">
        <div className="max-w-sm text-center space-y-3">
          <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
          <h1 className="text-2xl font-bold">Nabídka přijata</h1>
          <p className="text-muted-foreground">
            Děkujeme za potvrzení. Budeme vás kontaktovat ohledně dalšího postupu.
          </p>
        </div>
      </div>
    );
  }

  if (pageState === "rejected") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4">
        <div className="max-w-sm text-center space-y-3">
          <XCircle className="h-16 w-16 text-muted-foreground mx-auto" />
          <h1 className="text-2xl font-bold">Nabídka odmítnuta</h1>
          <p className="text-muted-foreground">
            Vaše odpověď byla zaznamenána. V případě dotazů nás neváhejte kontaktovat.
          </p>
        </div>
      </div>
    );
  }

  if (!quote) return null;

  const canRespond = pageState === "loaded";

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="max-w-3xl mx-auto p-4 space-y-4 py-8">
        {/* Header */}
        <div className="space-y-1">
          {quote.supplierName && (
            <p className="text-sm text-muted-foreground font-medium">{quote.supplierName}</p>
          )}
          <h1 className="text-2xl font-bold">{quote.title}</h1>
          {quote.quoteNumber && (
            <p className="text-sm text-muted-foreground font-mono">{quote.quoteNumber}</p>
          )}
        </div>

        <StatusBanner status={quote.status} />

        {/* Meta info */}
        <Card>
          <CardContent className="py-4 px-4 space-y-2 text-sm">
            {quote.customerCompanyName && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Zákazník:</span>
                <span className="font-medium">{quote.customerCompanyName}</span>
              </div>
            )}
            {quote.validUntil && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Platná do:</span>
                <span className="font-medium">{fmtDate(quote.validUntil)}</span>
              </div>
            )}
            {quote.supplierEmail && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Kontakt:</span>
                <span>{quote.supplierEmail}</span>
              </div>
            )}
            {quote.supplierPhone && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Telefon:</span>
                <span>{quote.supplierPhone}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notes */}
        {quote.notes && (
          <Card>
            <CardContent className="py-4 px-4">
              <p className="text-sm whitespace-pre-line">{quote.notes}</p>
            </CardContent>
          </Card>
        )}

        {/* Items table */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Položky nabídky</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Popis</TableHead>
                  <TableHead className="text-right w-16">Množ.</TableHead>
                  <TableHead className="w-12">MJ</TableHead>
                  <TableHead className="text-right w-28">Cena/MJ</TableHead>
                  {quote.vatPayer && <TableHead className="text-right w-16">DPH</TableHead>}
                  <TableHead className="text-right w-28">Celkem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quote.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.description}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell>{item.unit ?? ""}</TableCell>
                    <TableCell className="text-right">{fmtKc(item.unitPrice)}</TableCell>
                    {quote.vatPayer && (
                      <TableCell className="text-right text-muted-foreground">
                        {item.vatRate != null ? `${item.vatRate}%` : "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right font-medium">{fmtKc(item.totalWithVat)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Totals */}
            <div className="px-4 py-3 border-t space-y-1 text-sm text-right">
              {quote.vatPayer && (
                <>
                  <div className="text-muted-foreground">
                    Celkem bez DPH: <span className="font-medium text-foreground">{fmtKc(quote.subtotalWithoutVat)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    DPH: <span className="font-medium text-foreground">{fmtKc(quote.totalVat)}</span>
                  </div>
                </>
              )}
              <div className="text-lg font-bold">
                Celkem: {fmtKc(quote.totalWithVat)} Kč
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action buttons */}
        {canRespond && (
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="py-5 px-4">
              <p className="text-sm text-center text-muted-foreground mb-4">
                Přejete si tuto nabídku přijmout nebo odmítnout?
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <Button
                  size="lg"
                  className="bg-green-600 hover:bg-green-700 text-white min-w-[140px]"
                  onClick={handleAccept}
                  disabled={actionPending}
                >
                  {actionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                  Přijímám nabídku
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="min-w-[140px]"
                  onClick={handleReject}
                  disabled={actionPending}
                >
                  {actionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <XCircle className="h-4 w-4 mr-2" />}
                  Odmítám nabídku
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Already resolved notice */}
        {pageState === "already_done" && !["accepted", "rejected", "expired"].includes(quote.status) && (
          <StatusBanner status={quote.status} />
        )}

        {/* Footer */}
        <p className="text-xs text-center text-muted-foreground pt-2">
          {quote.supplierName && `${quote.supplierName} · `}
          {quote.supplierAddress}
        </p>
      </div>
    </div>
  );
}
