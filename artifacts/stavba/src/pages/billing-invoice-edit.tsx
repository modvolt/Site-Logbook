import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import {
  useGetInvoice,
  useListCustomers,
  useUpdateInvoice,
  getGetInvoiceQueryKey,
  getListInvoicesQueryKey,
  getGetBillingSummaryQueryKey,
  type InvoiceDetail,
  type InvoiceLineInput,
  type InvoicePresentationGroup,
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
import {
  fmtKc,
  VAT_RATE_OPTIONS,
  VAT_HEADER_OPTIONS,
} from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  ListTree,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  InvoiceCustomPresentationEditor,
  InvoicePresentationModeControl,
  type InvoicePresentationMode,
} from "@/components/invoice-presentation-editor";
import {
  initializePresentationGroups,
  validatePresentationGroups,
} from "@/lib/invoice-presentation";
import { useBillingReturnNavigation } from "@/hooks/use-billing-navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

function errMsg(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const detail =
        (data as { detail?: unknown; title?: unknown }).detail ??
        (data as { title?: unknown }).title;
      if (typeof detail === "string") return detail;
    }
    if (
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
  }
  return undefined;
}

type Header = {
  customerId: string;
  customerName: string;
  customerIc: string;
  customerDic: string;
  customerAddress: string;
  customerDeliveryAddress: string;
  customerEmail: string;
  issueDate: string;
  taxableSupplyDate: string;
  dueDate: string;
  paymentMethod: string;
  bankAccount: string;
  iban: string;
  bic: string;
  currency: string;
  variableSymbol: string;
  constantSymbol: string;
  specificSymbol: string;
  vatModeDefault: string;
  notes: string;
};

type LineRow = {
  key: string;
  lineId: number | null;
  rowType: "item" | "section";
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

type SettlementMethod =
  | "direct"
  | "included_in_lump_sum"
  | "not_charged"
  | "deferred";

const SETTLEMENT_LABELS: Record<SettlementMethod, string> = {
  direct: "Samostatně na dokladu",
  included_in_lump_sum: "Zahrnuto v paušálu / jiné položce",
  not_charged: "Úmyslně neúčtovat",
  deferred: "Přesunout na další fakturu",
};

const SOURCE_LABELS: Record<string, string> = {
  job: "Cena zakázky",
  material: "Materiál",
  activity_material: "Materiál akce",
  activity_work: "Vícepráce akce",
  work_session: "Odpracovaný čas",
  billing_document_line: "Nákladový doklad",
  transport: "Doprava",
  parking: "Parkovné",
  fine: "Pokuta / penále",
  quote_item: "Položka nabídky",
};

const dateInput = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10) : "";
const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function toHeader(inv: InvoiceDetail): Header {
  return {
    customerId: inv.customerId != null ? String(inv.customerId) : "",
    customerName: inv.customerName ?? "",
    customerIc: inv.customerIc ?? "",
    customerDic: inv.customerDic ?? "",
    customerAddress: inv.customerAddress ?? "",
    customerDeliveryAddress: inv.customerDeliveryAddress ?? "",
    customerEmail: inv.customerEmail ?? "",
    issueDate: dateInput(inv.issueDate),
    taxableSupplyDate: dateInput(inv.taxableSupplyDate),
    dueDate: dateInput(inv.dueDate),
    paymentMethod: inv.paymentMethod ?? "",
    bankAccount: inv.bankAccount ?? "",
    iban: inv.iban ?? "",
    bic: inv.bic ?? "",
    currency: inv.currency,
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
    lineId: l.id,
    rowType: l.rowType,
    sourceType: l.sourceType,
    sourceId: l.sourceId ?? null,
    jobId: l.jobId ?? null,
    activityId: l.activityId ?? null,
    description: l.description,
    quantity: l.quantity != null ? String(l.quantity) : "",
    unit: l.unit ?? "",
    unitPriceWithoutVat:
      l.unitPriceWithoutVat != null ? String(l.unitPriceWithoutVat) : "",
    discountPercent: l.discountPercent != null ? String(l.discountPercent) : "",
    vatRate: l.vatRate != null ? String(l.vatRate) : "",
    vatMode: l.vatMode,
  }));
}

