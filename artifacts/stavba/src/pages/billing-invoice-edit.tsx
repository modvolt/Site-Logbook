import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetInvoice,
  useUpdateInvoice,
  getGetInvoiceQueryKey,
  getListInvoicesQueryKey,
  getGetBillingSummaryQueryKey,
  type InvoiceDetail,
  type InvoiceLineInput,
  type InvoiceUpdateInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtKc, VAT_RATE_OPTIONS, VAT_HEADER_OPTIONS } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Save, Plus, Trash2, AlertCircle } from "lucide-react";

function errMsg(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const detail =
        (data as { detail?: unknown; title?: unknown }).detail ??
        (data as { title?: unknown }).title;
      if (typeof detail === "string") return detail;
    }
    if ("message" in err && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
  }
  return undefined;
}

type Header = {
  issueDate: string;
  taxableSupplyDate: string;
  dueDate: string;
  paymentMethod: string;
  variableSymbol: string;
  constantSymbol: string;
  specificSymbol: string;
  vatModeDefault: string;
  notes: string;
};

type LineRow = {
  key: string;
  sourceType: NonNullable<InvoiceLineInput["sourceType"]>;
  sourceId: number | null;
  jobId: number | null;
  activityId: number | null;
  description: string;
  quantity: string;
  unit: string;
  unitPriceWithoutVat: string;
  discountPercent: string;
  vatRate: string;
  vatMode: NonNullable<InvoiceLineInput["vatMode"]>;
};

const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function toHeader(inv: InvoiceDetail): Header {
  return {
    issueDate: dateInput(inv.issueDate),
    taxableSupplyDate: dateInput(inv.taxableSupplyDate),
    dueDate: dateInput(inv.dueDate),
    paymentMethod: inv.paymentMethod ?? "",
    variableSymbol: inv.variableSymbol ?? "",
    constantSymbol: inv.constantSymbol ?? "",
    specificSymbol: inv.specificSymbol ?? "",
    vatModeDefault: inv.vatModeDefault,
    notes: inv.notes ?? "",
  };
}

function toRows(inv: InvoiceDetail): LineRow[] {
  return inv.lines.map((l, i) => ({
    key: `l${l.id}-${i}`,
    sourceType: l.sourceType,
    sourceId: l.sourceId ?? null,
    jobId: l.jobId ?? null,
    activityId: l.activityId ?? null,
    description: l.description,
    quantity: l.quantity != null ? String(l.quantity) : "",
    unit: l.unit ?? "",
    unitPriceWithoutVat: l.unitPriceWithoutVat != null ? String(l.unitPriceWithoutVat) : "",
    discountPercent: l.discountPercent != null ? String(l.discountPercent) : "",
    vatRate: l.vatRate != null ? String(l.vatRate) : "",
    vatMode: l.vatMode,
  }));
}

function rowBaseTotal(r: LineRow): number {
  const qty = num(r.quantity) ?? 0;
  const price = num(r.unitPriceWithoutVat) ?? 0;
  const disc = num(r.discountPercent) ?? 0;
  return qty * price * (1 - disc / 100);
}

function rowVat(r: LineRow): number {
  if (r.vatMode !== "standard") return 0;
  const rate = num(r.vatRate) ?? 0;
  return rowBaseTotal(r) * (rate / 100);
}

