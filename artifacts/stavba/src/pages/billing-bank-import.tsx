import { useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useParseBankStatement,
  useConfirmBankPayments,
  getListInvoicesQueryKey,
  getGetBillingSummaryQueryKey,
  type BankStatementPreview,
  type BankMatchTransaction,
  type BankPaymentConfirmItem,
  type BankPaymentsConfirmResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  ArrowLeft,
  Banknote,
  Upload,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Ban,
  Loader2,
} from "lucide-react";

type MatchStatus = BankMatchTransaction["matchStatus"];

const STATUS_META: Record<
  MatchStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  matched: {
    label: "Spárováno",
    className:
      "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    icon: CheckCircle2,
  },
  amount_mismatch: {
    label: "Nesouhlasí částka",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    icon: AlertTriangle,
  },
  ambiguous: {
    label: "Více faktur",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    icon: HelpCircle,
  },
  already_paid: {
    label: "Již zaplaceno",
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    icon: CheckCircle2,
  },
  unmatched: {
    label: "Nenalezeno",
    className: "bg-muted text-muted-foreground",
    icon: Ban,
  },
};

/** Per-transaction UI selection: whether to mark paid, and to which invoice. */
interface RowChoice {
  selected: boolean;
  invoiceId: number | null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Soubor se nepodařilo načíst."));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** A transaction is actionable when there is at least one payable candidate. */
function isActionable(t: BankMatchTransaction): boolean {
  return t.matchStatus !== "already_paid" && t.candidates.length > 0;
}

export default function BillingBankImport() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<BankStatementPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, RowChoice>>({});
  const [result, setResult] = useState<BankPaymentsConfirmResult | null>(null);

  const parseMut = useParseBankStatement();
  const confirmMut = useConfirmBankPayments();

