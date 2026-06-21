import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCostDocuments,
  getListCostDocumentsQueryKey,
  useApproveCostDocument,
  useSetCostDocumentStatus,
  getGetBillingSummaryQueryKey,
  ListCostDocumentsSort,
  type CostDocument,
  type ListCostDocumentsParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  AI_CONFIDENCE_LOW,
  AiConfidenceBadge,
  COST_DOC_TYPE_LABELS,
  isPaymentDocument,
  filterWarningsForDocType,
} from "@/lib/cost-document-format";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Sparkles,
  Truck,
  XCircle,
} from "lucide-react";

// Only AI-prefilled documents still awaiting confirmation, lowest confidence first.
const QUEUE_PARAMS: ListCostDocumentsParams = {
  status: "needs_review",
  aiOnly: true,
  sort: ListCostDocumentsSort.confidence_asc,
};

function docWarnings(doc: CostDocument): string[] {
  return filterWarningsForDocType(
    (doc.warnings ?? "")
      .split("\n")
      .map((w) => w.trim())
      .filter(Boolean),
    doc.docType,
  );
}

function isHighConfidence(doc: CostDocument): boolean {
  return doc.aiConfidence != null && doc.aiConfidence >= AI_CONFIDENCE_LOW;
}

export default function BillingReviewQueue() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: docs, isLoading } = useListCostDocuments(QUEUE_PARAMS, {
    query: { queryKey: getListCostDocumentsQueryKey(QUEUE_PARAMS) },
  });
  const approveDoc = useApproveCostDocument();
  const setStatus = useSetCostDocumentStatus();

  // Ids picked via the per-card checkboxes for "Schválit vybrané".
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // True while a batch (selected or all-high-confidence) is running.
  const [bulkRunning, setBulkRunning] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/billing/documents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/billing/approved-lines"] });
    queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
  };

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const busy = approveDoc.isPending || setStatus.isPending || bulkRunning;

  const handleApprove = (doc: CostDocument) => {
    approveDoc.mutate(
      { id: doc.id },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Doklad schválen",
            description: doc.supplierName || doc.fileName || undefined,
          });
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

  // Run a batch of documents sequentially, reusing the per-document mutation so
  // every business rule stays identical. Failures don't abort the rest.
  const runBatch = async (
    targets: CostDocument[],
    emptyMessage: string,
    op: {
      action: (doc: CostDocument) => Promise<unknown>;
      okOne: string;
      okMany: (n: number) => string;
      failOnly: string;
      partial: (ok: number, failed: number) => string;
      failVerb: string;
    },
  ) => {
    if (targets.length === 0) {
      toast({ title: emptyMessage });
      return;
    }
    setBulkRunning(true);
    const targetIds = new Set(targets.map((d) => d.id));
    let ok = 0;
    let failed = 0;
    for (const doc of targets) {
      try {
        await op.action(doc);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    refresh();
    // Drop the just-processed ids from the selection regardless of outcome.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.delete(id);
      return next;
    });
    setBulkRunning(false);
    if (failed === 0) {
      toast({ title: ok === 1 ? op.okOne : op.okMany(ok) });
    } else {
      toast({
        title: ok > 0 ? op.partial(ok, failed) : op.failOnly,
        description: `${failed} ${
          failed === 1 ? "doklad se nepodařilo" : "dokladů se nepodařilo"
        } ${op.failVerb}.`,
        variant: ok === 0 ? "destructive" : undefined,
      });
    }
  };

  const approveBatch = (targets: CostDocument[], emptyMessage: string) =>
    runBatch(targets, emptyMessage, {
      action: (doc) => approveDoc.mutateAsync({ id: doc.id }),
      okOne: "Doklad schválen",
      okMany: (n) => `Schváleno ${n} dokladů`,
      failOnly: "Schválení selhalo",
      partial: (ok, failed) => `Schváleno ${ok}, ${failed} selhalo`,
      failVerb: "schválit",
    });

  const ignoreBatch = (targets: CostDocument[], emptyMessage: string) =>
    runBatch(targets, emptyMessage, {
      action: (doc) =>
        setStatus.mutateAsync({ id: doc.id, data: { status: "ignored" } }),
      okOne: "Doklad ignorován",
      okMany: (n) => `Ignorováno ${n} dokladů`,
      failOnly: "Ignorování selhalo",
      partial: (ok, failed) => `Ignorováno ${ok}, ${failed} selhalo`,
      failVerb: "ignorovat",
    });

  const selectedDocs = useMemo(
    () => (docs ?? []).filter((d) => selected.has(d.id)),
    [docs, selected],
  );
  const highConfidenceDocs = useMemo(
    () => (docs ?? []).filter(isHighConfidence),
    [docs],
  );

  const lowCount =
    docs?.filter((d) => d.aiConfidence != null && d.aiConfidence < AI_CONFIDENCE_LOW)
      .length ?? 0;

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

      <div className="flex items-center gap-3 mb-5">
        <div className="bg-violet-100 dark:bg-violet-900/30 p-2.5 rounded-full text-violet-600 dark:text-violet-300">
          <Sparkles className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Kontrola AI dokladů</h1>
          <p className="text-sm text-muted-foreground">
            Doklady předvyplněné pomocí AI čekající na potvrzení — nejnižší
            důvěryhodnost první
          </p>
        </div>
      </div>

      {!isLoading && docs && docs.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 font-medium">
            {docs.length} ke kontrole
          </span>
          {lowCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 px-3 py-1 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" />
              {lowCount} s nízkou důvěryhodností
            </span>
          )}
        </div>
      )}

      {!isLoading && docs && docs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button
            size="sm"
            onClick={() =>
              approveBatch(selectedDocs, "Nejsou vybrané žádné doklady.")
            }
            disabled={busy || selectedDocs.length === 0}
          >
            {bulkRunning ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-1" />
            )}
            Schválit vybrané
            {selectedDocs.length > 0 ? ` (${selectedDocs.length})` : ""}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              ignoreBatch(selectedDocs, "Nejsou vybrané žádné doklady.")
            }
            disabled={busy || selectedDocs.length === 0}
          >
            <XCircle className="h-4 w-4 mr-1" />
            Ignorovat vybrané
            {selectedDocs.length > 0 ? ` (${selectedDocs.length})` : ""}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              approveBatch(
                highConfidenceDocs,
                "Žádné doklady s vysokou důvěryhodností.",
              )
            }
            disabled={busy || highConfidenceDocs.length === 0}
          >
            <Sparkles className="h-4 w-4 mr-1" />
            Schválit vše s vysokou důvěryhodností
            {highConfidenceDocs.length > 0 ? ` (${highConfidenceDocs.length})` : ""}
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : !docs || docs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">
            Žádné AI doklady ke kontrole. Vše je potvrzeno.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {docs.map((doc) => (
            <ReviewCard
              key={doc.id}
              doc={doc}
              busy={busy}
              selected={selected.has(doc.id)}
              onToggleSelected={() => toggleSelected(doc.id)}
              onApprove={() => handleApprove(doc)}
              onCorrect={() => setLocation(`/billing/documents/${doc.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  doc,
  busy,
  selected,
  onToggleSelected,
  onApprove,
  onCorrect,
}: {
  doc: CostDocument;
  busy: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onApprove: () => void;
  onCorrect: () => void;
}) {
  const low = doc.aiConfidence != null && doc.aiConfidence < AI_CONFIDENCE_LOW;
  const warnings = docWarnings(doc);
  const isPayment = isPaymentDocument(doc.docType);

  return (
    <Card
      className={
        low ? "border-amber-300 bg-amber-50/60 dark:bg-amber-900/10" : ""
      }
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelected}
            disabled={busy}
            className="mt-1 shrink-0"
            aria-label="Vybrat doklad"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <button
                className="min-w-0 text-left"
                onClick={onCorrect}
                aria-label="Otevřít doklad"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold truncate hover:underline">
                    {doc.supplierName || doc.fileName || "Doklad bez dodavatele"}
                  </p>
                  {doc.aiConfidence != null && (
                    <AiConfidenceBadge confidence={doc.aiConfidence} />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {COST_DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                  {doc.documentNumber ? ` · ${doc.documentNumber}` : ""}
                  {doc.issueDate ? ` · ${fmtDate(doc.issueDate)}` : ""}
                </p>
              </button>
              <div className="text-right shrink-0">
                {isPayment ? (
                  <>
                    <div className="font-bold">
                      {fmtKc(doc.totalWithVat ?? null, 0)}
                    </div>
                    {doc.variableSymbol && (
                      <div className="text-xs text-muted-foreground">
                        VS {doc.variableSymbol}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                      <Truck className="h-3 w-3 shrink-0" />
                      Dodací list
                    </span>
                    {doc.totalWithVat != null && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {fmtKc(doc.totalWithVat, 0)}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {warnings.length > 0 && (
              <ul className="mt-3 space-y-0.5 text-xs text-amber-800 dark:text-amber-200">
                {warnings.map((w, i) => (
                  <li key={i} className="flex gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-2 mt-3">
              <Button size="sm" onClick={onApprove} disabled={busy}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Schválit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCorrect}
                disabled={busy}
              >
                <Pencil className="h-4 w-4 mr-1" /> Opravit
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
