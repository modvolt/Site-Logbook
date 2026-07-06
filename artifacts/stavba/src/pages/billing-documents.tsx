import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import {
  useListCostDocuments,
  getListCostDocumentsQueryKey,
  getGetBillingSummaryQueryKey,
  useApproveCostDocument,
  type CostDocument,
  type ListCostDocumentsParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileDropZone } from "@/components/file-drop-zone";
import { UploadProgressBar } from "@/components/upload-progress-bar";
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  COST_DOC_STATUS_LABELS,
  COST_DOC_TYPE_LABELS,
  CostDocStatusBadge,
  MaterialStateBadge,
} from "@/lib/cost-document-format";
import {
  uploadCostDocument,
  DuplicateCostDocumentError,
  isZipArchive,
  expandZipArchive,
  isImageFile,
  newUploadGroupToken,
} from "@/lib/cost-document-upload";
import type { CostDocumentDuplicate } from "@workspace/api-client-react";
import { ArrowLeft, CheckCircle2, FileText, Inbox, Loader2, Sparkles, Upload } from "lucide-react";
import { QueryErrorState } from "@/components/query-error-state";

const UPLOAD_ACCEPT =
  "application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/gif,.gif,image/heic,.heic,image/heif,.heif,application/xml,text/xml,.xml,.isdoc,application/zip,.isdocx,.zip";

const AI_REVIEW_PARAMS: ListCostDocumentsParams = {
  status: "needs_review",
  aiOnly: true,
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "Všechny stavy" },
  { value: "needs_review", label: COST_DOC_STATUS_LABELS.needs_review },
  { value: "reviewed", label: COST_DOC_STATUS_LABELS.reviewed },
  { value: "approved", label: COST_DOC_STATUS_LABELS.approved },
  { value: "uploaded", label: COST_DOC_STATUS_LABELS.uploaded },
  { value: "duplicate", label: COST_DOC_STATUS_LABELS.duplicate },
  { value: "ignored", label: COST_DOC_STATUS_LABELS.ignored },
];

