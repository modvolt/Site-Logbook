import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useCreateInvoice,
  useListCustomers,
  type InvoiceCreateInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Loader2, Plus, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { invalidateData } from "@/lib/query-invalidation";

type DocumentType = "standard" | "advance";

type FormState = {
  customerId: string;
  customerName: string;
  customerIc: string;
  customerDic: string;
  customerAddress: string;
  customerDeliveryAddress: string;
  customerEmail: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatKey: "21" | "12" | "pdp";
  currency: string;
  notes: string;
};

const INITIAL_FORM: FormState = {
  customerId: "",
  customerName: "",
  customerIc: "",
  customerDic: "",
  customerAddress: "",
  customerDeliveryAddress: "",
  customerEmail: "",
  description: "",
  quantity: "1",
  unit: "ks",
  unitPrice: "",
  vatKey: "21",
  currency: "CZK",
  notes: "",
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const detail = (data as { detail?: unknown; title?: unknown }).detail;
      if (typeof detail === "string") return detail;
      const title = (data as { title?: unknown }).title;
      if (typeof title === "string") return title;
    }
    if (
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
  }
  return "Koncept se nepodařilo vytvořit. Zkuste to znovu.";
}

export default function BillingInvoiceNew() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: customers, isLoading: customersLoading } = useListCustomers();
  const createInvoice = useCreateInvoice();
  const [documentType, setDocumentType] = useState<DocumentType>("standard");
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [error, setError] = useState<string | null>(null);

  const sortedCustomers = useMemo(
    () =>
      [...(customers ?? [])].sort((a, b) =>
        a.companyName.localeCompare(b.companyName, "cs"),
      ),
    [customers],
  );

  const patchForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const selectCustomer = (value: string) => {
    const customer = sortedCustomers.find((item) => item.id === Number(value));
    if (!customer) return;
    patchForm({
      customerId: value,
      customerName: customer.companyName,
      customerIc: customer.ic ?? "",
      customerDic: customer.dic ?? "",
      customerAddress: customer.address ?? "",
      customerEmail: customer.email ?? "",
    });
  };

  const submit = () => {
    const customerId = Number(form.customerId);
    const quantity = Number(form.quantity);
    const unitPrice = Number(form.unitPrice);
    const currency = form.currency.trim().toUpperCase();
    if (!Number.isInteger(customerId) || customerId <= 0) {
      setError("Vyberte odběratele.");
      return;
    }
    if (!form.customerName.trim()) {
      setError("Doplňte název odběratele.");
      return;
    }
    if (!form.description.trim()) {
      setError("Doplňte popis první položky.");
      return;
    }
    if (!Number.isFinite(quantity) || quantity === 0) {
      setError("Množství musí být nenulové číslo.");
      return;
    }
    if (!Number.isFinite(unitPrice)) {
      setError("Doplňte platnou cenu za jednotku.");
      return;
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      setError("Měna musí být třípísmenný kód, například CZK.");
      return;
    }

    const reverseCharge = form.vatKey === "pdp";
    const data: InvoiceCreateInput = {
      documentType,
      customerId,
      customerName: form.customerName.trim(),
      customerIc: form.customerIc.trim() || null,
      customerDic: form.customerDic.trim() || null,
      customerAddress: form.customerAddress.trim() || null,
      customerDeliveryAddress: form.customerDeliveryAddress.trim() || null,
      customerEmail: form.customerEmail.trim() || null,
      currency,
      vatModeDefault: reverseCharge ? "reverse_charge" : "standard",
      notes: form.notes.trim() || null,
      lines: [
        {
          rowType: "item",
          sourceType: "manual",
          description: form.description.trim(),
          quantity,
          unit: form.unit.trim() || null,
          unitPriceWithoutVat: unitPrice,
          vatMode: reverseCharge ? "reverse_charge" : "standard",
          vatRate: reverseCharge ? null : Number(form.vatKey),
        },
      ],
    };

    createInvoice.mutate(
      { data },
      {
        onSuccess: (invoice) => {
          invalidateData(queryClient, "billingInvoices");
          toast({
            title:
              documentType === "advance"
                ? "Zálohový koncept vytvořen"
                : "Koncept faktury vytvořen",
          });
          setLocation(`/billing/invoices/${invoice.id}/edit`);
        },
        onError: (mutationError) => setError(errorMessage(mutationError)),
      },
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-8">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-3 text-muted-foreground"
        onClick={() => setLocation("/billing/invoices")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> Faktury
      </Button>

      <div className="mb-7 max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Nový doklad
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Vytvořte běžnou nebo zálohovou fakturu přímo na odběratele. Zakázka
          není povinná a další položky doplníte v editoru konceptu.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Typ dokladu</CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={documentType}
                onValueChange={(value) => {
                  setDocumentType(value as DocumentType);
                  setError(null);
                }}
                className="grid gap-3 md:grid-cols-2"
              >
                <DocumentTypeOption
                  id="document-standard"
                  value="standard"
                  selected={documentType === "standard"}
                  icon={<FileText className="h-5 w-5" />}
                  title="Běžná faktura"
                  description="Daňový doklad; může být i zcela bez zakázky."
                />
                <DocumentTypeOption
                  id="document-advance"
                  value="advance"
                  selected={documentType === "advance"}
                  icon={<WalletCards className="h-5 w-5" />}
                  title="Zálohová faktura"
                  description="Platební výzva; nevypořádá práci, materiál ani sklad."
                />
              </RadioGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Odběratel</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label="Vybrat odběratele" required>
                <Select
                  value={form.customerId}
                  onValueChange={selectCustomer}
                  disabled={customersLoading}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue
                      placeholder={
                        customersLoading
                          ? "Načítám odběratele…"
                          : "Vyberte odběratele"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedCustomers.map((customer) => (
                      <SelectItem key={customer.id} value={String(customer.id)}>
                        {customer.companyName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <div className="grid gap-3 md:grid-cols-2">
                <FormField label="Název odběratele" required>
                  <Input
                    value={form.customerName}
                    onChange={(event) =>
                      patchForm({ customerName: event.target.value })
                    }
                  />
                </FormField>
                <FormField label="E-mail">
                  <Input
                    type="email"
                    value={form.customerEmail}
                    onChange={(event) =>
                      patchForm({ customerEmail: event.target.value })
                    }
                  />
                </FormField>
                <FormField label="IČ">
                  <Input
                    value={form.customerIc}
                    onChange={(event) =>
                      patchForm({ customerIc: event.target.value })
                    }
                  />
                </FormField>
                <FormField label="DIČ">
                  <Input
                    value={form.customerDic}
                    onChange={(event) =>
                      patchForm({ customerDic: event.target.value })
                    }
                  />
                </FormField>
              </div>
              <FormField label="Fakturační adresa">
                <Input
                  value={form.customerAddress}
                  onChange={(event) =>
                    patchForm({ customerAddress: event.target.value })
                  }
                />
              </FormField>
              <FormField label="Dodací adresa">
                <Input
                  value={form.customerDeliveryAddress}
                  onChange={(event) =>
                    patchForm({ customerDeliveryAddress: event.target.value })
                  }
                  placeholder="Pokud se liší od fakturační"
                />
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">První položka</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label="Popis" required>
                <Input
                  value={form.description}
                  onChange={(event) =>
                    patchForm({ description: event.target.value })
                  }
                  placeholder={
                    documentType === "advance"
                      ? "Záloha na dodávku a montáž"
                      : "Dodávka a montáž"
                  }
                />
              </FormField>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <FormField label="Množství" required>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={form.quantity}
                    onChange={(event) =>
                      patchForm({ quantity: event.target.value })
                    }
                  />
                </FormField>
                <FormField label="MJ">
                  <Input
                    value={form.unit}
                    onChange={(event) =>
                      patchForm({ unit: event.target.value })
                    }
                  />
                </FormField>
                <FormField
                  label="Cena / MJ"
                  required
                  className="col-span-2 md:col-span-1"
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={form.unitPrice}
                    onChange={(event) =>
                      patchForm({ unitPrice: event.target.value })
                    }
                  />
                </FormField>
                <FormField label="DPH">
                  <Select
                    value={form.vatKey}
                    onValueChange={(value) =>
                      patchForm({ vatKey: value as FormState["vatKey"] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="21">21 %</SelectItem>
                      <SelectItem value="12">12 %</SelectItem>
                      <SelectItem value="pdp">PDP</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label="Měna">
                  <Input
                    maxLength={3}
                    value={form.currency}
                    onChange={(event) =>
                      patchForm({ currency: event.target.value.toUpperCase() })
                    }
                  />
                </FormField>
              </div>
              <FormField label="Poznámka">
                <Textarea
                  rows={3}
                  value={form.notes}
                  onChange={(event) => patchForm({ notes: event.target.value })}
                />
              </FormField>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <div className="rounded-xl bg-muted/55 p-4 text-sm leading-6">
            <p className="font-semibold text-foreground">
              Po vytvoření konceptu
            </p>
            <p className="mt-1 text-muted-foreground">
              Otevře se plný editor, kde lze přidat sekce a položky, změnit
              bankovní účet, adresy, data i symboly.
            </p>
          </div>
          {documentType === "advance" && (
            <div className="rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:bg-amber-950/35 dark:text-amber-100">
              Zálohová faktura bude na PDF označena jako platební výzva, nikoli
              jako daňový doklad.
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <Button
            className="h-11 w-full"
            onClick={submit}
            disabled={createInvoice.isPending}
          >
            {createInvoice.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Vytvořit koncept
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => setLocation("/billing/invoices")}
            disabled={createInvoice.isPending}
          >
            Zrušit
          </Button>
        </aside>
      </div>
    </div>
  );
}

function DocumentTypeOption({
  id,
  value,
  selected,
  icon,
  title,
  description,
}: {
  id: string;
  value: DocumentType;
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/55"
      }`}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-semibold text-foreground">
          {icon} {title}
        </span>
        <span className="mt-1 block text-sm font-normal leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </Label>
  );
}

function FormField({
  label,
  required = false,
  className = "",
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
    </div>
  );
}