function rowBaseTotal(r: LineRow): number {
  if (r.rowType === "section") return 0;
  const qty = num(r.quantity) ?? 0;
  const price = num(r.unitPriceWithoutVat) ?? 0;
  const disc = num(r.discountPercent) ?? 0;
  return qty * price * (1 - disc / 100);
}

function rowVat(r: LineRow): number {
  if (r.rowType === "section") return 0;
  if (r.vatMode !== "standard") return 0;
  const rate = num(r.vatRate) ?? 0;
  return rowBaseTotal(r) * (rate / 100);
}

export default function BillingInvoiceEdit() {
  const [, params] = useRoute("/billing/invoices/:id/edit");
  const id = Number(params?.id);
  const { navigate: setLocation, preserveReturnTo } =
    useBillingReturnNavigation("/billing/invoices");
  const invoiceDetailLocation = preserveReturnTo(`/billing/invoices/${id}`);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps } = useConfirmDialog();

  const { data: inv, isLoading } = useGetInvoice(id, {
    query: { queryKey: getGetInvoiceQueryKey(id), enabled: !!id },
  });
  const { data: customers } = useListCustomers();
  const update = useUpdateInvoice();

  const [header, setHeader] = useState<Header | null>(null);
  const [rows, setRows] = useState<LineRow[]>([]);
  const [materialDisplayMode, setMaterialDisplayMode] =
    useState<InvoicePresentationMode>("detailed");
  const [presentationGroups, setPresentationGroups] = useState<
    InvoicePresentationGroup[]
  >([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const [allocationMethods, setAllocationMethods] = useState<
    Record<number, SettlementMethod>
  >({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (inv && header === null) {
      setHeader(toHeader(inv));
      setRows(toRows(inv));
      setMaterialDisplayMode(inv.materialDisplayMode);
      setPresentationGroups(
        initializePresentationGroups(inv.lines, inv.presentationGroups),
      );
      setAllocationMethods(
        Object.fromEntries(
          inv.sourceAllocations.map((allocation) => [
            allocation.id,
            allocation.settlementMethod,
          ]),
        ) as Record<number, SettlementMethod>,
      );
      setLinesDirty(false);
    }
  }, [inv, header]);

  const setH = <K extends keyof Header>(key: K, value: Header[K]) =>
    setHeader((p) => (p ? { ...p, [key]: value } : p));

  const selectCustomer = (customerId: string) => {
    const customer = customers?.find((item) => item.id === Number(customerId));
    if (!customer) return;
    setHeader((current) =>
      current
        ? {
            ...current,
            customerId,
            customerName: customer.companyName,
            customerIc: customer.ic ?? "",
            customerDic: customer.dic ?? "",
            customerAddress: customer.address ?? "",
            customerEmail: customer.email ?? "",
          }
        : current,
    );
  };

  const setRow = (key: string, patch: Partial<LineRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setLinesDirty(true);
    if ("description" in patch && rowErrors[key]) {
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (Object.keys(rowErrors).length <= 1) setSaveError(null);
    }
  };

  const addRow = (rowType: LineRow["rowType"] = "item") => {
    setLinesDirty(true);
    setRows((rs) => [
      ...rs,
      {
        key: `new-${Date.now()}-${rs.length}`,
        lineId: null,
        rowType,
        sourceType: "manual",
        sourceId: null,
        jobId: null,
        activityId: null,
        description: "",
        quantity: rowType === "section" ? "0" : "1",
        unit: "",
        unitPriceWithoutVat: rowType === "section" ? "0" : "",
        discountPercent: "",
        vatRate: header?.vatModeDefault === "standard" ? "21" : "",
        vatMode: (header?.vatModeDefault ?? "standard") as LineRow["vatMode"],
      },
    ]);
  };

  const removeRow = (key: string) => {
    const removed = rows.find((row) => row.key === key);
    const remaining = rows.filter((row) => row.key !== key);
    if (removed?.lineId != null && inv) {
      const replacementMethod: SettlementMethod = remaining.some(
        (row) => row.rowType === "item",
      )
        ? "included_in_lump_sum"
        : "deferred";
      const affected = inv.sourceAllocations.filter(
        (allocation) =>
          allocation.invoiceLineId === removed.lineId &&
          (allocationMethods[allocation.id] ?? allocation.settlementMethod) ===
            "direct",
      );
      if (affected.length) {
        setAllocationMethods((current) => ({
          ...current,
          ...Object.fromEntries(
            affected.map((allocation) => [allocation.id, replacementMethod]),
          ),
        }));
        toast({
          title: "Zdrojová data zůstala zachována",
          description:
            replacementMethod === "included_in_lump_sum"
              ? `${affected.length} zdrojů bylo označeno jako zahrnutých v jiné položce. Volbu můžete změnit v panelu vypořádání.`
              : `${affected.length} zdrojů bylo přesunuto na další fakturu. Volbu můžete změnit v panelu vypořádání.`,
        });
      }
    }
    setLinesDirty(true);
    setRows(remaining);
  };

  const duplicateRow = (key: string) => {
    setLinesDirty(true);
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      if (index < 0) return current;
      const copy = {
        ...current[index],
        key: `copy-${Date.now()}-${index}`,
        lineId: null,
        sourceType: "manual" as const,
        sourceId: null,
        jobId: null,
        activityId: null,
      };
      const next = [...current];
      next.splice(index + 1, 0, copy);
      return next;
    });
  };

  const moveRow = (key: string, direction: -1 | 1) => {
    setLinesDirty(true);
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const subtotal = rows.reduce((s, r) => s + rowBaseTotal(r), 0);
  const totalVat = rows.reduce((s, r) => s + rowVat(r), 0);
  const jobsWithOperationalLumpSources = new Set(
    (inv?.sourceAllocations ?? [])
      .filter((allocation) => {
        const method =
          allocationMethods[allocation.id] ?? allocation.settlementMethod;
        return (
          allocation.jobId != null &&
          method === "included_in_lump_sum" &&
          ["work_session", "material"].includes(allocation.sourceType)
        );
      })
      .map((allocation) => allocation.jobId as number),
  );
  const selectedSourceTotal = (inv?.sourceAllocations ?? []).reduce(
    (sum, allocation) => {
      const method =
        allocationMethods[allocation.id] ?? allocation.settlementMethod;
      if (
        method === "deferred" ||
        method === "not_charged" ||
        (allocation.sourceType === "job" &&
          allocation.jobId != null &&
          jobsWithOperationalLumpSources.has(allocation.jobId))
      ) {
        return sum;
      }
      return sum + allocation.sourceAmountWithoutVat;
    },
    0,
  );
  const sourceDifference = subtotal - selectedSourceTotal;
  const presentationSourceLines = rows.map((row) => ({
    description: row.description,
    totalWithoutVat: rowBaseTotal(row),
    vatMode: row.vatMode,
    vatRate: num(row.vatRate),
  }));

  const changePresentationMode = (next: InvoicePresentationMode) => {
    if (next === "custom" && materialDisplayMode !== "custom") {
      const storedGroups = linesDirty
        ? []
        : presentationGroups.length > 0
          ? presentationGroups
          : (inv?.presentationGroups ?? []);
      setPresentationGroups(
        initializePresentationGroups(presentationSourceLines, storedGroups),
      );
    }
    setMaterialDisplayMode(next);
    setSaveError(null);
  };

  const submitUpdate = (data: InvoiceUpdateInput) => {
    update.mutate(
      {
        id,
        data,
      },
      {
        onSuccess: () => {
          setSaveError(null);
          invalidateData(queryClient, "billingInvoices");
          toast({ title: "Koncept uložen" });
          setLocation(invoiceDetailLocation);
        },
        onError: (err: unknown) => {
          const msg =
            errMsg(err) ?? "Uložení se nezdařilo. Zkuste to prosím znovu.";
          setSaveError(msg);
          toast({ title: "Uložení se nezdařilo", variant: "destructive" });
        },
      },
    );
  };

  const handleSave = () => {
    if (!header) return;
    if (
      !Number.isInteger(Number(header.customerId)) ||
      Number(header.customerId) <= 0
    ) {
      setSaveError("Vyberte odběratele.");
      return;
    }
    if (!header.customerName.trim()) {
      setSaveError("Doplňte název odběratele.");
      return;
    }
    if (!/^[A-Z]{3}$/.test(header.currency.trim().toUpperCase())) {
      setSaveError("Měna musí být třípísmenný kód, například CZK.");
      return;
    }
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
    if (materialDisplayMode === "custom") {
      const presentationError = validatePresentationGroups(
        presentationGroups,
        presentationSourceLines,
      );
      if (presentationError) {
        setSaveError(presentationError);
        return;
      }
    }
    setRowErrors({});
    setSaveError(null);
    const lines: InvoiceLineInput[] = rows.map((r, i) => ({
      id: r.lineId,
      rowType: r.rowType,
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
    const data: InvoiceUpdateInput = {
      customerId: Number(header.customerId),
      customerName: header.customerName.trim(),
      customerIc: header.customerIc.trim() || null,
      customerDic: header.customerDic.trim() || null,
      customerAddress: header.customerAddress.trim() || null,
      customerDeliveryAddress: header.customerDeliveryAddress.trim() || null,
      customerEmail: header.customerEmail.trim() || null,
      issueDate: header.issueDate || null,
      taxableSupplyDate: header.taxableSupplyDate || null,
      dueDate: header.dueDate || null,
      paymentMethod: header.paymentMethod.trim() || null,
      bankAccount: header.bankAccount.trim() || null,
      iban: header.iban.trim() || null,
      bic: header.bic.trim() || null,
      currency: header.currency.trim().toUpperCase(),
      variableSymbol: header.variableSymbol.trim() || null,
      constantSymbol: header.constantSymbol.trim() || null,
      specificSymbol: header.specificSymbol.trim() || null,
      vatModeDefault:
        header.vatModeDefault as InvoiceUpdateInput["vatModeDefault"],
      materialDisplayMode,
      notes: header.notes.trim() || null,
      ...(linesDirty ? { lines } : {}),
      ...(materialDisplayMode === "custom" ? { presentationGroups } : {}),
      ...(inv?.documentType === "standard"
        ? {
            sourceAllocations: inv.sourceAllocations.map((allocation) => ({
              id: allocation.id,
              settlementMethod:
                allocationMethods[allocation.id] ?? allocation.settlementMethod,
            })),
          }
        : {}),
    };
    const changesCustomer =
      inv != null && Number(header.customerId) !== inv.customerId;
    const hasOperationalSources =
      (inv?.sourceJobIds.length ?? 0) + (inv?.sourceActivityIds?.length ?? 0) >
      0;
    if (changesCustomer && hasOperationalSources) {
      openConfirm(
        {
          title: "Potvrdit jiného odběratele?",
          description:
            "Zdrojové zakázky nebo akce patří původnímu odběrateli. Jejich údaje se nezmění; výjimka se zapíše do auditu a backend ji dovolí jen správci.",
          confirmLabel: "Potvrdit výjimku",
          destructive: false,
        },
        () => submitUpdate({ ...data, allowCustomerMismatch: true }),
      );
      return;
    }
    submitUpdate(data);
  };

  if (isLoading || !header) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto w-full space-y-4">
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
        <Button onClick={() => setLocation(invoiceDetailLocation)}>
          Zpět na fakturu
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation(invoiceDetailLocation)}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Zpět na fakturu
      </Button>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {inv?.documentType === "advance"
              ? "Úprava zálohové faktury"
              : "Úprava konceptu faktury"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Změny odběratele, banky i položek se uloží do neměnného snímku
            dokladu.
          </p>
        </div>
        {inv?.documentType === "advance" && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
            Platební výzva · bez vypořádání zakázek
          </span>
        )}
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Odběratel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Zákazník v adresáři">
            <Select value={header.customerId} onValueChange={selectCustomer}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Vyberte odběratele" />
              </SelectTrigger>
              <SelectContent>
                {[...(customers ?? [])]
                  .sort((a, b) =>
                    a.companyName.localeCompare(b.companyName, "cs"),
                  )
                  .map((customer) => (
                    <SelectItem key={customer.id} value={String(customer.id)}>
                      {customer.companyName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Název odběratele">
              <Input
                value={header.customerName}
                onChange={(e) => setH("customerName", e.target.value)}
              />
            </Field>
            <Field label="E-mail">
              <Input
                type="email"
                value={header.customerEmail}
                onChange={(e) => setH("customerEmail", e.target.value)}
              />
            </Field>
            <Field label="IČ">
              <Input
                value={header.customerIc}
                onChange={(e) => setH("customerIc", e.target.value)}
              />
            </Field>
            <Field label="DIČ">
              <Input
                value={header.customerDic}
                onChange={(e) => setH("customerDic", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Fakturační adresa">
            <Input
              value={header.customerAddress}
              onChange={(e) => setH("customerAddress", e.target.value)}
            />
          </Field>
          <Field label="Dodací adresa">
            <Input
              value={header.customerDeliveryAddress}
              onChange={(e) => setH("customerDeliveryAddress", e.target.value)}
              placeholder="Pokud se liší od fakturační"
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Údaje faktury</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Datum vystavení">
              <Input
                type="date"
                value={header.issueDate}
                onChange={(e) => setH("issueDate", e.target.value)}
              />
            </Field>
            {inv?.documentType !== "advance" && (
              <Field label="Datum zd. plnění">
                <Input
                  type="date"
                  value={header.taxableSupplyDate}
                  onChange={(e) => setH("taxableSupplyDate", e.target.value)}
                />
              </Field>
            )}
            <Field label="Splatnost">
              <Input
                type="date"
                value={header.dueDate}
                onChange={(e) => setH("dueDate", e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Způsob platby">
              <Input
                value={header.paymentMethod}
                onChange={(e) => setH("paymentMethod", e.target.value)}
                placeholder="např. Převodem"
              />
            </Field>
            <Field label="Výchozí režim DPH">
              <Select
                value={header.vatModeDefault}
                onValueChange={(v) => setH("vatModeDefault", v)}
              >
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
            <Field label="Měna">
              <Input
                value={header.currency}
                maxLength={3}
                onChange={(e) => setH("currency", e.target.value.toUpperCase())}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Bankovní účet">
              <Input
                value={header.bankAccount}
                onChange={(e) => setH("bankAccount", e.target.value)}
              />
            </Field>
            <Field label="IBAN">
              <Input
                value={header.iban}
                onChange={(e) => setH("iban", e.target.value)}
              />
            </Field>
            <Field label="BIC / SWIFT">
              <Input
                value={header.bic}
                onChange={(e) => setH("bic", e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Variabilní symbol">
              <Input
                value={header.variableSymbol}
                onChange={(e) => setH("variableSymbol", e.target.value)}
              />
            </Field>
            <Field label="Konstantní symbol">
              <Input
                value={header.constantSymbol}
                onChange={(e) => setH("constantSymbol", e.target.value)}
              />
            </Field>
            <Field label="Specifický symbol">
              <Input
                value={header.specificSymbol}
                onChange={(e) => setH("specificSymbol", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Poznámka">
            <Textarea
              value={header.notes}
              onChange={(e) => setH("notes", e.target.value)}
              rows={2}
            />
          </Field>
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <InvoicePresentationModeControl
              value={materialDisplayMode}
              hasMaterial={rows.some((row) =>
                ["material", "activity_material"].includes(row.sourceType),
              )}
              onChange={changePresentationMode}
            />
          </CardContent>
        </Card>
      )}

      {materialDisplayMode === "custom" ? (
        <Card className="mb-4">
          <CardContent className="p-4">
            <InvoiceCustomPresentationEditor
              lines={presentationSourceLines}
              groups={presentationGroups}
              onChange={setPresentationGroups}
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-4">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Položky</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => addRow("section")}
                className="h-9"
              >
                <ListTree className="h-4 w-4 mr-1" /> Přidat sekci
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => addRow("item")}
                className="h-9"
              >
                <Plus className="h-4 w-4 mr-1" /> Přidat položku
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Žádné položky. Přidejte první položku.
              </p>
            )}
            {rows.map((r, index) => (
              <div
                key={r.key}
                className={`rounded-xl p-3 space-y-2 ${
                  r.rowType === "section"
                    ? "bg-blue-50/80 dark:bg-blue-950/25"
                    : "border"
                }`}
              >
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      value={r.description}
                      onChange={(e) =>
                        setRow(r.key, { description: e.target.value })
                      }
                      placeholder={
                        r.rowType === "section"
                          ? "Název sekce"
                          : "Popis položky"
                      }
                      aria-invalid={!!rowErrors[r.key]}
                      className={`${
                        r.rowType === "section"
                          ? "font-semibold text-blue-950 dark:text-blue-100"
                          : ""
                      } ${rowErrors[r.key] ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    />
                    {rowErrors[r.key] && (
                      <p className="text-destructive text-xs mt-1 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        {rowErrors[r.key]}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      disabled={index === 0}
                      onClick={() => moveRow(r.key, -1)}
                      aria-label="Posunout řádek nahoru"
                      title="Posunout nahoru"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      disabled={index === rows.length - 1}
                      onClick={() => moveRow(r.key, 1)}
                      aria-label="Posunout řádek dolů"
                      title="Posunout dolů"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={() => duplicateRow(r.key)}
                      aria-label="Duplikovat řádek"
                      title="Duplikovat"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => removeRow(r.key)}
                      aria-label="Odstranit řádek"
                      title="Odstranit"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {r.rowType === "item" && (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      <LabeledInput
                        label="Množství"
                        value={r.quantity}
                        onChange={(v) => setRow(r.key, { quantity: v })}
                        type="number"
                      />
                      <LabeledInput
                        label="MJ"
                        value={r.unit}
                        onChange={(v) => setRow(r.key, { unit: v })}
                      />
                      <LabeledInput
                        label="Cena/MJ"
                        value={r.unitPriceWithoutVat}
                        onChange={(v) =>
                          setRow(r.key, { unitPriceWithoutVat: v })
                        }
                        type="number"
                      />
                      <LabeledInput
                        label="Sleva %"
                        value={r.discountPercent}
                        onChange={(v) => setRow(r.key, { discountPercent: v })}
                        type="number"
                      />
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">
                          Sazba DPH
                        </Label>
                        <Select
                          value={
                            r.vatMode === "reverse_charge"
                              ? "pdp"
                              : r.vatRate === "12"
                                ? "12"
                                : "21"
                          }
                          onValueChange={(v) => {
                            if (v === "pdp")
                              setRow(r.key, {
                                vatMode: "reverse_charge",
                                vatRate: "",
                              });
                            else if (v === "12")
                              setRow(r.key, {
                                vatMode: "standard",
                                vatRate: "12",
                              });
                            else
                              setRow(r.key, {
                                vatMode: "standard",
                                vatRate: "21",
                              });
                          }}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VAT_RATE_OPTIONS.map((opt) => {
                              const val =
                                opt.vatMode === "reverse_charge"
                                  ? "pdp"
                                  : String(opt.vatRate);
                              return (
                                <SelectItem key={val} value={val}>
                                  {opt.label}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <div className="text-sm text-right">
                        <span className="text-muted-foreground">Bez DPH: </span>
                        <span className="font-semibold">
                          {fmtKc(rowBaseTotal(r))}
                        </span>
                      </div>
                    </div>
                  </>
                )}
                {r.rowType === "section" && (
                  <p className="text-xs text-blue-800/80 dark:text-blue-200/80">
                    Sekce organizuje výsledné PDF a nemá vlastní cenu.
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {inv?.documentType === "standard" && inv.sourceAllocations.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Vypořádání zdrojů</CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">
              Každý čas, materiál a další zdroj musí mít vlastní výsledek.
              Smazání nebo sloučení řádku na faktuře tuto evidenci neztratí.
            </p>
            {(inv.sourceJobs?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {inv.sourceJobs?.map((job) => (
                  <span
                    key={job.id}
                    className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium"
                  >
                    {job.jobNumber != null ? `#${job.jobNumber} ` : ""}
                    {job.title}
                  </span>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {inv.sourceAllocations.map((allocation) => (
              <div
                key={allocation.id}
                className="grid gap-3 rounded-xl border p-3 md:grid-cols-[minmax(0,1fr)_16rem] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {SOURCE_LABELS[allocation.sourceType] ??
                        allocation.sourceType}
                    </span>
                    {allocation.legacyIncomplete && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        historická vazba
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-medium">
                    {allocation.sourceDescription}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {allocation.allocatedQuantity.toLocaleString("cs-CZ")}
                    {allocation.sourceUnit ? ` ${allocation.sourceUnit}` : ""}
                    {" · "}
                    {fmtKc(allocation.sourceAmountWithoutVat)} bez DPH
                  </p>
                </div>
                <Select
                  value={
                    allocationMethods[allocation.id] ??
                    allocation.settlementMethod
                  }
                  onValueChange={(value) =>
                    setAllocationMethods((current) => ({
                      ...current,
                      [allocation.id]: value as SettlementMethod,
                    }))
                  }
                >
                  <SelectTrigger
                    className="h-10"
                    aria-label={`Vypořádání zdroje ${allocation.sourceDescription}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      Object.entries(SETTLEMENT_LABELS) as Array<
                        [SettlementMethod, string]
                      >
                    ).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            <div className="grid gap-2 rounded-xl bg-muted/55 p-4 text-sm md:grid-cols-3">
              <div>
                <p className="text-muted-foreground">Zdroje k vypořádání</p>
                <p className="mt-1 font-semibold">
                  {fmtKc(selectedSourceTotal)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Položky faktury</p>
                <p className="mt-1 font-semibold">{fmtKc(subtotal)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Rozdíl</p>
                <p
                  className={`mt-1 font-semibold ${Math.abs(sourceDifference) >= 0.01 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}
                >
                  {fmtKc(sourceDifference)}
                </p>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Rozdíl může být záměrný u paušálu. Položky označené „neúčtovat“
              nebo „na další fakturu“ se do součtu zdrojů nezapočítávají.
            </p>
          </CardContent>
        </Card>
      )}

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
        <Button
          variant="ghost"
          onClick={() => setLocation(invoiceDetailLocation)}
        >
          Zrušit
        </Button>
        <Button
          onClick={handleSave}
          disabled={update.isPending}
          className="h-11 px-6"
        >
          <Save className="h-4 w-4 mr-2" /> Uložit koncept
        </Button>
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-sm font-medium text-muted-foreground mb-1 block">
        {label}
      </Label>
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
      <Label className="text-xs text-muted-foreground mb-1 block">
        {label}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
        inputMode={type === "number" ? "decimal" : undefined}
      />
    </div>
  );
}
