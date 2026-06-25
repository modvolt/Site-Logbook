import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetBillingSettings,
  useUpdateBillingSettings,
  getGetBillingSettingsQueryKey,
  useGetDocumentExtractionStatus,
  getGetDocumentExtractionStatusQueryKey,
  useTestDocumentExtraction,
  useUpdateDocumentExtraction,
  useGetDocumentLinking,
  getGetDocumentLinkingQueryKey,
  useUpdateDocumentLinking,
  useListMaterialMarkupRules,
  getListMaterialMarkupRulesQueryKey,
  useUpsertMaterialMarkupRule,
  useDeleteMaterialMarkupRule,
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
import { DecimalInput, parseDecimal, decimalError } from "@/components/decimal-input";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Save,
  Building2,
  Hash,
  Banknote,
  FileText,
  BellRing,
  Sparkles,
  CheckCircle2,
  XCircle,
  Loader2,
  Percent,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  materialMarkupPercent: string;
  numberPrefix: string;
  numberFormat: string;
  numberYear: string;
  numberNextSeq: string;
  reminderEnabled: boolean;
  reminderDays: string;
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
    materialMarkupPercent: String(s.materialMarkupPercent ?? 0),
    numberPrefix: s.numberPrefix ?? "",
    numberFormat: s.numberFormat ?? "",
    numberYear: s.numberYear != null ? String(s.numberYear) : "",
    numberNextSeq: String(s.numberNextSeq ?? 1),
    reminderEnabled: s.reminderEnabled ?? false,
    reminderDays: s.reminderDays ?? "3,14,30",
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

  const { data: aiStatus, isLoading: aiLoading } = useGetDocumentExtractionStatus({
    query: { queryKey: getGetDocumentExtractionStatusQueryKey() },
  });
  const testAi = useTestDocumentExtraction();
  const updateAi = useUpdateDocumentExtraction();
  const [aiTestMsg, setAiTestMsg] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [aiForm, setAiForm] = useState<{
    enabled: boolean;
    apiKey: string;
    model: string;
    systemPrompt: string;
    maxFileMb: string;
    timeoutMs: string;
    confidence: string;
  } | null>(null);

  useEffect(() => {
    if (aiStatus && !aiForm) {
      setAiForm({
        enabled: aiStatus.enabled,
        apiKey: "",
        model: aiStatus.model,
        systemPrompt: aiStatus.systemPrompt,
        maxFileMb: String(aiStatus.maxFileMb),
        timeoutMs: String(aiStatus.requestTimeoutMs),
        confidence: String(aiStatus.confidenceThreshold),
      });
    }
  }, [aiStatus, aiForm]);

  // Build the full payload from the current form. Always include every field so
  // saving (or clearing the key) never wipes the other advanced overrides.
  const buildAiData = (form: NonNullable<typeof aiForm>, apiKey: string | null) => {
    return {
      enabled: form.enabled,
      model: form.model.trim() || null,
      systemPrompt: form.systemPrompt.trim() || null,
      maxFileMb: parseDecimal(form.maxFileMb),
      requestTimeoutMs: parseDecimal(form.timeoutMs),
      confidenceThreshold: parseDecimal(form.confidence),
      apiKey,
    };
  };

  const handleSaveAi = () => {
    if (!aiForm) return;
    const apiKeyTyped = aiForm.apiKey.trim();
    updateAi.mutate(
      {
        // Write-only key: send the typed key, or null to keep the stored one.
        data: buildAiData(aiForm, apiKeyTyped === "" ? null : apiKeyTyped),
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDocumentExtractionStatusQueryKey(),
          });
          setAiForm((p) => (p ? { ...p, apiKey: "" } : p));
          setAiTestMsg(null);
          toast({ title: "Nastavení AI uloženo" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se uložit nastavení AI", variant: "destructive" }),
      },
    );
  };

  const handleClearAiKey = () => {
    if (!aiForm) return;
    updateAi.mutate(
      // empty string explicitly clears the stored key
      { data: buildAiData(aiForm, "") },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDocumentExtractionStatusQueryKey(),
          });
          setAiForm((p) => (p ? { ...p, apiKey: "" } : p));
          toast({ title: "API klíč odebrán" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se odebrat klíč", variant: "destructive" }),
      },
    );
  };

  const handleTestAi = () => {
    setAiTestMsg(null);
    testAi.mutate(undefined, {
      onSuccess: (res) => {
        setAiTestMsg({ ok: res.ok, message: res.message });
        toast({
          title: res.ok ? "Test proběhl úspěšně" : "Test selhal",
          variant: res.ok ? undefined : "destructive",
        });
      },
      onError: (err) => {
        const message =
          err instanceof Error ? err.message : "Test konfigurace OpenAI selhal.";
        setAiTestMsg({ ok: false, message });
        toast({ title: "Test selhal", variant: "destructive" });
      },
    });
  };

  const { data: linkStatus, isLoading: linkLoading } = useGetDocumentLinking({
    query: { queryKey: getGetDocumentLinkingQueryKey() },
  });
  const updateLink = useUpdateDocumentLinking();
  const [linkForm, setLinkForm] = useState<{
    autoLinkEnabled: boolean;
    autoConfirmEnabled: boolean;
    autoLinkMinScore: string;
    autoConfirmMinScore: string;
  } | null>(null);

  useEffect(() => {
    if (linkStatus && !linkForm) {
      setLinkForm({
        autoLinkEnabled: linkStatus.autoLinkEnabled,
        autoConfirmEnabled: linkStatus.autoConfirmEnabled,
        autoLinkMinScore: String(linkStatus.autoLinkMinScore),
        autoConfirmMinScore: String(linkStatus.autoConfirmMinScore),
      });
    }
  }, [linkStatus, linkForm]);

  const handleSaveLink = () => {
    if (!linkForm) return;
    updateLink.mutate(
      {
        data: {
          autoLinkEnabled: linkForm.autoLinkEnabled,
          autoConfirmEnabled: linkForm.autoConfirmEnabled,
          autoLinkMinScore: parseDecimal(linkForm.autoLinkMinScore),
          autoConfirmMinScore: parseDecimal(linkForm.autoConfirmMinScore),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDocumentLinkingQueryKey() });
          toast({ title: "Nastavení propojení uloženo" });
        },
        onError: () =>
          toast({
            title: "Nepodařilo se uložit nastavení propojení",
            variant: "destructive",
          }),
      },
    );
  };

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
          defaultDueDays: parseDecimal(form.defaultDueDays),
          defaultPaymentMethod: trimOrNull(form.defaultPaymentMethod),
          vatPayer: form.vatPayer,
          vatModeDefault: form.vatModeDefault,
          invoiceFooterNote: trimOrNull(form.invoiceFooterNote),
          materialMarkupPercent: parseDecimal(form.materialMarkupPercent),
          numberPrefix: trimOrNull(form.numberPrefix),
          numberFormat: trimOrNull(form.numberFormat),
          numberYear: parseDecimal(form.numberYear),
          numberNextSeq: parseDecimal(form.numberNextSeq),
          reminderEnabled: form.reminderEnabled,
          reminderDays: trimOrNull(form.reminderDays),
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

  const formErrors = {
    defaultDueDays: decimalError(form.defaultDueDays, { positiveOnly: true }),
    materialMarkupPercent: decimalError(form.materialMarkupPercent),
    numberYear: decimalError(form.numberYear, { positiveOnly: true }),
    numberNextSeq: decimalError(form.numberNextSeq, { positiveOnly: true }),
  };
  const formHasErrors = Object.values(formErrors).some(Boolean);

  const aiFormErrors = aiForm
    ? {
        maxFileMb: decimalError(aiForm.maxFileMb, { positiveOnly: true }),
        timeoutMs: decimalError(aiForm.timeoutMs, { positiveOnly: true }),
        confidence: decimalError(aiForm.confidence, { max: 1 }),
      }
    : undefined;
  const aiFormHasErrors = aiFormErrors
    ? Object.values(aiFormErrors).some(Boolean)
    : false;

  const linkFormErrors = linkForm
    ? {
        autoLinkMinScore: decimalError(linkForm.autoLinkMinScore, { max: 1 }),
        autoConfirmMinScore: decimalError(linkForm.autoConfirmMinScore, { max: 1 }),
      }
    : undefined;
  const linkFormHasErrors = linkFormErrors
    ? Object.values(linkFormErrors).some(Boolean)
    : false;

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
              <DecimalInput
                value={form.defaultDueDays}
                onChange={(v) => set("defaultDueDays", v)}
                className="max-w-[160px]"
                error={formErrors.defaultDueDays}
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
            <Field label="Výchozí přirážka na materiál (%)">
              <DecimalInput
                value={form.materialMarkupPercent}
                onChange={(v) => set("materialMarkupPercent", v)}
                className="max-w-[160px]"
                error={formErrors.materialMarkupPercent}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Procentní marže přičtená k nákupní ceně materiálu při fakturaci.
                0 = bez přirážky. Lze upravit i při vytváření konkrétní faktury.
                Netýká se práce, dopravy ani pokut.
              </p>
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

        <MaterialMarkupRulesCard />

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
                <DecimalInput
                  value={form.numberYear}
                  onChange={(v) => set("numberYear", v)}
                  placeholder="automaticky"
                  error={formErrors.numberYear}
                />
              </Field>
              <Field label="Další pořadové číslo">
                <DecimalInput
                  value={form.numberNextSeq}
                  onChange={(v) => set("numberNextSeq", v)}
                  error={formErrors.numberNextSeq}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Číslo se přiřazuje až při vystavení faktury. Pořadové číslo se po
              přechodu na nový rok automaticky resetuje.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-5 w-5" /> AI vytěžování dokladů (OpenAI)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Volitelné. Při nahrání PDF nebo fotografie dokladu se hlavička a
              položky předvyplní pomocí OpenAI. Návrh se vždy uloží jen{" "}
              <strong>ke kontrole</strong> – nikdy se neschválí automaticky.
            </p>

            {aiLoading || !aiStatus || !aiForm ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label className="font-medium">Zapnout AI vytěžování</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Po zapnutí se nahrané doklady automaticky předvyplní.
                    </p>
                  </div>
                  <Switch
                    checked={aiForm.enabled}
                    onCheckedChange={(v) =>
                      setAiForm((p) => (p ? { ...p, enabled: v } : p))
                    }
                  />
                </div>

                <Field label="OpenAI API klíč">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={aiForm.apiKey}
                    onChange={(e) =>
                      setAiForm((p) => (p ? { ...p, apiKey: e.target.value } : p))
                    }
                    placeholder={
                      aiStatus.configured
                        ? "Klíč je uložen – zadejte nový pro změnu"
                        : "sk-..."
                    }
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Klíč získáte na platform.openai.com. Z bezpečnostních důvodů se
                    uložený klíč nikdy nezobrazuje.
                    {aiStatus.source === "db" && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="underline hover:text-foreground"
                          onClick={handleClearAiKey}
                        >
                          Odebrat uložený klíč
                        </button>
                      </>
                    )}
                  </p>
                </Field>

                <Field label="Model">
                  <Input
                    value={aiForm.model}
                    onChange={(e) =>
                      setAiForm((p) => (p ? { ...p, model: e.target.value } : p))
                    }
                    placeholder="gpt-4o"
                  />
                </Field>

                <Field label="Instrukce pro AI (prompt)">
                  <Textarea
                    rows={10}
                    className="font-mono text-xs"
                    value={aiForm.systemPrompt}
                    onChange={(e) =>
                      setAiForm((p) => (p ? { ...p, systemPrompt: e.target.value } : p))
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Pokročilé. Určuje, jak AI čte doklady a jaká pole vrací
                    (mj. rozpoznání typu dokladu: faktura, dodací list, účtenka,
                    dobropis). Neměňte názvy polí v JSON. Prázdné pole obnoví
                    výchozí instrukce.
                  </p>
                  {aiStatus?.defaultSystemPrompt &&
                    aiForm.systemPrompt.trim() !==
                      aiStatus.defaultSystemPrompt.trim() && (
                      <button
                        type="button"
                        className="mt-1 text-xs text-primary underline underline-offset-2"
                        onClick={() =>
                          setAiForm((p) =>
                            p
                              ? { ...p, systemPrompt: aiStatus.defaultSystemPrompt }
                              : p,
                          )
                        }
                      >
                        Načíst výchozí instrukce (s aktuálními pravidly)
                      </button>
                    )}
                </Field>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Max. velikost souboru (MB)">
                    <DecimalInput
                      value={aiForm.maxFileMb}
                      onChange={(v) =>
                        setAiForm((p) => (p ? { ...p, maxFileMb: v } : p))
                      }
                      placeholder="32"
                      error={aiFormErrors?.maxFileMb}
                    />
                  </Field>
                  <Field label="Časový limit (ms)">
                    <DecimalInput
                      value={aiForm.timeoutMs}
                      onChange={(v) =>
                        setAiForm((p) => (p ? { ...p, timeoutMs: v } : p))
                      }
                      placeholder="60000"
                      error={aiFormErrors?.timeoutMs}
                    />
                  </Field>
                  <Field label="Práh spolehlivosti (0–1)">
                    <DecimalInput
                      value={aiForm.confidence}
                      onChange={(v) =>
                        setAiForm((p) => (p ? { ...p, confidence: v } : p))
                      }
                      placeholder="0.7"
                      error={aiFormErrors?.confidence}
                    />
                  </Field>
                </div>
                <p className="-mt-2 text-xs text-muted-foreground">
                  Výsledky pod prahem spolehlivosti se označí k pečlivé kontrole.
                  Prázdná pole použijí výchozí hodnoty.
                </p>

                <div className="rounded-md border divide-y">
                  <StatusRow
                    label="Stav"
                    value={
                      aiStatus.ready
                        ? "Aktivní – doklady se vytěžují automaticky"
                        : aiStatus.configured
                          ? "Nakonfigurováno, ale vypnuto"
                          : "Není nakonfigurováno"
                    }
                    ok={aiStatus.ready}
                    neutral={aiStatus.configured && !aiStatus.ready}
                  />
                  <StatusRow
                    label="API klíč"
                    value={
                      aiStatus.configured
                        ? aiStatus.source === "env"
                          ? "Nastaven (proměnná prostředí)"
                          : "Uložen"
                        : "Chybí"
                    }
                    ok={aiStatus.configured}
                  />
                  <div className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Aktivní model</span>
                    <span className="font-mono text-xs">{aiStatus.model}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            onClick={handleSaveAi}
                            disabled={updateAi.isPending || aiFormHasErrors}
                            style={aiFormHasErrors ? { pointerEvents: "none" } : undefined}
                          >
                            {updateAi.isPending ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Save className="h-4 w-4 mr-2" />
                            )}
                            Uložit nastavení AI
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {aiFormHasErrors && (
                        <TooltipContent>Opravte chyby ve formuláři</TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                  <Button
                    variant="outline"
                    onClick={handleTestAi}
                    disabled={!aiStatus.configured || testAi.isPending}
                  >
                    {testAi.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    Otestovat konfiguraci
                  </Button>
                </div>

                {aiTestMsg && (
                  <div
                    className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                      aiTestMsg.ok
                        ? "border-green-600/30 text-green-700 dark:text-green-400"
                        : "border-destructive/40 text-destructive"
                    }`}
                  >
                    {aiTestMsg.ok ? (
                      <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    )}
                    <span>{aiTestMsg.message}</span>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Aplikace funguje i bez OpenAI – doklady se pak připraví k ruční
                  kontrole. Klíč lze místo uložení zde nastavit i proměnnou
                  prostředí <code>OPENAI_API_KEY</code>.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-5 w-5" /> Automatické propojování dokladů
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Po schválení dokladu se jeho položky mohou automaticky napárovat k
              zakázce a přenést cena materiálu. Napárování je vždy jen{" "}
              <strong>návrh ke kontrole</strong> – potvrzení necháte na sobě,
              pokud nezapnete automatické potvrzování.
            </p>

            {linkLoading || !linkStatus || !linkForm ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label className="font-medium">
                      Automaticky navrhovat propojení
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Doklad se sám napáruje k zakázce jako návrh (nikdy se
                      nepotvrdí automaticky).
                    </p>
                  </div>
                  <Switch
                    checked={linkForm.autoLinkEnabled}
                    onCheckedChange={(v) =>
                      setLinkForm((p) => (p ? { ...p, autoLinkEnabled: v } : p))
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label className="font-medium">
                      Automaticky potvrzovat silné shody
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Při velmi vysoké shodě se propojení potvrdí bez ruční
                      kontroly. Doporučujeme nechat vypnuté.
                    </p>
                  </div>
                  <Switch
                    checked={linkForm.autoConfirmEnabled}
                    onCheckedChange={(v) =>
                      setLinkForm((p) =>
                        p ? { ...p, autoConfirmEnabled: v } : p,
                      )
                    }
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Práh pro návrh (0–1)">
                    <DecimalInput
                      value={linkForm.autoLinkMinScore}
                      onChange={(v) =>
                        setLinkForm((p) =>
                          p ? { ...p, autoLinkMinScore: v } : p,
                        )
                      }
                      placeholder="0.6"
                      error={linkFormErrors?.autoLinkMinScore}
                    />
                  </Field>
                  <Field label="Práh pro potvrzení (0–1)">
                    <DecimalInput
                      value={linkForm.autoConfirmMinScore}
                      onChange={(v) =>
                        setLinkForm((p) =>
                          p ? { ...p, autoConfirmMinScore: v } : p,
                        )
                      }
                      placeholder="0.9"
                      error={linkFormErrors?.autoConfirmMinScore}
                    />
                  </Field>
                </div>
                <p className="-mt-2 text-xs text-muted-foreground">
                  Vyšší hodnota = přísnější párování. Prázdné pole použije
                  výchozí hodnotu.
                </p>

                <div className="flex justify-end">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            onClick={handleSaveLink}
                            disabled={updateLink.isPending || linkFormHasErrors}
                            style={linkFormHasErrors ? { pointerEvents: "none" } : undefined}
                          >
                            {updateLink.isPending ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Save className="h-4 w-4 mr-2" />
                            )}
                            Uložit nastavení propojení
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {linkFormHasErrors && (
                        <TooltipContent>Opravte chyby ve formuláři</TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-5 w-5" /> Automatické upomínky
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="font-medium">Posílat automatické upomínky</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Neuhrazené faktury po splatnosti automaticky upozorní odběratele e-mailem.
                </p>
              </div>
              <Switch
                checked={form.reminderEnabled}
                onCheckedChange={(v) => set("reminderEnabled", v)}
              />
            </div>
            <Field label="Dny po splatnosti">
              <Input
                value={form.reminderDays}
                onChange={(e) => set("reminderDays", e.target.value)}
                placeholder="3,14,30"
                disabled={!form.reminderEnabled}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Čísla oddělená čárkou. Upomínka se odešle nejvýše jednou pro každý
              práh a jen pokud je nastaven e-mail odběratele a SMTP server.
            </p>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    onClick={handleSave}
                    disabled={update.isPending || formHasErrors}
                    className="h-11 px-6"
                    style={formHasErrors ? { pointerEvents: "none" } : undefined}
                  >
                    <Save className="h-4 w-4 mr-2" /> Uložit nastavení
                  </Button>
                </span>
              </TooltipTrigger>
              {formHasErrors && (
                <TooltipContent>Opravte chyby ve formuláři</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}

function MaterialMarkupRulesCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListMaterialMarkupRules({
    query: { queryKey: getListMaterialMarkupRulesQueryKey() },
  });
  const upsert = useUpsertMaterialMarkupRule();
  const remove = useDeleteMaterialMarkupRule();

  const [newCategory, setNewCategory] = useState("");
  const [newMarkup, setNewMarkup] = useState("");

  const rules = data?.rules ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListMaterialMarkupRulesQueryKey() });

  const saveRule = (category: string, markupRaw: string) => {
    const cat = category.trim();
    if (!cat) {
      toast({ title: "Zadejte kategorii", variant: "destructive" });
      return;
    }
    const markup = parseDecimal(markupRaw);
    if (markup === null || markup < 0) {
      toast({ title: "Přirážka musí být nezáporné číslo", variant: "destructive" });
      return;
    }
    upsert.mutate(
      { data: { category: cat, markupPercent: markup } },
      {
        onSuccess: () => {
          invalidate();
          setNewCategory("");
          setNewMarkup("");
          toast({ title: "Přirážka kategorie uložena" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se uložit přirážku", variant: "destructive" }),
      },
    );
  };

  const deleteRule = (id: number) => {
    remove.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Přirážka kategorie smazána" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se smazat přirážku", variant: "destructive" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Percent className="h-5 w-5" /> Přirážky podle kategorie materiálu
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Nastavte odlišnou přirážku pro jednotlivé kategorie materiálu (podle
          kategorie skladové položky). Materiál se ke kategorii přiřadí podle názvu.
          Když kategorie pravidlo nemá, použije se výchozí přirážka výše. Při
          vytváření faktury lze přirážku upravit i u jednotlivých položek.
        </p>

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-2">
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                Zatím žádná pravidla – platí výchozí přirážka.
              </p>
            ) : (
              <div className="divide-y rounded-md border">
                {rules.map((r) => (
                  <MarkupRuleRow
                    key={r.id}
                    category={r.category}
                    markupPercent={r.markupPercent}
                    onSave={(markup) => saveRule(r.category, markup)}
                    onDelete={() => deleteRule(r.id)}
                    saving={upsert.isPending}
                    deleting={remove.isPending}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2 pt-2">
              <div className="flex-1 min-w-[160px]">
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Kategorie
                </Label>
                <Input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="např. Kabeláž"
                />
              </div>
              <div className="w-[120px]">
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Přirážka (%)
                </Label>
                <DecimalInput
                  value={newMarkup}
                  onChange={(v) => setNewMarkup(v)}
                  placeholder="0"
                  error={decimalError(newMarkup)}
                />
              </div>
              <Button
                type="button"
                onClick={() => saveRule(newCategory, newMarkup)}
                disabled={upsert.isPending || !!decimalError(newMarkup)}
              >
                <Plus className="h-4 w-4 mr-1" /> Přidat
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MarkupRuleRow({
  category,
  markupPercent,
  onSave,
  onDelete,
  saving,
  deleting,
}: {
  category: string;
  markupPercent: number;
  onSave: (markupRaw: string) => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
}) {
  const [value, setValue] = useState(String(markupPercent));
  useEffect(() => {
    setValue(String(markupPercent));
  }, [markupPercent]);
  const dirty = value.trim() !== String(markupPercent);
  const valueError = decimalError(value);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="flex-1 text-sm font-medium truncate">{category}</span>
      <DecimalInput
        value={value}
        onChange={(v) => setValue(v)}
        className="w-[110px]"
        error={valueError}
      />
      <span className="text-sm text-muted-foreground">%</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onSave(value)}
        disabled={!dirty || saving || !!valueError}
      >
        <Save className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onDelete}
        disabled={deleting}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
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

function StatusRow({
  label,
  value,
  ok,
  neutral,
}: {
  label: string;
  value: string;
  ok: boolean;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-medium ${
          neutral
            ? "text-amber-600 dark:text-amber-400"
            : ok
              ? "text-green-700 dark:text-green-400"
              : "text-muted-foreground"
        }`}
      >
        {ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : neutral ? null : (
          <XCircle className="h-4 w-4" />
        )}
        {value}
      </span>
    </div>
  );
}
