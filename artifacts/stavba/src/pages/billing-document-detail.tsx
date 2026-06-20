import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCostDocument,
  getGetCostDocumentQueryKey,
  useUpdateCostDocument,
  useDeleteCostDocument,
  useApproveCostDocument,
  useSetCostDocumentStatus,
  useRequeueCostDocumentExtraction,
  useUpdateCostDocumentLine,
  useSplitCostDocumentLine,
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
  getGetBillingSummaryQueryKey,
  type CostDocument,
  type CostDocumentLine,
  type CostDocumentUpdateInput,
  type CostDocumentLineUpdateInput,
  type CostDocumentLineSplitInput,
  type Customer,
  type Job,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { AttachmentViewer } from "@/components/attachment-viewer";
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  COST_DOC_TYPE_LABELS,
  COST_DOC_LINE_TYPE_LABELS,
  COST_DOC_ALLOCATION_LABELS,
  CostDocStatusBadge,
} from "@/lib/cost-document-format";
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CheckCircle2,
  EyeOff,
  FileText,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
} from "lucide-react";

const DOC_TYPE_OPTIONS = ["receipt", "delivery_note", "invoice", "credit_note"];
const LINE_TYPE_OPTIONS = ["material", "work", "transport", "other"];
const ALLOCATION_OPTIONS = ["rebill", "internal", "stock", "not_rebilled"];
const NONE = "__none__";

function attachmentUrl(objectPath: string | null | undefined): string | undefined {
  if (!objectPath) return undefined;
  if (objectPath.startsWith("data:")) return objectPath;
  return `/api/storage${objectPath}`;
}

