import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListRecurringTemplates,
  useCreateRecurringTemplate,
  useListCustomers,
  getListRecurringTemplatesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  ChevronRight,
  CalendarClock,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { fmtDate } from "@/lib/billing-format";

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

function intervalBadgeClass(interval: string) {
  if (interval === "monthly") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  if (interval === "quarterly") return "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

export default function BillingRecurringTemplates() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, isError } = useListRecurringTemplates({
    query: { queryKey: getListRecurringTemplatesQueryKey() },
  });

  const createTemplate = useCreateRecurringTemplate();

  const templates = data ?? [];

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

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Šablony paušálních faktur</h1>
        <Button onClick={() => setShowCreate(true)} className="h-10">
          <Plus className="h-4 w-4 mr-2" /> Nová šablona
        </Button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Šablony automaticky generují koncepty faktur v nastavený den. Vygenerované koncepty
        musíte ručně zkontrolovat a vystavit.
      </p>

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <AlertCircle className="h-10 w-10 opacity-30" />
            <p className="font-medium">Nepodařilo se načíst šablony</p>
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <CalendarClock className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p className="font-medium">Žádné šablony paušálních faktur</p>
            <p className="text-sm mt-1">
              Vytvořte šablonu pro automatické generování faktur (měsíční paušály, servisní smlouvy…).
            </p>
          </div>
        ) : (
          templates.map((t) => (
            <Card
              key={t.id}
              className={`overflow-hidden ${!t.isActive ? "opacity-60" : ""}`}
            >
              <CardContent className="p-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setLocation(`/billing/recurring-templates/${t.id}`)}
                  className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-base">{t.name}</p>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${intervalBadgeClass(t.interval)}`}>
                      {INTERVAL_LABELS[t.interval] ?? t.interval}
                    </span>
                    {!t.isActive && (
                      <Badge variant="secondary">Neaktivní</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate mt-0.5">
                    {t.customerName ?? "—"}
                    {" · "}
                    Příští generace: {t.nextGenerationDate ? fmtDate(t.nextGenerationDate) : "—"}
                  </p>
                </button>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <CreateTemplateDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={async (input) => {
          try {
            await createTemplate.mutateAsync({ data: input });
            invalidateData(queryClient, "billingRecurringTemplates");
            toast({ title: "Šablona vytvořena" });
            setShowCreate(false);
          } catch {
            toast({ title: "Vytvoření šablony se nezdařilo", variant: "destructive" });
          }
        }}
        isPending={createTemplate.isPending}
      />
    </div>
  );
}

interface CreateInput {
  customerId: number;
  name: string;
  items: Array<{
    description: string;
    quantity: number;
    unit: string | null;
    unitPriceWithoutVat: number;
    vatRate: number | null;
    vatMode: string;
    discountPercent: number | null;
    sortOrder: number;
  }>;
  interval: "monthly" | "quarterly" | "yearly";
  dayOfMonth: number;
  nextGenerationDate: string;
  isActive: boolean;
  notes: string | null;
  vatModeDefault: string;
}

function CreateTemplateDialog({
  open,
  onClose,
  onCreate,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateInput) => Promise<void>;
  isPending: boolean;
}) {
  const { data: customers } = useListCustomers();
  const [customerId, setCustomerId] = useState<string>("");
  const [name, setName] = useState("");
  const [interval, setInterval] = useState<"monthly" | "quarterly" | "yearly">("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [nextGenerationDate, setNextGenerationDate] = useState(
    () => new Date().toISOString().split("T")[0]!,
  );
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
  >([{ description: "", quantity: "1", unit: "ks", unitPriceWithoutVat: "0", vatRate: "21", vatMode: "standard" }]);

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

  const handleSubmit = async () => {
    if (!customerId || !name.trim() || lines.length === 0) return;
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
    await onCreate({
      customerId: Number(customerId),
      name: name.trim(),
      items,
      interval,
      dayOfMonth: Math.max(1, Math.min(28, Number(dayOfMonth) || 1)),
      nextGenerationDate,
      isActive,
      notes: notes.trim() || null,
      vatModeDefault,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nová šablona paušální faktury</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Zákazník *</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Vyberte zákazníka" />
                </SelectTrigger>
                <SelectContent>
                  {(customers ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Název šablony *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="např. Měsíční servis"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Interval</Label>
              <Select value={interval} onValueChange={(v) => setInterval(v as typeof interval)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Měsíčně</SelectItem>
                  <SelectItem value="quarterly">Čtvrtletně</SelectItem>
                  <SelectItem value="yearly">Ročně</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Den v měsíci</Label>
              <Input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>První generace</Label>
              <Input
                type="date"
                value={nextGenerationDate}
                onChange={(e) => setNextGenerationDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Výchozí DPH</Label>
              <Select value={vatModeDefault} onValueChange={setVatModeDefault}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(VAT_MODE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

          <div className="space-y-1.5">
            <Label>Poznámka (zobrazí se na faktuře)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Nepovinná poznámka..."
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Položky faktur *</Label>
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-4 w-4 mr-1" /> Přidat řádek
              </Button>
            </div>
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
                    <Input
                      type="number"
                      step="0.01"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, "quantity", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Jednotka</Label>
                    <Input
                      value={line.unit}
                      onChange={(e) => updateLine(idx, "unit", e.target.value)}
                      placeholder="ks"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Cena bez DPH (Kč)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={line.unitPriceWithoutVat}
                      onChange={(e) => updateLine(idx, "unitPriceWithoutVat", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Sazba DPH (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={line.vatRate}
                      onChange={(e) => updateLine(idx, "vatRate", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Zrušit
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !customerId || !name.trim() || lines.some((l) => !l.description.trim())}
          >
            {isPending ? "Ukládám…" : "Vytvořit šablonu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
