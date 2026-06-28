import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetRecurringTemplate,
  useUpdateRecurringTemplate,
  useDeleteRecurringTemplate,
  useListCustomers,
  useGenerateNowRecurringTemplate,
  getGetRecurringTemplateQueryKey,
  getListRecurringTemplatesQueryKey,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  ChevronRight,
  AlertCircle,
  CalendarClock,
  FileText,
  Zap,
  XCircle,
} from "lucide-react";
import { fmtDate, fmtKc } from "@/lib/billing-format";
import { InvoiceStatusBadge } from "@/components/badges";

const INTERVAL_LABELS: Record<string, string> = {
  monthly: "Měsíčně",
  quarterly: "Čtvrtletně",
  yearly: "Ročně",
};

const VAT_MODE_LABELS: Record<string, string> = {
  standard: "Standardní DPH",
  reverse_charge: "Přenesená daňová povinnost",
  zero: "Nulové DPH",
  non_vat: "Bez DPH",
};

export default function BillingRecurringTemplateDetail() {
  const [, params] = useRoute("/billing/recurring-templates/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showDelete, setShowDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  const { data: template, isLoading, isError } = useGetRecurringTemplate(
    id,
    { query: { queryKey: getGetRecurringTemplateQueryKey(id) } },
  );

  const updateTemplate = useUpdateRecurringTemplate();
  const deleteTemplate = useDeleteRecurringTemplate();
  const generateNow = useGenerateNowRecurringTemplate();

  const [name, setName] = useState("");
  const [interval, setIntervalVal] = useState<"monthly" | "quarterly" | "yearly">("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [nextGenerationDate, setNextGenerationDate] = useState("");
  const [vatModeDefault, setVatModeDefault] = useState("standard");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [lines, setLines] = useState<
    Array<{
      description: string;
      quantity: string;
      unit: string;
      unitPriceWithoutVat: string;
      vatRate: string;
      vatMode: string;
    }>
  >([]);

  const startEditing = () => {
    if (!template) return;
    setName(template.name);
    setIntervalVal(template.interval as "monthly" | "quarterly" | "yearly");
    setDayOfMonth(String(template.dayOfMonth));
    setNextGenerationDate(template.nextGenerationDate);
    setVatModeDefault(template.vatModeDefault);
    setNotes(template.notes ?? "");
    setIsActive(template.isActive);
    setLines(
      (template.items as Array<{
        description: string;
        quantity: number;
        unit: string | null;
        unitPriceWithoutVat: number;
        vatRate: number | null;
        vatMode: string;
      }>).map((item) => ({
        description: item.description,
        quantity: String(item.quantity),
        unit: item.unit ?? "",
        unitPriceWithoutVat: String(item.unitPriceWithoutVat),
        vatRate: String(item.vatRate ?? 21),
        vatMode: item.vatMode,
      })),
    );
    setEditing(true);
  };

  const handleSave = async () => {
    if (!template) return;
    const items = lines.map((l, idx) => ({
      description: l.description,
      quantity: Number(l.quantity) || 1,
      unit: l.unit.trim() || null,
      unitPriceWithoutVat: Number(l.unitPriceWithoutVat) || 0,
      vatRate: l.vatMode === "standard" || l.vatMode === "zero" ? Number(l.vatRate) || 0 : null,
      vatMode: l.vatMode,
      discountPercent: null,
      sortOrder: idx,
    }));
    try {
      await updateTemplate.mutateAsync({
        id: template.id,
        data: {
          name: name.trim(),
          items,
          interval,
          dayOfMonth: Math.max(1, Math.min(28, Number(dayOfMonth) || 1)),
          nextGenerationDate,
          isActive,
          notes: notes.trim() || null,
          vatModeDefault,
        },
      });
      invalidateData(queryClient, "billingRecurringTemplates");
      await queryClient.invalidateQueries({ queryKey: getGetRecurringTemplateQueryKey(id) });
      toast({ title: "Šablona uložena" });
      setEditing(false);
    } catch {
      toast({ title: "Uložení se nezdařilo", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteTemplate.mutateAsync({ id });
      invalidateData(queryClient, "billingRecurringTemplates");
      toast({ title: "Šablona smazána" });
      setLocation("/billing/recurring-templates");
    } catch {
      toast({ title: "Smazání se nezdařilo", variant: "destructive" });
    }
  };

  const handleGenerateNow = async () => {
    try {
      await generateNow.mutateAsync({ id });
      await queryClient.invalidateQueries({ queryKey: getGetRecurringTemplateQueryKey(id) });
      invalidateData(queryClient, "billingRecurringTemplates", "billingInvoices");
      toast({ title: "Koncept faktury vytvořen" });
    } catch (err: unknown) {
      const msg =
        err instanceof Error && "data" in err && typeof (err as { data?: { error?: string } }).data?.error === "string"
          ? (err as { data: { error: string } }).data.error
          : "Generování se nezdařilo";
      toast({ title: msg, variant: "destructive" });
    }
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { description: "", quantity: "1", unit: "ks", unitPriceWithoutVat: "0", vatRate: "21", vatMode: vatModeDefault },
    ]);
  };

  const updateLine = (idx: number, field: string, value: string) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
        <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" onClick={() => setLocation("/billing/recurring-templates")}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Šablony
        </Button>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <AlertCircle className="h-10 w-10 opacity-30" />
          <p className="font-medium">Šablona nenalezena</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing/recurring-templates")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Šablony
      </Button>

      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{template.name}</h1>
            {!template.isActive && <Badge variant="secondary">Neaktivní</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {template.customerName ?? "—"} · {INTERVAL_LABELS[template.interval] ?? template.interval}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && (
            <>
              <Button
                variant="outline"
                onClick={handleGenerateNow}
                disabled={generateNow.isPending}
              >
                <Zap className="h-4 w-4 mr-2" />
                {generateNow.isPending ? "Generuji…" : "Generovat nyní"}
              </Button>
              <Button variant="outline" onClick={startEditing}>
                Upravit
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => setShowDelete(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
          {editing && (
            <>
              <Button variant="outline" onClick={() => setEditing(false)} disabled={updateTemplate.isPending}>
                Zrušit
              </Button>
              <Button onClick={handleSave} disabled={updateTemplate.isPending || !name.trim() || lines.length === 0}>
                <Save className="h-4 w-4 mr-2" />
                {updateTemplate.isPending ? "Ukládám…" : "Uložit"}
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Základní nastavení</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Název šablony *</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Aktivní</Label>
                  <div className="flex items-center gap-2 pt-2">
                    <Switch checked={isActive} onCheckedChange={setIsActive} />
                    <span className="text-sm text-muted-foreground">
                      {isActive ? "Šablona je aktivní" : "Šablona je pozastavena"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Interval</Label>
                  <Select value={interval} onValueChange={(v) => setIntervalVal(v as typeof interval)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Měsíčně</SelectItem>
                      <SelectItem value="quarterly">Čtvrtletně</SelectItem>
                      <SelectItem value="yearly">Ročně</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Den v měsíci</Label>
                  <Input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Příští generace</Label>
                  <Input type="date" value={nextGenerationDate} onChange={(e) => setNextGenerationDate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Výchozí DPH</Label>
                  <Select value={vatModeDefault} onValueChange={setVatModeDefault}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(VAT_MODE_LABELS).map(([v, l]) => (
                        <SelectItem key={v} value={v}>{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Poznámka</Label>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Položky</CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={addLine}>
                  <Plus className="h-4 w-4 mr-1" /> Přidat řádek
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {lines.map((line, idx) => (
                <div key={idx} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      className="flex-1"
                      placeholder="Popis *"
                      value={line.description}
                      onChange={(e) => updateLine(idx, "description", e.target.value)}
                    />
                    {lines.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive shrink-0"
                        onClick={() => removeLine(idx)}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Množství</Label>
                      <Input type="number" step="0.01" value={line.quantity} onChange={(e) => updateLine(idx, "quantity", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Jednotka</Label>
                      <Input value={line.unit} onChange={(e) => updateLine(idx, "unit", e.target.value)} placeholder="ks" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Cena bez DPH (Kč)</Label>
                      <Input type="number" step="0.01" value={line.unitPriceWithoutVat} onChange={(e) => updateLine(idx, "unitPriceWithoutVat", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Sazba DPH (%)</Label>
                      <Input type="number" step="1" value={line.vatRate} onChange={(e) => updateLine(idx, "vatRate", e.target.value)} />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nastavení šablony</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Zákazník</p>
                  <p className="font-medium">{template.customerName ?? "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Interval</p>
                  <p className="font-medium">{INTERVAL_LABELS[template.interval] ?? template.interval}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Den v měsíci</p>
                  <p className="font-medium">{template.dayOfMonth}.</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Příští generace</p>
                  <p className="font-medium">{template.nextGenerationDate ? fmtDate(template.nextGenerationDate) : "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Naposledy generováno</p>
                  <p className="font-medium">{template.lastGeneratedAt ? fmtDate(String(template.lastGeneratedAt).split("T")[0] ?? "") : "Dosud ne"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-0.5">Výchozí DPH</p>
                  <p className="font-medium">{VAT_MODE_LABELS[template.vatModeDefault] ?? template.vatModeDefault}</p>
                </div>
              </div>
              {template.notes && (
                <div className="mt-4 text-sm">
                  <p className="text-muted-foreground text-xs mb-0.5">Poznámka</p>
                  <p className="whitespace-pre-wrap">{template.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Položky faktur</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {(template.items as Array<{ description: string; quantity: number; unit: string | null; unitPriceWithoutVat: number; vatRate: number | null; vatMode: string }>).map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between text-sm py-2 border-b last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{item.description}</p>
                      <p className="text-muted-foreground text-xs">
                        {item.quantity} {item.unit ?? "ks"} × {fmtKc(item.unitPriceWithoutVat)} bez DPH
                        {item.vatRate != null ? ` · DPH ${item.vatRate}%` : ""}
                      </p>
                    </div>
                    <p className="font-semibold shrink-0 ml-4">{fmtKc(item.quantity * item.unitPriceWithoutVat)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {template.generations && template.generations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Historie vygenerovaných faktur</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {template.generations.map((gen) => {
                    if (gen.invoiceId == null) {
                      return (
                        <div key={gen.id} className="flex items-start justify-between py-2 border-b last:border-0">
                          <div className="flex items-start gap-3">
                            <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-medium text-destructive">
                                Generování selhalo <span className="text-muted-foreground font-normal">· období {gen.period}</span>
                              </p>
                              {gen.errorMessage && (
                                <p className="text-xs text-muted-foreground mt-0.5">{gen.errorMessage}</p>
                              )}
                              <p className="text-xs text-muted-foreground">{fmtDate(String(gen.createdAt).split("T")[0] ?? "")}</p>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={gen.id}
                        type="button"
                        className="w-full text-left"
                        onClick={() => setLocation(`/billing/invoices/${gen.invoiceId}`)}
                      >
                        <div className="flex items-center justify-between py-2 border-b last:border-0 hover:opacity-80 transition-opacity">
                          <div className="flex items-center gap-3">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div>
                              <p className="text-sm font-medium">
                                {gen.invoiceNumber ?? "Koncept"} <span className="text-muted-foreground font-normal">· období {gen.period}</span>
                              </p>
                              <p className="text-xs text-muted-foreground">{fmtDate(String(gen.createdAt).split("T")[0] ?? "")}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {gen.invoiceStatus && (
                              <InvoiceStatusBadge status={gen.invoiceStatus} />
                            )}
                            {gen.totalWithVat != null && (
                              <span className="text-sm font-semibold">{fmtKc(Number(gen.totalWithVat))}</span>
                            )}
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Smazat šablonu?</AlertDialogTitle>
            <AlertDialogDescription>
              Šablona <strong>{template.name}</strong> bude trvale smazána. Dříve vygenerované faktury
              zůstanou zachovány, ale ztratí propojení se šablonou.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Smazat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
