import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCostDocuments,
  getListCostDocumentsQueryKey,
  getGetBillingSummaryQueryKey,
  type CostDocument,
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
import { useToast } from "@/hooks/use-toast";
import { fmtKc, fmtDate } from "@/lib/billing-format";
import {
  COST_DOC_STATUS_LABELS,
  COST_DOC_TYPE_LABELS,
  CostDocStatusBadge,
} from "@/lib/cost-document-format";
import {
  uploadCostDocument,
  DuplicateCostDocumentError,
} from "@/lib/cost-document-upload";
import type { CostDocumentDuplicate } from "@workspace/api-client-react";
import { ArrowLeft, FileText, Inbox, Sparkles, Upload } from "lucide-react";

const UPLOAD_ACCEPT =
  "image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.xml,.isdoc,.isdocx";

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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    duplicates: CostDocumentDuplicate[];
  } | null>(null);

  const params = statusFilter === "all" ? undefined : { status: statusFilter };
  const { data: docs, isLoading } = useListCostDocuments(params, {
    query: { queryKey: getListCostDocumentsQueryKey(params) },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/billing/documents"] });
    queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
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

  const handleFiles = async (files: File[]) => {
    if (files.length === 0 || isUploading) return;
    await doUpload(files[0], false);
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
        </Button>
      </div>

      <input
        type="file"
        accept={UPLOAD_ACCEPT}
        ref={fileInputRef}
        onChange={handleInputChange}
        className="hidden"
      />
      <div className="space-y-3 mb-5">
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="w-full h-12 text-base"
        >
          <Upload className="h-5 w-5 mr-2" />
          {isUploading ? "Nahrávám…" : "Nahrát doklad"}
        </Button>
        <FileDropZone
          onFiles={handleFiles}
          accept={UPLOAD_ACCEPT}
          multiple={false}
          disabled={isUploading}
          label="Sem přetáhněte doklad (PDF, foto, ISDOC/XML)"
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
    </div>
  );
}

function DocumentCard({
  doc,
  onClick,
}: {
  doc: CostDocument;
  onClick: () => void;
}) {
  return (
    <Card
      className="hover:bg-muted/30 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold truncate">
                {doc.supplierName || doc.fileName || "Doklad bez dodavatele"}
              </p>
              <CostDocStatusBadge status={doc.status} />
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
    </Card>
  );
}