export default function BillingDocuments() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [statusFilter, setStatusFilter] = useState("all");
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    duplicates: CostDocumentDuplicate[];
  } | null>(null);
  const [pendingGroupChoice, setPendingGroupChoice] = useState<File[] | null>(null);

  const params = statusFilter === "all" ? undefined : { status: statusFilter };
  const { data: docs, isLoading, isError, error, refetch } = useListCostDocuments(params, {
    query: { queryKey: getListCostDocumentsQueryKey(params) },
  });

  const { data: aiReviewDocs } = useListCostDocuments(AI_REVIEW_PARAMS, {
    query: { queryKey: getListCostDocumentsQueryKey(AI_REVIEW_PARAMS) },
  });
  const aiReviewCount = aiReviewDocs?.length ?? 0;

  const refresh = () => {
    invalidateData(queryClient, "billingDocuments");
  };

  const approveDoc = useApproveCostDocument();
  const [approvingId, setApprovingId] = useState<number | null>(null);

  const handleApprove = (doc: CostDocument) => {
    setApprovingId(doc.id);
    approveDoc.mutate(
      { id: doc.id },
      {
        onSuccess: () => {
          // Approval propagates into job materials + warehouse (stock, price
          // history), so open job/warehouse/dashboard screens must refresh too.
          invalidateData(queryClient, "billingDocuments", "jobs", "warehouse");
          toast({ title: "Doklad schválen" });
        },
        onError: (err) =>
          toast({
            title: "Schválení selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
        onSettled: () => setApprovingId(null),
      },
    );
  };

  const doUpload = async (file: File, force: boolean) => {
    setIsUploading(true);
    try {
      const detail = await uploadCostDocument(file, { force });
      refresh();
      toast({ title: "Doklad nahrán" });
      setConflict(null);
      setPendingFile(null);
      setLocation(`/billing/documents/${detail.document.id}`);
    } catch (err) {
      if (err instanceof DuplicateCostDocumentError) {
        setPendingFile(file);
        setConflict({ message: err.message, duplicates: err.duplicates });
      } else {
        toast({
          title: "Nahrání selhalo",
          description: err instanceof Error ? err.message : "Neznámá chyba",
          variant: "destructive",
        });
      }
    } finally {
      setIsUploading(false);
    }
  };

  /** Upload each file as its own document (existing batch behavior). */
  const uploadSeparately = async (
    expanded: File[],
    zipSkipped: number,
    zipFailed: number,
  ) => {
    let ok = 0;
    let dup = 0;
    let failed = 0;
    setProgress({ done: 0, total: expanded.length });
    for (let i = 0; i < expanded.length; i++) {
      try {
        await uploadCostDocument(expanded[i]);
        ok++;
      } catch (err) {
        if (err instanceof DuplicateCostDocumentError) dup++;
        else failed++;
      }
      setProgress({ done: i + 1, total: expanded.length });
    }
    refresh();
    const hadProblems = failed > 0 || zipFailed > 0;
    const parts = [`Nahráno ${ok}`];
    if (dup > 0) parts.push(`přeskočeno ${dup} duplicit`);
    if (zipSkipped > 0) parts.push(`${zipSkipped} nepodporovaných`);
    if (failed > 0) parts.push(`${failed} chyb`);
    if (zipFailed > 0)
      parts.push(`${zipFailed} ${zipFailed === 1 ? "archiv nešel rozbalit" : "archivů nešlo rozbalit"}`);
    toast({
      title: hadProblems ? "Nahrávání dokončeno s chybami" : "Doklady nahrány",
      description: `${parts.join(", ")}.`,
      variant: hadProblems ? "destructive" : undefined,
    });
  };

  /**
   * Upload every photo as one multi-page document (task #679): all pages share
   * one group token; the last page's upload triggers extraction + merge check
   * server-side, once, over the complete set.
   */
  const uploadAsGroup = async (files: File[]) => {
    const groupToken = newUploadGroupToken();
    let lastDocumentId: number | null = null;
    setProgress({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i++) {
        const detail = await uploadCostDocument(files[i], {
          groupToken,
          groupComplete: i === files.length - 1,
        });
        lastDocumentId = detail.document.id;
        setProgress({ done: i + 1, total: files.length });
      }
      refresh();
      toast({ title: `Vícestránkový doklad nahrán (${files.length} stránek)` });
      if (lastDocumentId != null) {
        setLocation(`/billing/documents/${lastDocumentId}`);
      }
    } catch (err) {
      toast({
        title: "Nahrání vícestránkového dokladu selhalo",
        description: err instanceof Error ? err.message : "Neznámá chyba",
        variant: "destructive",
      });
    } finally {
      setProgress(null);
    }
  };

  const handleFiles = async (selected: File[]) => {
    if (selected.length === 0 || isUploading) return;
    setIsUploading(true);
    try {
      // Expand any ZIP archives into their supported contents. .isdocx stays
      // a single document (isZipArchive returns false for it).
      const expanded: File[] = [];
      let zipSkipped = 0;
      let zipFailed = 0;
      for (const file of selected) {
        if (isZipArchive(file)) {
          try {
            const { files, skipped } = await expandZipArchive(file);
            expanded.push(...files);
            zipSkipped += skipped;
          } catch {
            zipFailed++;
          }
        } else {
          expanded.push(file);
        }
      }

      if (expanded.length === 0) {
        toast({
          title: zipFailed > 0 ? "ZIP nelze otevřít" : "Žádné podporované doklady",
          description: zipFailed > 0
            ? "Archiv je poškozený nebo prázdný."
            : zipSkipped > 0
              ? `V archivu nebyly žádné podporované soubory (přeskočeno ${zipSkipped}).`
              : "Vyberte PDF, foto nebo e-fakturu (ISDOC/XML).",
          variant: "destructive",
        });
        return;
      }

      // A single document with no archive problems keeps the original flow:
      // navigate to its detail and offer the "nahrát i přesto" duplicate dialog.
      if (expanded.length === 1 && zipFailed === 0) {
        await doUpload(expanded[0], false);
        return;
      }

      // Several photos selected together (not from a ZIP, not mixed with a PDF
      // or e-invoice) — ask whether they're pages of one document before
      // uploading anything (task #679).
      if (zipFailed === 0 && zipSkipped === 0 && expanded.every(isImageFile)) {
        setPendingGroupChoice(expanded);
        return;
      }

      await uploadSeparately(expanded, zipSkipped, zipFailed);
    } finally {
      setProgress(null);
      setIsUploading(false);
    }
  };

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await handleFiles(files);
  };

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

      <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2.5 rounded-full text-emerald-600 dark:text-emerald-300">
            <Inbox className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Přijaté doklady</h1>
            <p className="text-sm text-muted-foreground">
              Účtenky, dodací listy, přijaté faktury a dobropisy
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLocation("/billing/documents/review")}
        >
          <Sparkles className="h-4 w-4 mr-1" /> Kontrola AI dokladů
          {aiReviewCount > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-violet-600 text-white text-xs font-semibold min-w-[1.25rem] h-5 px-1.5">
              {aiReviewCount}
            </span>
          )}
        </Button>
      </div>

      <input
        type="file"
        accept={UPLOAD_ACCEPT}
        ref={fileInputRef}
        onChange={handleInputChange}
        multiple
        className="hidden"
      />
      <div className="space-y-3 mb-5">
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading || isLoading || isError}
          className="w-full h-12 text-base"
        >
          <Upload className="h-5 w-5 mr-2" />
          {isUploading
            ? progress
              ? `Nahrávám… (${progress.done}/${progress.total})`
              : "Nahrávám…"
            : "Nahrát doklady"}
        </Button>
        <UploadProgressBar
          isUploading={isUploading}
          progress={
            progress ? Math.round((progress.done / progress.total) * 100) : 0
          }
        />
        <FileDropZone
          onFiles={handleFiles}
          accept={UPLOAD_ACCEPT}
          multiple
          disabled={isUploading || isLoading || isError}
          label="Sem přetáhněte doklady (PDF, foto, ISDOC/XML nebo ZIP)"
        />
      </div>

      <div className="mb-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : isError ? (
        <QueryErrorState
          title="Nepodařilo se načíst doklady"
          error={error}
          onRetry={() => refetch()}
        />
      ) : !docs || docs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
          <FileText className="w-10 h-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">Žádné doklady k zobrazení.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {docs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              onClick={() => setLocation(`/billing/documents/${doc.id}`)}
              onApprove={() => handleApprove(doc)}
              isApproving={approvingId === doc.id}
            />
          ))}
        </div>
      )}

      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConflict(null);
            setPendingFile(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Možná duplicita</DialogTitle>
            <DialogDescription>{conflict?.message}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {conflict?.duplicates.map((d) => (
              <div
                key={d.id}
                className="text-sm border rounded-lg p-3 bg-muted/40"
              >
                <div className="font-medium">
                  {d.supplierName || "Neznámý dodavatel"}
                  {d.documentNumber ? ` · ${d.documentNumber}` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {COST_DOC_STATUS_LABELS[d.status] ?? d.status} ·{" "}
                  {fmtDate(d.createdAt)}
                  {d.totalWithVat ? ` · ${d.totalWithVat} Kč` : ""}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {d.reason}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setConflict(null);
                setPendingFile(null);
              }}
            >
              Zrušit
            </Button>
            <Button
              disabled={isUploading}
              onClick={() => pendingFile && doUpload(pendingFile, true)}
            >
              Nahrát i přesto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingGroupChoice !== null}
        onOpenChange={(open) => {
          if (!open) setPendingGroupChoice(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Jsou to stránky jednoho dokladu?</DialogTitle>
            <DialogDescription>
              Vybrali jste {pendingGroupChoice?.length ?? 0} fotografií. Pokud jde
              o více stránek téhož dokladu (např. vícestránková faktura),
              spojíme je do jednoho záznamu. Jinak je nahrajeme jako
              samostatné doklady.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              disabled={isUploading}
              onClick={async () => {
                const files = pendingGroupChoice;
                setPendingGroupChoice(null);
                if (!files) return;
                setIsUploading(true);
                try {
                  await uploadSeparately(files, 0, 0);
                } finally {
                  setProgress(null);
                  setIsUploading(false);
                }
              }}
            >
              Samostatné doklady
            </Button>
            <Button
              disabled={isUploading}
              onClick={async () => {
                const files = pendingGroupChoice;
                setPendingGroupChoice(null);
                if (!files) return;
                setIsUploading(true);
                try {
                  await uploadAsGroup(files);
                } finally {
                  setIsUploading(false);
                }
              }}
            >
              Jedna vícestránková faktura
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Statuses from which a document can still be approved directly. Already
// approved / duplicate / ignored documents are excluded — those require an
// explicit status change (or are terminal) on the detail page instead.
const NOT_APPROVABLE_STATUSES = new Set(["approved", "duplicate", "ignored"]);

function DocumentCard({
  doc,
  onClick,
  onApprove,
  isApproving,
}: {
  doc: CostDocument;
  onClick: () => void;
  onApprove: () => void;
  isApproving: boolean;
}) {
  const canApprove = !NOT_APPROVABLE_STATUSES.has(doc.status);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold truncate">
                  {doc.supplierName || doc.fileName || "Doklad bez dodavatele"}
                </p>
                <CostDocStatusBadge status={doc.status} />
                <MaterialStateBadge state={doc.materialState} />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {COST_DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                {doc.documentNumber ? ` · ${doc.documentNumber}` : ""}
                {doc.issueDate ? ` · ${fmtDate(doc.issueDate)}` : ""}
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="font-bold">{fmtKc(doc.totalWithVat ?? null, 0)}</div>
              {doc.variableSymbol && (
                <div className="text-xs text-muted-foreground">
                  VS {doc.variableSymbol}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </button>
      {canApprove && (
        <div className="px-4 pb-3 -mt-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={isApproving}
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
          >
            {isApproving ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
            )}
            {isApproving ? "Schvaluji…" : "Schválit doklad"}
          </Button>
        </div>
      )}
    </Card>
  );
}
