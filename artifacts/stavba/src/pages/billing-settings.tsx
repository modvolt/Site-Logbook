import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetBillingSettings,
  useUpdateBillingSettings,
  getGetBillingSettingsQueryKey,
  type BillingSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { VAT_MODE_LABELS } from "@/lib/billing-format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Save, Building2, Hash, Banknote, FileText } from "lucide-react";

type Form = {
  supplierName: string;
  supplierIc: string;
  supplierDic: string;
  supplierAddress: string;
  supplierEmail: string;
  supplierPhone: string;
  bankAccount: string;
  iban: string;
  bic: string;
  defaultDueDays: string;
  defaultPaymentMethod: string;
  vatPayer: boolean;
  vatModeDefault: string;
  invoiceFooterNote: string;
  numberPrefix: string;
  numberFormat: string;
  numberYear: string;
  numberNextSeq: string;
};

function toForm(s: BillingSettings): Form {
  return {
    supplierName: s.supplierName ?? "",
    supplierIc: s.supplierIc ?? "",
    supplierDic: s.supplierDic ?? "",
    supplierAddress: s.supplierAddress ?? "",
    supplierEmail: s.supplierEmail ?? "",
    supplierPhone: s.supplierPhone ?? "",
    bankAccount: s.bankAccount ?? "",
    iban: s.iban ?? "",
    bic: s.bic ?? "",
    defaultDueDays: String(s.defaultDueDays ?? 14),
    defaultPaymentMethod: s.defaultPaymentMethod ?? "",
    vatPayer: s.vatPayer,
    vatModeDefault: s.vatModeDefault,
    invoiceFooterNote: s.invoiceFooterNote ?? "",
    numberPrefix: s.numberPrefix ?? "",
    numberFormat: s.numberFormat ?? "",
    numberYear: s.numberYear != null ? String(s.numberYear) : "",
    numberNextSeq: String(s.numberNextSeq ?? 1),
  };
}

export default function BillingSettings() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useGetBillingSettings({
    query: { queryKey: getGetBillingSettingsQueryKey() },
  });
  const update = useUpdateBillingSettings();

  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data && !form) setForm(toForm(data));
  }, [data, form]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((p) => (p ? { ...p, [key]: value } : p));

  const handleSave = () => {
    if (!form) return;
    const trimOrNull = (v: string) => (v.trim() === "" ? null : v.trim());
    update.mutate(
      {
        data: {
          supplierName: form.supplierName.trim() || null,
          supplierIc: trimOrNull(form.supplierIc),
          supplierDic: trimOrNull(form.supplierDic),
          supplierAddress: trimOrNull(form.supplierAddress),
          supplierEmail: trimOrNull(form.supplierEmail),
          supplierPhone: trimOrNull(form.supplierPhone),
          bankAccount: trimOrNull(form.bankAccount),
          iban: trimOrNull(form.iban),
          bic: trimOrNull(form.bic),
          defaultDueDays: form.defaultDueDays.trim() === "" ? null : Number(form.defaultDueDays),
          defaultPaymentMethod: trimOrNull(form.defaultPaymentMethod),
          vatPayer: form.vatPayer,
          vatModeDefault: form.vatModeDefault,
          invoiceFooterNote: trimOrNull(form.invoiceFooterNote),
          numberPrefix: trimOrNull(form.numberPrefix),
          numberFormat: trimOrNull(form.numberFormat),
          numberYear: form.numberYear.trim() === "" ? null : Number(form.numberYear),
          numberNextSeq: form.numberNextSeq.trim() === "" ? null : Number(form.numberNextSeq),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBillingSettingsQueryKey() });
          toast({ title: "Nastavení uloženo" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se uložit nastavení", variant: "destructive" }),
      },
    );
  };

  if (isLoading || !form) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Fakturace
      </Button>
      <h1 className="text-2xl font-bold mb-6">Nastavení fakturace</h1>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5" /> Dodavatel
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Název / jméno dodavatele">
              <Input value={form.supplierName} onChange={(e) => set("supplierName", e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="IČ">
                <Input value={form.supplierIc} onChange={(e) => set("supplierIc", e.target.value)} />
              </Field>
              <Field label="DIČ">
                <Input value={form.supplierDic} onChange={(e) => set("supplierDic", e.target.value)} />
              </Field>
            </div>
            <Field label="Adresa">
              <Input value={form.supplierAddress} onChange={(e) => set("supplierAddress", e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="E-mail">
                <Input type="email" value={form.supplierEmail} onChange={(e) => set("supplierEmail", e.target.value)} />
              </Field>
              <Field label="Telefon">
                <Input type="tel" value={form.supplierPhone} onChange={(e) => set("supplierPhone", e.target.value)} />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-5 w-5" /> Platba
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Číslo účtu">
                <Input value={form.bankAccount} onChange={(e) => set("bankAccount", e.target.value)} />
              </Field>
              <Field label="Způsob platby">
                <Input
                  value={form.defaultPaymentMethod}
                  onChange={(e) => set("defaultPaymentMethod", e.target.value)}
                  placeholder="např. Převodem"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="IBAN">
                <Input value={form.iban} onChange={(e) => set("iban", e.target.value)} />
              </Field>
              <Field label="BIC / SWIFT">
                <Input value={form.bic} onChange={(e) => set("bic", e.target.value)} />
              </Field>
            </div>
            <Field label="Výchozí splatnost (dnů)">
              <Input
                type="number"
                value={form.defaultDueDays}
                onChange={(e) => set("defaultDueDays", e.target.value)}
                className="max-w-[160px]"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-5 w-5" /> DPH
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label className="font-medium">Plátce DPH</Label>
                <p className="text-xs text-muted-foreground">
                  Je dodavatel plátcem DPH?
                </p>
              </div>
              <Switch checked={form.vatPayer} onCheckedChange={(v) => set("vatPayer", v)} />
            </div>
            <Field label="Výchozí režim DPH">
              <Select value={form.vatModeDefault} onValueChange={(v) => set("vatModeDefault", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(VAT_MODE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Patička faktury (poznámka)">
              <Textarea
                value={form.invoiceFooterNote}
                onChange={(e) => set("invoiceFooterNote", e.target.value)}
                rows={2}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash className="h-5 w-5" /> Číslování faktur
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Prefix">
                <Input value={form.numberPrefix} onChange={(e) => set("numberPrefix", e.target.value)} />
              </Field>
              <Field label="Formát">
                <Input
                  value={form.numberFormat}
                  onChange={(e) => set("numberFormat", e.target.value)}
                  placeholder="např. {prefix}{year}{seq:4}"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Rok řady">
                <Input
                  type="number"
                  value={form.numberYear}
                  onChange={(e) => set("numberYear", e.target.value)}
                  placeholder="automaticky"
                />
              </Field>
              <Field label="Další pořadové číslo">
                <Input
                  type="number"
                  value={form.numberNextSeq}
                  onChange={(e) => set("numberNextSeq", e.target.value)}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Číslo se přiřazuje až při vystavení faktury. Pořadové číslo se po
              přechodu na nový rok automaticky resetuje.
            </p>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={update.isPending} className="h-11 px-6">
            <Save className="h-4 w-4 mr-2" /> Uložit nastavení
          </Button>
        </div>
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