function dateValue(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function BillingDocumentDetail() {
  const [, params] = useRoute("/billing/documents/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useGetCostDocument(id, {
    query: { queryKey: getGetCostDocumentQueryKey(id), enabled: !!id },
  });
  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const updateDoc = useUpdateCostDocument();
  const deleteDoc = useDeleteCostDocument();
  const approveDoc = useApproveCostDocument();
  const setStatus = useSetCostDocumentStatus();
  const requeue = useRequeueCostDocumentExtraction();

  const [viewerOpen, setViewerOpen] = useState(false);
  const [splitLine, setSplitLine] = useState<CostDocumentLine | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetCostDocumentQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: ["/api/billing/documents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/billing/approved-lines"] });
    queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
  };

  const doc = data?.document;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Doklad nenalezen.
      </div>
    );
  }

  const handleStatus = (
    status: "needs_review" | "reviewed" | "ignored" | "duplicate",
    successTitle: string,
  ) => {
    setStatus.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: successTitle });
        },
        onError: () =>
          toast({ title: "Změna stavu selhala", variant: "destructive" }),
      },
    );
  };

  const handleApprove = () => {
    approveDoc.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Doklad schválen" });
        },
        onError: (err) =>
          toast({
            title: "Schválení selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  const handleRequeue = () => {
    requeue.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Doklad zařazen ke zpracování" });
        },
        onError: () =>
          toast({ title: "Zpracování se nezdařilo", variant: "destructive" }),
      },
    );
  };

  const handleDelete = () => {
    if (!confirm("Opravdu smazat tento doklad? Tuto akci nelze vrátit.")) return;
    deleteDoc.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Doklad smazán" });
          setLocation("/billing/documents");
        },
        onError: (err) =>
          toast({
            title: "Smazání selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  const fileHref = attachmentUrl(doc.objectPath);
  const warnings = (doc.warnings ?? "")
    .split("\n")
    .map((w) => w.trim())
    .filter(Boolean);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing/documents")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Přijaté doklady
      </Button>

      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2.5 rounded-full text-emerald-600 dark:text-emerald-300 shrink-0">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {doc.supplierName || doc.fileName || "Doklad"}
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <CostDocStatusBadge status={doc.status} />
              <span className="text-sm text-muted-foreground">
                {COST_DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {fileHref && (
            <Button variant="outline" size="sm" onClick={() => setViewerOpen(true)}>
              <FileText className="h-4 w-4 mr-1" /> Zobrazit soubor
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRequeue}
            disabled={requeue.isPending}
          >
            <RefreshCw className="h-4 w-4 mr-1" /> Zpracovat
          </Button>
        </div>
      </div>

      {/* Status actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        {doc.status !== "approved" && (
          <Button size="sm" onClick={handleApprove} disabled={approveDoc.isPending}>
            <CheckCircle2 className="h-4 w-4 mr-1" /> Schválit doklad
          </Button>
        )}
        {doc.status !== "reviewed" && doc.status !== "approved" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleStatus("reviewed", "Označeno jako zkontrolováno")}
            disabled={setStatus.isPending}
          >
            <Check className="h-4 w-4 mr-1" /> Zkontrolováno
          </Button>
        )}
        {doc.status !== "ignored" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleStatus("ignored", "Doklad ignorován")}
            disabled={setStatus.isPending}
          >
            <EyeOff className="h-4 w-4 mr-1" /> Ignorovat
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={handleDelete}
          disabled={deleteDoc.isPending}
        >
          <Trash2 className="h-4 w-4 mr-1" /> Smazat
        </Button>
      </div>

      {warnings.length > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50 dark:bg-amber-900/20">
          <CardContent className="p-4 flex gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <ul className="list-disc pl-4 space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data.duplicates.length > 0 && (
        <Card className="mb-4 border-red-300 bg-red-50 dark:bg-red-900/20">
          <CardContent className="p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-red-800 dark:text-red-200 mb-2">
              <AlertTriangle className="h-4 w-4" /> Možné duplicity
            </div>
            <div className="space-y-1">
              {data.duplicates.map((d) => (
                <button
                  key={d.id}
                  className="block text-left hover:underline"
                  onClick={() => setLocation(`/billing/documents/${d.id}`)}
                >
                  {d.supplierName || "Neznámý dodavatel"}
                  {d.documentNumber ? ` · ${d.documentNumber}` : ""} —{" "}
                  <span className="text-muted-foreground">{d.reason}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <DocumentHeaderForm
        key={`${doc.id}-${doc.updatedAt}`}
        document={doc}
        customers={customers ?? []}
        jobs={jobs ?? []}
        onSave={(input) =>
          updateDoc.mutate(
            { id, data: input },
            {
              onSuccess: () => {
                invalidate();
                toast({ title: "Doklad uložen" });
              },
              onError: () =>
                toast({ title: "Uložení selhalo", variant: "destructive" }),
            },
          )
        }
        saving={updateDoc.isPending}
      />

      <h2 className="text-lg font-semibold mt-6 mb-3">Položky dokladu</h2>
      {data.lines.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
          <p className="text-sm">Doklad zatím nemá žádné položky.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.lines.map((line) => (
            <LineCard
              key={line.id}
              documentId={id}
              line={line}
              jobs={jobs ?? []}
              onChanged={invalidate}
              onSplit={() => setSplitLine(line)}
            />
          ))}
        </div>
      )}

      {fileHref && viewerOpen && (
        <AttachmentViewer
          url={fileHref}
          fileName={doc.fileName}
          onClose={() => setViewerOpen(false)}
        />
      )}

      {splitLine && (
        <SplitDialog
          documentId={id}
          line={splitLine}
          jobs={jobs ?? []}
          onClose={() => setSplitLine(null)}
          onDone={() => {
            setSplitLine(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header edit form
// ---------------------------------------------------------------------------

function DocumentHeaderForm({
  document,
  customers,
  jobs,
  onSave,
  saving,
}: {
  document: CostDocument;
  customers: Customer[];
  jobs: Job[];
  onSave: (input: CostDocumentUpdateInput) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    docType: document.docType as string,
    supplierName: document.supplierName ?? "",
    supplierIc: document.supplierIc ?? "",
    supplierDic: document.supplierDic ?? "",
    documentNumber: document.documentNumber ?? "",
    variableSymbol: document.variableSymbol ?? "",
    issueDate: dateValue(document.issueDate),
    taxableSupplyDate: dateValue(document.taxableSupplyDate),
    dueDate: dateValue(document.dueDate),
    subtotalWithoutVat:
      document.subtotalWithoutVat != null ? String(document.subtotalWithoutVat) : "",
    totalVat: document.totalVat != null ? String(document.totalVat) : "",
    totalWithVat: document.totalWithVat != null ? String(document.totalWithVat) : "",
    customerId: document.customerId != null ? String(document.customerId) : NONE,
    jobId: document.jobId != null ? String(document.jobId) : NONE,
    notes: document.notes ?? "",
  });

  const set = (k: keyof typeof form, v: string) =>
    setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const input: CostDocumentUpdateInput = {
      docType: form.docType as CostDocumentUpdateInput["docType"],
      supplierName: form.supplierName || null,
      supplierIc: form.supplierIc || null,
      supplierDic: form.supplierDic || null,
      documentNumber: form.documentNumber || null,
      variableSymbol: form.variableSymbol || null,
      issueDate: form.issueDate || null,
      taxableSupplyDate: form.taxableSupplyDate || null,
      dueDate: form.dueDate || null,
      subtotalWithoutVat: numOrNull(form.subtotalWithoutVat),
      totalVat: numOrNull(form.totalVat),
      totalWithVat: numOrNull(form.totalWithVat),
      customerId: form.customerId === NONE ? null : Number(form.customerId),
      jobId: form.jobId === NONE ? null : Number(form.jobId),
      notes: form.notes || null,
    };
    onSave(input);
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Typ dokladu">
            <Select value={form.docType} onValueChange={(v) => set("docType", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {COST_DOC_TYPE_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Číslo dokladu">
            <Input
              value={form.documentNumber}
              onChange={(e) => set("documentNumber", e.target.value)}
            />
          </Field>
          <Field label="Dodavatel">
            <Input
              value={form.supplierName}
              onChange={(e) => set("supplierName", e.target.value)}
            />
          </Field>
          <Field label="Variabilní symbol">
            <Input
              value={form.variableSymbol}
              onChange={(e) => set("variableSymbol", e.target.value)}
            />
          </Field>
          <Field label="IČ dodavatele">
            <Input
              value={form.supplierIc}
              onChange={(e) => set("supplierIc", e.target.value)}
            />
          </Field>
          <Field label="DIČ dodavatele">
            <Input
              value={form.supplierDic}
              onChange={(e) => set("supplierDic", e.target.value)}
            />
          </Field>
          <Field label="Datum vystavení">
            <Input
              type="date"
              value={form.issueDate}
              onChange={(e) => set("issueDate", e.target.value)}
            />
          </Field>
          <Field label="DUZP">
            <Input
              type="date"
              value={form.taxableSupplyDate}
              onChange={(e) => set("taxableSupplyDate", e.target.value)}
            />
          </Field>
          <Field label="Datum splatnosti">
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Základ bez DPH">
            <Input
              type="number"
              inputMode="decimal"
              value={form.subtotalWithoutVat}
              onChange={(e) => set("subtotalWithoutVat", e.target.value)}
            />
          </Field>
          <Field label="DPH">
            <Input
              type="number"
              inputMode="decimal"
              value={form.totalVat}
              onChange={(e) => set("totalVat", e.target.value)}
            />
          </Field>
          <Field label="Celkem s DPH">
            <Input
              type="number"
              inputMode="decimal"
              value={form.totalWithVat}
              onChange={(e) => set("totalWithVat", e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Zákazník (k přefakturaci)">
            <Select
              value={form.customerId}
              onValueChange={(v) => set("customerId", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Žádný" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Žádný</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.companyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Zakázka">
            <Select value={form.jobId} onValueChange={(v) => set("jobId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Žádná" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Žádná</SelectItem>
                {jobs.map((j) => (
                  <SelectItem key={j.id} value={String(j.id)}>
                    {j.title} ({fmtDate(j.date)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="Poznámka">
          <Textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
          />
        </Field>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" /> Uložit doklad
          </Button>
        </div>
      </CardContent>
    </Card>
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
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line card (edit + match)
// ---------------------------------------------------------------------------

function LineCard({
  documentId,
  line,
  jobs,
  onChanged,
  onSplit,
}: {
  documentId: number;
  line: CostDocumentLine;
  jobs: Job[];
  onChanged: () => void;
  onSplit: () => void;
}) {
  const { toast } = useToast();
  const updateLine = useUpdateCostDocumentLine();

  const [form, setForm] = useState({
    description: line.description,
    quantity: String(line.quantity),
    unit: line.unit ?? "",
    unitPriceWithoutVat: String(line.unitPriceWithoutVat),
    lineType: line.lineType as string,
    allocationType: line.allocationType as string,
    jobId: line.jobId != null ? String(line.jobId) : NONE,
    matchConfirmed: line.matchConfirmed,
    approved: line.approved,
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const save = (overrides?: Partial<typeof form>) => {
    const f = { ...form, ...overrides };
    const data: CostDocumentLineUpdateInput = {
      lineType: f.lineType as CostDocumentLineUpdateInput["lineType"],
      description: f.description,
      quantity: numOrNull(f.quantity),
      unit: f.unit || null,
      unitPriceWithoutVat: numOrNull(f.unitPriceWithoutVat),
      jobId: f.jobId === NONE ? null : Number(f.jobId),
      allocationType:
        f.allocationType as CostDocumentLineUpdateInput["allocationType"],
      matchConfirmed: f.matchConfirmed,
      approved: f.approved,
    };
    updateLine.mutate(
      { id: documentId, lineId: line.id, data },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Položka uložena" });
        },
        onError: (err) =>
          toast({
            title: "Uložení položky selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  const confidencePct =
    line.matchConfidence != null ? Math.round(line.matchConfidence * 100) : null;

  return (
    <Card className={line.approved ? "border-emerald-400/50" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
          <div className="sm:col-span-3 space-y-1">
            <Label className="text-xs text-muted-foreground">Popis</Label>
            <Input
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Množství</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={form.quantity}
              onChange={(e) => set("quantity", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">MJ</Label>
            <Input value={form.unit} onChange={(e) => set("unit", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cena/MJ bez DPH</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={form.unitPriceWithoutVat}
              onChange={(e) => set("unitPriceWithoutVat", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Typ položky</Label>
            <Select value={form.lineType} onValueChange={(v) => set("lineType", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINE_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {COST_DOC_LINE_TYPE_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Režim nákladu</Label>
            <Select
              value={form.allocationType}
              onValueChange={(v) => set("allocationType", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALLOCATION_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {COST_DOC_ALLOCATION_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Zakázka
              {confidencePct != null && !line.matchConfirmed && (
                <span className="ml-1 text-primary">
                  (návrh {confidencePct} %)
                </span>
              )}
            </Label>
            <Select value={form.jobId} onValueChange={(v) => set("jobId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Žádná" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Žádná</SelectItem>
                {jobs.map((j) => (
                  <SelectItem key={j.id} value={String(j.id)}>
                    {j.title} ({fmtDate(j.date)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={form.matchConfirmed}
                onCheckedChange={(v) => set("matchConfirmed", v === true)}
              />
              Potvrdit přiřazení
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={form.approved}
                onCheckedChange={(v) => set("approved", v === true)}
              />
              Schváleno
            </label>
          </div>
          <div className="text-sm text-muted-foreground">
            Celkem bez DPH:{" "}
            <span className="font-semibold text-foreground">
              {fmtKc(line.totalWithoutVat, 2)}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onSplit}>
            <Scissors className="h-4 w-4 mr-1" /> Rozdělit
          </Button>
          <Button size="sm" onClick={() => save()} disabled={updateLine.isPending}>
            <Save className="h-4 w-4 mr-1" /> Uložit položku
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Split dialog
// ---------------------------------------------------------------------------

interface SplitPart {
  quantity: string;
  jobId: string;
  allocationType: string;
}

function SplitDialog({
  documentId,
  line,
  jobs,
  onClose,
  onDone,
}: {
  documentId: number;
  line: CostDocumentLine;
  jobs: Job[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const splitMutation = useSplitCostDocumentLine();

  const half = line.quantity / 2;
  const [parts, setParts] = useState<SplitPart[]>([
    { quantity: String(half), jobId: NONE, allocationType: line.allocationType },
    { quantity: String(line.quantity - half), jobId: NONE, allocationType: line.allocationType },
  ]);

  const total = parts.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  const balanced = Math.abs(total - line.quantity) < 0.0001;

  const setPart = (i: number, patch: Partial<SplitPart>) =>
    setParts((p) => p.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  const addPart = () =>
    setParts((p) => [
      ...p,
      { quantity: "0", jobId: NONE, allocationType: line.allocationType },
    ]);

  const removePart = (i: number) =>
    setParts((p) => (p.length > 2 ? p.filter((_, idx) => idx !== i) : p));

  const submit = () => {
    splitMutation.mutate(
      {
        id: documentId,
        lineId: line.id,
        data: {
          parts: parts.map((p) => ({
            quantity: Number(p.quantity) || 0,
            jobId: p.jobId === NONE ? null : Number(p.jobId),
            allocationType:
              p.allocationType as CostDocumentLineSplitInput["parts"][number]["allocationType"],
          })),
        } satisfies CostDocumentLineSplitInput,
      },
      {
        onSuccess: () => {
          toast({ title: "Položka rozdělena" });
          onDone();
        },
        onError: (err) =>
          toast({
            title: "Rozdělení selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rozdělit položku</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          „{line.description}" — celkové množství {line.quantity}
          {line.unit ? ` ${line.unit}` : ""}. Rozdělte množství mezi zakázky.
        </p>
        <div className="space-y-3 max-h-[50vh] overflow-y-auto">
          {parts.map((part, i) => (
            <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/30">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Část {i + 1}
                </span>
                {parts.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-destructive"
                    onClick={() => removePart(i)}
                  >
                    Odebrat
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Množství</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={part.quantity}
                    onChange={(e) => setPart(i, { quantity: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Režim</Label>
                  <Select
                    value={part.allocationType}
                    onValueChange={(v) => setPart(i, { allocationType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALLOCATION_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {COST_DOC_ALLOCATION_LABELS[t] ?? t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Zakázka</Label>
                <Select
                  value={part.jobId}
                  onValueChange={(v) => setPart(i, { jobId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Žádná" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Žádná</SelectItem>
                    {jobs.map((j) => (
                      <SelectItem key={j.id} value={String(j.id)}>
                        {j.title} ({fmtDate(j.date)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addPart}>
          Přidat část
        </Button>
        <p
          className={`text-sm ${balanced ? "text-muted-foreground" : "text-destructive"}`}
        >
          Součet částí: {total} / {line.quantity}
          {!balanced && " — musí se rovnat celkovému množství"}
        </p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Zrušit
          </Button>
          <Button onClick={submit} disabled={!balanced || splitMutation.isPending}>
            Rozdělit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