export default function BillingInvoiceEdit() {
  const [, params] = useRoute("/billing/invoices/:id/edit");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: inv, isLoading } = useGetInvoice(id, {
    query: { queryKey: getGetInvoiceQueryKey(id), enabled: !!id },
  });
  const update = useUpdateInvoice();

  const [header, setHeader] = useState<Header | null>(null);
  const [rows, setRows] = useState<LineRow[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (inv && header === null) {
      setHeader(toHeader(inv));
      setRows(toRows(inv));
    }
  }, [inv, header]);

  const setH = <K extends keyof Header>(key: K, value: Header[K]) =>
    setHeader((p) => (p ? { ...p, [key]: value } : p));

  const setRow = (key: string, patch: Partial<LineRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    if ("description" in patch && rowErrors[key]) {
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (Object.keys(rowErrors).length <= 1) setSaveError(null);
    }
  };

  const addRow = () =>
    setRows((rs) => [
      ...rs,
      {
        key: `new-${Date.now()}-${rs.length}`,
        sourceType: "manual",
        sourceId: null,
        jobId: null,
        activityId: null,
        description: "",
        quantity: "1",
        unit: "",
        unitPriceWithoutVat: "",
        discountPercent: "",
        vatRate: header?.vatModeDefault === "standard" ? "21" : "",
        vatMode: (header?.vatModeDefault ?? "standard") as LineRow["vatMode"],
      },
    ]);

  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const subtotal = rows.reduce((s, r) => s + rowBaseTotal(r), 0);
  const totalVat = rows.reduce((s, r) => s + rowVat(r), 0);

  const handleSave = () => {
    if (!header) return;
    const errors: Record<string, string> = {};
    for (const r of rows) {
      if (r.description.trim() === "") {
        errors[r.key] = "Popis je povinný";
      }
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      setSaveError("Opravte chyby ve formuláři před uložením.");
      return;
    }
    setRowErrors({});
    setSaveError(null);
    const lines: InvoiceLineInput[] = rows.map((r, i) => ({
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      jobId: r.jobId,
      activityId: r.activityId,
      description: r.description.trim(),
      quantity: num(r.quantity),
      unit: r.unit.trim() || null,
      unitPriceWithoutVat: num(r.unitPriceWithoutVat),
      discountPercent: num(r.discountPercent),
      vatRate: num(r.vatRate),
      vatMode: r.vatMode,
      sortOrder: i,
    }));
    update.mutate(
      {
        id,
        data: {
          issueDate: header.issueDate || null,
          taxableSupplyDate: header.taxableSupplyDate || null,
          dueDate: header.dueDate || null,
          paymentMethod: header.paymentMethod.trim() || null,
          variableSymbol: header.variableSymbol.trim() || null,
          constantSymbol: header.constantSymbol.trim() || null,
          specificSymbol: header.specificSymbol.trim() || null,
          vatModeDefault: header.vatModeDefault as InvoiceUpdateInput["vatModeDefault"],
          notes: header.notes.trim() || null,
          lines,
        },
      },
      {
        onSuccess: () => {
          setSaveError(null);
          invalidateData(queryClient, "billingInvoices");
          toast({ title: "Koncept uložen" });
          setLocation(`/billing/invoices/${id}`);
        },
        onError: (err: unknown) => {
          const msg = errMsg(err) ?? "Uložení se nezdařilo. Zkuste to prosím znovu.";
          setSaveError(msg);
          toast({ title: "Uložení se nezdařilo", variant: "destructive" });
        },
      },
    );
  };

  if (isLoading || !header) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (inv && inv.status !== "draft") {
    return (
      <div className="p-8 text-center">
        <p className="text-lg font-semibold mb-2">Faktura již není koncept</p>
        <p className="text-sm text-muted-foreground mb-4">
          Vystavenou fakturu nelze upravovat.
        </p>
        <Button onClick={() => setLocation(`/billing/invoices/${id}`)}>Zpět na fakturu</Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation(`/billing/invoices/${id}`)}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Zpět na fakturu
      </Button>
      <h1 className="text-2xl font-bold mb-1">Úprava konceptu</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Odběratel: <span className="font-medium text-foreground">{inv?.customerName || "—"}</span>
      </p>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Údaje faktury</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Datum vystavení">
              <Input type="date" value={header.issueDate} onChange={(e) => setH("issueDate", e.target.value)} />
            </Field>
            <Field label="Datum zd. plnění">
              <Input type="date" value={header.taxableSupplyDate} onChange={(e) => setH("taxableSupplyDate", e.target.value)} />
            </Field>
            <Field label="Splatnost">
              <Input type="date" value={header.dueDate} onChange={(e) => setH("dueDate", e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Způsob platby">
              <Input value={header.paymentMethod} onChange={(e) => setH("paymentMethod", e.target.value)} placeholder="např. Převodem" />
            </Field>
            <Field label="Výchozí režim DPH">
              <Select value={header.vatModeDefault} onValueChange={(v) => setH("vatModeDefault", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VAT_HEADER_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Variabilní symbol">
              <Input value={header.variableSymbol} onChange={(e) => setH("variableSymbol", e.target.value)} />
            </Field>
            <Field label="Konstantní symbol">
              <Input value={header.constantSymbol} onChange={(e) => setH("constantSymbol", e.target.value)} />
            </Field>
            <Field label="Specifický symbol">
              <Input value={header.specificSymbol} onChange={(e) => setH("specificSymbol", e.target.value)} />
            </Field>
          </div>
          <Field label="Poznámka">
            <Textarea value={header.notes} onChange={(e) => setH("notes", e.target.value)} rows={2} />
          </Field>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Položky</CardTitle>
          <Button variant="outline" size="sm" onClick={addRow} className="h-9">
            <Plus className="h-4 w-4 mr-1" /> Přidat položku
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              Žádné položky. Přidejte první položku.
            </p>
          )}
          {rows.map((r) => (
            <div key={r.key} className="rounded-lg border p-3 space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    value={r.description}
                    onChange={(e) => setRow(r.key, { description: e.target.value })}
                    placeholder="Popis položky"
                    aria-invalid={!!rowErrors[r.key]}
                    className={rowErrors[r.key] ? "border-destructive focus-visible:ring-destructive" : ""}
                  />
                  {rowErrors[r.key] && (
                    <p className="text-destructive text-xs mt-1 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      {rowErrors[r.key]}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 text-destructive hover:bg-destructive/10 shrink-0"
                  onClick={() => removeRow(r.key)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <LabeledInput label="Množství" value={r.quantity} onChange={(v) => setRow(r.key, { quantity: v })} type="number" />
                <LabeledInput label="MJ" value={r.unit} onChange={(v) => setRow(r.key, { unit: v })} />
                <LabeledInput label="Cena/MJ" value={r.unitPriceWithoutVat} onChange={(v) => setRow(r.key, { unitPriceWithoutVat: v })} type="number" />
                <LabeledInput label="Sleva %" value={r.discountPercent} onChange={(v) => setRow(r.key, { discountPercent: v })} type="number" />
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Sazba DPH</Label>
                  <Select
                    value={r.vatMode === "reverse_charge" ? "pdp" : (r.vatRate === "12" ? "12" : "21")}
                    onValueChange={(v) => {
                      if (v === "pdp") setRow(r.key, { vatMode: "reverse_charge", vatRate: "" });
                      else if (v === "12") setRow(r.key, { vatMode: "standard", vatRate: "12" });
                      else setRow(r.key, { vatMode: "standard", vatRate: "21" });
                    }}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VAT_RATE_OPTIONS.map((opt) => {
                        const val = opt.vatMode === "reverse_charge" ? "pdp" : String(opt.vatRate);
                        return <SelectItem key={val} value={val}>{opt.label}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end">
                <div className="text-sm text-right">
                  <span className="text-muted-foreground">Bez DPH: </span>
                  <span className="font-semibold">{fmtKc(rowBaseTotal(r))}</span>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Základ bez DPH</span>
              <span className="font-medium">{fmtKc(subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">DPH (odhad)</span>
              <span className="font-medium">{fmtKc(totalVat)}</span>
            </div>
            <div className="flex justify-between border-t pt-1.5 text-base font-bold">
              <span>Celkem</span>
              <span>{fmtKc(subtotal + totalVat)}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-right">
            Konečné částky se přepočítají na serveru při uložení.
          </p>
        </CardContent>
      </Card>

      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setLocation(`/billing/invoices/${id}`)}>
          Zrušit
        </Button>
        <Button onClick={handleSave} disabled={update.isPending} className="h-11 px-6">
          <Save className="h-4 w-4 mr-2" /> Uložit koncept
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-sm font-medium text-muted-foreground mb-1 block">{label}</Label>
      {children}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1 block">{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="h-9" inputMode={type === "number" ? "decimal" : undefined} />
    </div>
  );
}
