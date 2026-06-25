import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
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
  useAddCostDocumentReference,
  useUpdateCostDocumentReference,
  useDeleteCostDocumentReference,
  useMatchCostDocumentReferences,
  useApplyCostDocumentWarehousePrices,
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
  getGetBillingSummaryQueryKey,
  type CostDocument,
  type CostDocumentDetail,
  type CostDocumentLine,
  type CostDocumentReference,
  type CostDocumentReferenceJobCandidate,
  type CostDocumentMatchResult,
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
import { DecimalInput, parseDecimal, decimalError } from "@/components/decimal-input";
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  COST_DOC_TYPE_LABELS,
  COST_DOC_LINE_TYPE_LABELS,
  COST_DOC_ALLOCATION_LABELS,
  COST_DOC_REFERENCE_TYPE_LABELS,
  COST_DOC_REFERENCE_SOURCE_LABELS,
  CostDocStatusBadge,
  MaterialStateBadge,
  isPaymentDocument,
  filterWarningsForDocType,
} from "@/lib/cost-document-format";
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CheckCircle2,
  EyeOff,
  FileText,
  Link2,
  PackageCheck,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Truck,
  Wand2,
  X,
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
  return parseDecimal(v);
}

function saveErrorMessage(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  const serverError =
    data && typeof data === "object"
      ? (data as { error?: unknown }).error
      : undefined;
  if (typeof serverError === "string" && serverError.trim() !== "")
    return serverError;
  return undefined;
}