  function resetAll() {
    setFileName(null);
    setPreview(null);
    setChoices({});
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setResult(null);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const data = await parseMut.mutateAsync({
        data: { filename: file.name, contentBase64 },
      });
      setPreview(data);
      // Default selections: matched rows pre-checked at the recommended invoice.
      const init: Record<number, RowChoice> = {};
      data.transactions.forEach((t, i) => {
        if (!isActionable(t)) return;
        const invoiceId = t.recommendedInvoiceId ?? t.candidates[0].invoiceId;
        init[i] = { selected: t.matchStatus === "matched", invoiceId };
      });
      setChoices(init);
    } catch (err) {
      toast({
        title: "Výpis se nepodařilo zpracovat",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }

  function toggleRow(i: number, selected: boolean) {
    setChoices((prev) => ({
      ...prev,
      [i]: { ...prev[i], selected },
    }));
  }

  function setRowInvoice(i: number, invoiceId: number) {
    setChoices((prev) => ({
      ...prev,
      [i]: { selected: prev[i]?.selected ?? true, invoiceId },
    }));
  }

  const selectedCount = preview
    ? preview.transactions.filter((_, i) => choices[i]?.selected && choices[i]?.invoiceId)
        .length
    : 0;

  async function onConfirm() {
    if (!preview) return;
    const payments: BankPaymentConfirmItem[] = [];
    preview.transactions.forEach((t, i) => {
      const c = choices[i];
      if (c?.selected && c.invoiceId) {
        payments.push({
          invoiceId: c.invoiceId,
          amount: t.amount,
          variableSymbol: t.variableSymbol,
          counterparty: t.counterparty,
          paymentDate: t.date,
        });
      }
    });
    if (payments.length === 0) return;
    try {
      const res = await confirmMut.mutateAsync({ data: { payments } });
      setResult(res);
      invalidateData(queryClient, "bankImport");
      toast({
        title: `Označeno jako zaplaceno: ${res.paidCount}`,
        description:
          res.skipped.length > 0
            ? `Přeskočeno: ${res.skipped.length}`
            : undefined,
      });
    } catch (err) {
      toast({
        title: "Potvrzení se nezdařilo",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <button
        onClick={() => setLocation("/billing")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Fakturace
      </button>

      <div className="flex items-center gap-3 mb-6">
        <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2.5 rounded-full text-emerald-600 dark:text-emerald-300">
          <Banknote className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Párování plateb z banky</h1>
          <p className="text-sm text-muted-foreground">
            Nahrajte výpis z Komerční banky (GPC/ABO nebo CAMT.053 XML)
          </p>
        </div>
      </div>

      {/* Upload */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpc,.abo,.xml,.txt,text/xml,text/plain,application/xml"
            className="hidden"
            onChange={onFileSelected}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={parseMut.isPending}
            >
              {parseMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Vybrat výpis
            </Button>
            {fileName && (
              <span className="text-sm text-muted-foreground truncate">
                {fileName}
              </span>
            )}
            {(preview || result) && (
              <Button variant="ghost" onClick={resetAll} className="ml-auto">
                Nahrát jiný výpis
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Confirmation result */}
      {result && (
        <Card className="mb-6 border-green-300 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 font-semibold text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-5 w-5" />
              Označeno jako zaplaceno: {result.paidCount}
            </div>
            {result.skipped.length > 0 && (
              <ul className="mt-2 text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
                {result.skipped.map((s) => (
                  <li key={s.invoiceId}>
                    Faktura #{s.invoiceId}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Preview */}
      {preview && !result && (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground mb-3">
            <span>
              Formát:{" "}
              <span className="font-medium text-foreground">
                {preview.format === "camt" ? "CAMT.053" : "GPC/ABO"}
              </span>
            </span>
            {preview.account && <span>Účet: {preview.account}</span>}
            {preview.statementDate && (
              <span>Datum výpisu: {fmtDate(preview.statementDate)}</span>
            )}
            <span>
              Příchozích plateb:{" "}
              <span className="font-medium text-foreground">
                {preview.creditCount}
              </span>
            </span>
            <span>
              Spárováno:{" "}
              <span className="font-medium text-foreground">
                {preview.matchedCount}
              </span>
            </span>
          </div>

          {preview.transactions.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-muted-foreground">
                Ve výpisu nejsou žádné příchozí platby.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {preview.transactions.map((t, i) => (
                <TransactionRow
                  key={i}
                  t={t}
                  choice={choices[i]}
                  onToggle={(sel) => toggleRow(i, sel)}
                  onPick={(id) => setRowInvoice(i, id)}
                />
              ))}
            </div>
          )}

          <div className="sticky bottom-0 mt-4 py-3 bg-background/80 backdrop-blur border-t flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Vybráno k zaplacení: {selectedCount}
            </span>
            <Button
              className="ml-auto"
              onClick={onConfirm}
              disabled={selectedCount === 0 || confirmMut.isPending}
            >
              {confirmMut.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Potvrdit a označit jako zaplaceno
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function TransactionRow({
  t,
  choice,
  onToggle,
  onPick,
}: {
  t: BankMatchTransaction;
  choice: RowChoice | undefined;
  onToggle: (selected: boolean) => void;
  onPick: (invoiceId: number) => void;
}) {
  const meta = STATUS_META[t.matchStatus];
  const Icon = meta.icon;
  const actionable = isActionable(t);
  const selectedInvoice = t.candidates.find(
    (c) => c.invoiceId === choice?.invoiceId,
  );

  return (
    <Card>
      <CardContent className="p-3 flex items-start gap-3">
        {actionable ? (
          <Checkbox
            className="mt-1"
            checked={choice?.selected ?? false}
            onCheckedChange={(v) => onToggle(v === true)}
          />
        ) : (
          <div className="w-4" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{fmtKc(t.amount)}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
            >
              <Icon className="h-3 w-3" />
              {meta.label}
            </span>
            {t.date && (
              <span className="text-xs text-muted-foreground">
                {fmtDate(t.date)}
              </span>
            )}
          </div>

          <div className="text-sm text-muted-foreground mt-0.5 truncate">
            {t.counterparty || "Neznámý plátce"}
            {t.variableSymbol ? ` · VS ${t.variableSymbol}` : " · bez VS"}
          </div>

          {/* Matched / single candidate: show the target invoice inline. */}
          {actionable && t.candidates.length === 1 && selectedInvoice && (
            <div className="text-sm mt-1">
              →{" "}
              <span className="font-medium">
                {selectedInvoice.invoiceNumber ?? `#${selectedInvoice.invoiceId}`}
              </span>{" "}
              {selectedInvoice.customerName ? `· ${selectedInvoice.customerName} ` : ""}
              ({fmtKc(selectedInvoice.totalWithVat)})
              {!selectedInvoice.amountMatches && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  — částka na faktuře se liší
                </span>
              )}
            </div>
          )}

          {/* Multiple candidates: let the admin pick. */}
          {actionable && t.candidates.length > 1 && (
            <div className="mt-2">
              <Select
                value={choice?.invoiceId ? String(choice.invoiceId) : undefined}
                onValueChange={(v) => onPick(Number(v))}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Vyberte fakturu" />
                </SelectTrigger>
                <SelectContent>
                  {t.candidates.map((c) => (
                    <SelectItem key={c.invoiceId} value={String(c.invoiceId)}>
                      {(c.invoiceNumber ?? `#${c.invoiceId}`) +
                        (c.customerName ? ` · ${c.customerName}` : "") +
                        ` · ${fmtKc(c.totalWithVat)}` +
                        (c.amountMatches ? " ✓" : "")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Already paid: informational only. */}
          {t.matchStatus === "already_paid" && t.candidates[0] && (
            <div className="text-sm text-muted-foreground mt-1">
              Faktura{" "}
              {t.candidates[0].invoiceNumber ?? `#${t.candidates[0].invoiceId}`}{" "}
              je již zaplacená.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