export default function BillingDocumentDetail() {
  const [, params] = useRoute("/billing/documents/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const { openConfirm, dialogProps } = useConfirmDialog();
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
    invalidateData(queryClient, "billingDocuments", "jobs", "warehouse");
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
    openConfirm("Opravdu smazat tento doklad? Tuto akci nelze vrátit.", () => {
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
    });
  };

  const fileHref = attachmentUrl(doc.objectPath);
  const warnings = filterWarningsForDocType(
    (doc.warnings ?? "")
      .split("\n")
      .map((w) => w.trim())
      .filter(Boolean),
    doc.docType,
  );
  const isPayment = isPaymentDocument(doc.docType);

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
              <MaterialStateBadge state={doc.materialState} />
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

      {doc.aiConfidence != null && (
        <Card
          className={`mb-4 ${
            doc.aiConfidence < 0.7
              ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20"
              : "border-violet-300 bg-violet-50 dark:bg-violet-900/20"
          }`}
        >
          <CardContent className="p-4 flex items-start gap-2 text-sm">
            <Sparkles
              className={`h-4 w-4 shrink-0 mt-0.5 ${
                doc.aiConfidence < 0.7
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-violet-700 dark:text-violet-300"
              }`}
            />
            <div>
              <p
                className={
                  doc.aiConfidence < 0.7
                    ? "text-amber-800 dark:text-amber-200"
                    : "text-violet-800 dark:text-violet-200"
                }
              >
                Předvyplněno pomocí AI (OpenAI
                {doc.aiModel ? `, ${doc.aiModel}` : ""}) — důvěryhodnost{" "}
                <strong>{Math.round(doc.aiConfidence * 100)} %</strong>. Všechny
                údaje před schválením zkontrolujte.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!isPayment && (
        <Card className="mb-4 border-sky-300 bg-sky-50 dark:bg-sky-900/20">
          <CardContent className="p-4 flex items-start gap-2 text-sm text-sky-800 dark:text-sky-200">
            <Truck className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              Dodací list — nejde o platební doklad. Variabilní symbol, datum
              splatnosti ani částka k úhradě se u něj běžně neuvádějí; jejich
              chybějící hodnoty nejsou chybou a nebrání schválení.
            </p>
          </CardContent>
        </Card>
      )}

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
              onError: (error) =>
                toast({
                  title: "Uložení selhalo",
                  description: saveErrorMessage(error),
                  variant: "destructive",
                }),
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

      <ReferencesSection
        documentId={id}
        references={data.references}
        jobs={jobs ?? []}
        onChanged={invalidate}
      />

      <AutoLinksSection linkedMaterials={data.linkedMaterials ?? []} />

      <WarehousePricesCard
        documentId={id}
        approved={doc.status === "approved"}
        onApplied={invalidate}
      />

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
      <ConfirmDialog {...dialogProps} />
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

  // A delivery note is not a payment document — its variable symbol, due date
  // and amount-to-pay are normally absent, so label them as optional there.
  const isPayment = isPaymentDocument(form.docType);
  const optionalForDelivery = isPayment ? "" : " (u dodacího listu se neuvádí)";

  const subtotalError = decimalError(form.subtotalWithoutVat);
  const totalVatError = decimalError(form.totalVat);
  const totalWithVatError = decimalError(form.totalWithVat);
  const headerHasErrors = !!(subtotalError || totalVatError || totalWithVatError);

  const handleSave = () => {
    if (headerHasErrors) return;
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
          <Field label={`Variabilní symbol${optionalForDelivery}`}>
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
          <Field label={`Datum splatnosti${optionalForDelivery}`}>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Základ bez DPH">
            <DecimalInput
              value={form.subtotalWithoutVat}
              onChange={(v) => set("subtotalWithoutVat", v)}
              error={subtotalError}
            />
          </Field>
          <Field label="DPH">
            <DecimalInput
              value={form.totalVat}
              onChange={(v) => set("totalVat", v)}
              error={totalVatError}
            />
          </Field>
          <Field label={`Celkem s DPH${optionalForDelivery}`}>
            <DecimalInput
              value={form.totalWithVat}
              onChange={(v) => set("totalWithVat", v)}
              error={totalWithVatError}
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
          <Button onClick={handleSave} disabled={saving || headerHasErrors}>
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

  const qtyError = decimalError(form.quantity);
  const priceError = decimalError(form.unitPriceWithoutVat);
  const lineHasErrors = !!(qtyError || priceError);

  const save = (overrides?: Partial<typeof form>) => {
    if (lineHasErrors) return;
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
            <DecimalInput
              value={form.quantity}
              onChange={(v) => set("quantity", v)}
              error={qtyError}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">MJ</Label>
            <Input value={form.unit} onChange={(e) => set("unit", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cena/MJ bez DPH</Label>
            <DecimalInput
              value={form.unitPriceWithoutVat}
              onChange={(v) => set("unitPriceWithoutVat", v)}
              error={priceError}
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
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              Režim nákladu
              {form.allocationType === "stock" && (
                <span className="inline-flex items-center rounded-full bg-cyan-100 text-cyan-700 text-[10px] font-medium px-1.5 py-0.5">
                  Sklad +{line.approved ? " (naskladněno)" : ""}
                </span>
              )}
            </Label>
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
          <Button size="sm" onClick={() => save()} disabled={updateLine.isPending || lineHasErrors}>
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

  const partErrors = parts.map((p) => {
    if (p.quantity.trim() === "") return "Zadejte množství";
    return decimalError(p.quantity, { positiveOnly: true });
  });
  const hasErrors = partErrors.some(Boolean);

  const total = parts.reduce((s, p) => s + (parseDecimal(p.quantity) ?? 0), 0);
  const balanced = Math.abs(total - line.quantity) < 0.0001;
  const anyPartInvalid = parts.some((p) => !!decimalError(p.quantity));

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
            quantity: parseDecimal(p.quantity) ?? 0,
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
                  <DecimalInput
                    value={part.quantity}
                    onChange={(v) => setPart(i, { quantity: v })}
                    error={partErrors[i]}
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
          <Button onClick={submit} disabled={hasErrors || !balanced || splitMutation.isPending}>
            Rozdělit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Auto-links: materials this document propagated prices onto ("Automatické vazby")
// ---------------------------------------------------------------------------

const AUTO_LINK_SOURCE_LABEL: Record<string, string> = {
  invoice: "Z faktury",
  delivery_note: "Z dodacího listu",
  awaiting_invoice: "Čeká na fakturu",
  stock_history: "Ze skladové historie",
  manual: "Ručně",
};

function AutoLinksSection({
  linkedMaterials,
}: {
  linkedMaterials: NonNullable<CostDocumentDetail["linkedMaterials"]>;
}) {
  const [, navigate] = useLocation();
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="flex items-center gap-2 font-semibold">
          <Link2 className="h-5 w-5" /> Automatické vazby
        </h3>
        {linkedMaterials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tento doklad zatím nedoplnil cenu žádnému materiálu. Po schválení
            spárované faktury se zde zobrazí materiál s doplněnou cenou.
          </p>
        ) : (
          <div className="space-y-1.5">
            {linkedMaterials.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`/jobs/${m.jobId}`)}
                className="w-full flex items-center gap-2 p-2.5 bg-card border rounded-lg hover:bg-muted/50 transition-colors text-left"
              >
                <PackageCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm">{m.name}</span>
                  {m.priceSource && AUTO_LINK_SOURCE_LABEL[m.priceSource] && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-medium px-1.5 py-0.5 align-middle">
                      {AUTO_LINK_SOURCE_LABEL[m.priceSource]}
                    </span>
                  )}
                  {m.invoicedInvoiceId != null && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 text-violet-700 text-[10px] font-medium px-1.5 py-0.5 align-middle">
                      Vyfakturováno
                    </span>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    Zakázka #{m.jobId}
                    {m.quantity != null ? ` • ${m.quantity} ${m.unit ?? ""}`.trimEnd() : ""}
                    {m.priceConfidence != null ? ` • spolehlivost ${Math.round(m.priceConfidence * 100)} %` : ""}
                  </div>
                </div>
                {m.pricePerUnit != null && (
                  <span className="text-sm font-semibold text-emerald-600 shrink-0">
                    {fmtKc(m.pricePerUnit)}/ks
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// References: delivery notes / orders / jobs ("Vazby na dodací listy a zakázky")
// ---------------------------------------------------------------------------

const REFERENCE_TYPE_OPTIONS = [
  "delivery_note",
  "summary_delivery_note",
  "delivery",
  "order",
  "supplier_order",
  "project",
  "invoice",
  "credit_note",
  "other",
];

function ReferencesSection({
  documentId,
  references,
  jobs,
  onChanged,
}: {
  documentId: number;
  references: CostDocumentReference[];
  jobs: Job[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState("delivery_note");
  const [newNumber, setNewNumber] = useState("");
  // Job suggestions per reference, populated after running the matcher.
  const [candidates, setCandidates] = useState<
    Record<number, CostDocumentReferenceJobCandidate[]>
  >({});

  const addRef = useAddCostDocumentReference();
  const matchRefs = useMatchCostDocumentReferences();

  const jobTitle = (jobId: number | null) =>
    jobId == null ? null : (jobs.find((j) => j.id === jobId)?.title ?? `#${jobId}`);

  const handleAdd = () => {
    if (!newNumber.trim()) return;
    addRef.mutate(
      {
        id: documentId,
        data: { referenceType: newType as never, referenceNumber: newNumber.trim() },
      },
      {
        onSuccess: () => {
          setNewNumber("");
          setAdding(false);
          onChanged();
          toast({ title: "Reference přidána" });
        },
        onError: () =>
          toast({ title: "Referenci se nepodařilo přidat", variant: "destructive" }),
      },
    );
  };

  const handleMatch = () => {
    matchRefs.mutate(
      { id: documentId },
      {
        onSuccess: (result: CostDocumentMatchResult) => {
          setCandidates(
            (result.candidatesByRef ?? {}) as Record<
              number,
              CostDocumentReferenceJobCandidate[]
            >,
          );
          onChanged();
          toast({ title: "Návrhy párování připraveny" });
        },
        onError: () =>
          toast({ title: "Párování selhalo", variant: "destructive" }),
      },
    );
  };

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Vazby na dodací listy a zakázky
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleMatch}
            disabled={matchRefs.isPending || references.length === 0}
          >
            <Wand2 className="h-4 w-4 mr-1" /> Navrhnout zakázky
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4 mr-1" /> Přidat
          </Button>
        </div>
      </div>

      {adding && (
        <Card className="mb-3">
          <CardContent className="p-3 flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="space-y-1 flex-1">
              <Label className="text-xs text-muted-foreground">Typ</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFERENCE_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {COST_DOC_REFERENCE_TYPE_LABELS[t] ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs text-muted-foreground">Číslo</Label>
              <Input
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder="např. DL2024001"
              />
            </div>
            <Button onClick={handleAdd} disabled={addRef.isPending || !newNumber.trim()}>
              Uložit
            </Button>
          </CardContent>
        </Card>
      )}

      {references.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground border-2 border-dashed rounded-xl border-muted text-sm">
          Žádné vazby. Reference z ISDOC se načtou automaticky, další můžete
          přidat ručně.
        </div>
      ) : (
        <div className="space-y-2">
          {references.map((ref) => (
            <ReferenceCard
              key={ref.id}
              documentId={documentId}
              reference={ref}
              jobs={jobs}
              jobTitle={jobTitle}
              candidates={candidates[ref.id] ?? []}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReferenceCard({
  documentId,
  reference,
  jobs,
  jobTitle,
  candidates,
  onChanged,
}: {
  documentId: number;
  reference: CostDocumentReference;
  jobs: Job[];
  jobTitle: (jobId: number | null) => string | null;
  candidates: CostDocumentReferenceJobCandidate[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const updateRef = useUpdateCostDocumentReference();
  const deleteRef = useDeleteCostDocumentReference();

  const patch = (
    data: Parameters<typeof updateRef.mutate>[0]["data"],
    okTitle: string,
  ) =>
    updateRef.mutate(
      { id: documentId, referenceId: reference.id, data },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: okTitle });
        },
        onError: () =>
          toast({ title: "Akce selhala", variant: "destructive" }),
      },
    );

  const handleDelete = () =>
    deleteRef.mutate(
      { id: documentId, referenceId: reference.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Reference odstraněna" });
        },
        onError: () =>
          toast({ title: "Odstranění selhalo", variant: "destructive" }),
      },
    );

  const linkedJob = jobTitle(reference.matchedJobId ?? null);
  const confirmed = reference.matchConfirmed;
  const rejected = reference.rejected;

  return (
    <Card
      className={
        rejected
          ? "opacity-60"
          : confirmed
            ? "border-emerald-400/50"
            : ""
      }
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                {COST_DOC_REFERENCE_TYPE_LABELS[reference.referenceType] ??
                  reference.referenceType}
              </span>
              <span className="font-medium">{reference.referenceNumber}</span>
              <span className="text-xs text-muted-foreground">
                {COST_DOC_REFERENCE_SOURCE_LABELS[reference.source] ??
                  reference.source}
              </span>
              {confirmed && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> Potvrzeno
                </span>
              )}
              {rejected && (
                <span className="text-xs text-muted-foreground">Zamítnuto</span>
              )}
            </div>
            {linkedJob && (
              <p className="text-sm text-muted-foreground mt-1">
                Zakázka: <span className="text-foreground">{linkedJob}</span>
                {reference.matchConfidence != null &&
                  ` · shoda ${Math.round(reference.matchConfidence * 100)} %`}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground shrink-0"
            onClick={handleDelete}
            title="Odstranit referenci"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        {/* Manual job link */}
        <div className="flex items-center gap-2">
          <Select
            value={reference.matchedJobId != null ? String(reference.matchedJobId) : NONE}
            onValueChange={(v) =>
              patch(
                { matchedJobId: v === NONE ? null : Number(v) },
                "Zakázka přiřazena",
              )
            }
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Přiřadit zakázku" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Žádná zakázka</SelectItem>
              {jobs.map((j) => (
                <SelectItem key={j.id} value={String(j.id)}>
                  {j.title} ({fmtDate(j.date)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {reference.matchedJobId != null && !confirmed && !rejected && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => patch({ matchConfirmed: true }, "Vazba potvrzena")}
            >
              <Check className="h-4 w-4 mr-1" /> Potvrdit
            </Button>
          )}
          {!rejected && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              onClick={() => patch({ rejected: true }, "Vazba zamítnuta")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          {rejected && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => patch({ rejected: false }, "Vazba obnovena")}
            >
              Obnovit
            </Button>
          )}
        </div>

        {/* Ranked job suggestions from the matcher */}
        {candidates.length > 0 && !confirmed && (
          <div className="rounded-lg bg-muted/40 p-2 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Návrhy zakázek
            </p>
            {candidates.slice(0, 3).map((c) => (
              <button
                key={c.jobId}
                className="flex w-full items-center justify-between text-left text-sm hover:underline"
                onClick={() =>
                  patch({ matchedJobId: c.jobId }, "Zakázka přiřazena")
                }
              >
                <span className="truncate">{c.jobTitle ?? `#${c.jobId}`}</span>
                <span className="text-xs text-muted-foreground shrink-0 ml-2">
                  {Math.round(c.score * 100)} % · {c.reasons[0] ?? ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approval → warehouse purchase-price update
// ---------------------------------------------------------------------------

function WarehousePricesCard({
  documentId,
  approved,
  onApplied,
}: {
  documentId: number;
  approved: boolean;
  onApplied: () => void;
}) {
  const { openConfirm, dialogProps } = useConfirmDialog();
  const { toast } = useToast();
  const apply = useApplyCostDocumentWarehousePrices();

  if (!approved) return null;

  const handleApply = () => {
    openConfirm(
      {
        title: "Přenést nákupní ceny do skladu?",
        description: "Aktualizují se ceny odpovídajících skladových karet a chybějící se automaticky založí.",
        confirmLabel: "Přenést",
      },
      () => apply.mutate(
      { id: documentId },
      {
        onSuccess: (res) => {
          onApplied();
          toast({
            title: "Ceny přeneseny do skladu",
            description: `Aktualizováno ${res.updated.length - res.created} položek, nově založeno ${res.created}, přeskočeno ${res.skipped}.`,
          });
        },
        onError: (err) =>
          toast({
            title: "Přenos cen selhal",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    ),
  );
  };

  return (
    <Card className="mt-6">
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium flex items-center gap-2">
            <PackageCheck className="h-4 w-4" /> Sklad
          </p>
          <p className="text-muted-foreground">
            Přenést nákupní ceny materiálových položek do skladových karet;
            chybějící karty se automaticky založí.
          </p>
        </div>
        <Button variant="outline" onClick={handleApply} disabled={apply.isPending}>
          Aktualizovat ceny
        </Button>
      </CardContent>
    </Card>
  );
}
