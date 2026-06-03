import { useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetCustomerSite, getGetCustomerSiteQueryKey,
  useListCustomerSiteAttachments, getListCustomerSiteAttachmentsQueryKey,
  useCreateCustomerSiteAttachment, useDeleteCustomerSiteAttachment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpload } from "@workspace/object-storage-web";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadProgressBar } from "@/components/upload-progress-bar";
import { AttachmentViewer } from "@/components/attachment-viewer";
import { FileDropZone } from "@/components/file-drop-zone";
import {
  ArrowLeft, Store, MapPin, User, Phone, FileText, Upload, Trash2, FolderOpen,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const DOC_CATEGORIES = [
  { value: "projektova_dokumentace", label: "Projektová dokumentace" },
  { value: "revize", label: "Revize" },
  { value: "ostatni", label: "Ostatní" },
] as const;

type CategoryValue = (typeof DOC_CATEGORIES)[number]["value"];

function categoryLabel(value: string): string {
  return DOC_CATEGORIES.find((c) => c.value === value)?.label ?? "Ostatní";
}

function getAttachmentUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:")) return url;
  return `/api/storage${url}`;
}

export default function SiteDetail() {
  const params = useParams<{ id: string }>();
  const siteId = parseInt(params.id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: site, isLoading: loadingSite } = useGetCustomerSite(siteId, {
    query: { queryKey: getGetCustomerSiteQueryKey(siteId), enabled: siteId > 0 },
  });

  const { data: docs, isLoading: loadingDocs } = useListCustomerSiteAttachments(siteId, {
    query: { queryKey: getListCustomerSiteAttachmentsQueryKey(siteId), enabled: siteId > 0 },
  });

  const createAttachment = useCreateCustomerSiteAttachment();
  const deleteAttachment = useDeleteCustomerSiteAttachment();

  const [category, setCategory] = useState<CategoryValue>("projektova_dokumentace");
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    uploadFile,
    uploadFiles,
    isBusy: isUploading,
    displayProgress,
    statusLabel,
  } = useUpload();

  const invalidateDocs = () =>
    queryClient.invalidateQueries({ queryKey: getListCustomerSiteAttachmentsQueryKey(siteId) });

  const uploadDocumentFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const { succeeded, failed, errors } = await uploadFiles(files, async (file) => {
      const result = await uploadFile(file);
      await createAttachment.mutateAsync({
        siteId,
        data: { type: category, fileName: file.name, url: result.objectPath },
      });
    });

    invalidateDocs();
    if (succeeded > 0) {
      toast({ title: succeeded === 1 ? "Dokument uložen" : `Nahráno ${succeeded} dokumentů` });
    }
    if (failed > 0) {
      const description = files.length === 1
        ? (errors[0]?.message ?? "Neznámá chyba")
        : `${failed} z ${files.length} se nepodařilo nahrát`;
      toast({ title: "Nahrání selhalo", description, variant: "destructive" });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadDocumentFiles(files);
  };

  const handleDelete = (id: number) => {
    if (!confirm("Smazat tento dokument?")) return;
    deleteAttachment.mutate(
      { siteId, attachmentId: id },
      {
        onSuccess: () => {
          invalidateDocs();
          toast({ title: "Dokument smazán" });
        },
        onError: () => toast({ title: "Nepodařilo se smazat dokument", variant: "destructive" }),
      }
    );
  };

  if (loadingSite) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!site) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground">
        <Store className="h-12 w-12 mb-4 opacity-20" />
        <p>Stavba nenalezena.</p>
        <Button variant="ghost" className="mt-4" onClick={() => setLocation("/customers")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na zákazníky
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-background pb-20 md:pb-0">
      <div className="sticky top-0 z-10 bg-card border-b p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/customers/${site.customerId}`)}>
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{site.name}</h1>
          <p className="text-sm text-muted-foreground">Stavba / pobočka</p>
        </div>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full">
        {/* Site info */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              <div className="bg-amber-100 dark:bg-amber-950/40 p-3 rounded-xl text-amber-600 shrink-0">
                <Store className="h-6 w-6" />
              </div>
              <div className="flex-1 space-y-2 min-w-0">
                <h2 className="text-lg font-bold">{site.name}</h2>
                {site.address && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{site.address}</span>
                  </div>
                )}
                {site.contactPerson && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <User className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{site.contactPerson}</span>
                  </div>
                )}
                {site.phone && (
                  <a href={`tel:${site.phone}`} className="flex items-center gap-2 text-primary font-medium hover:underline">
                    <Phone className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{site.phone}</span>
                  </a>
                )}
                {site.note && <p className="text-sm text-muted-foreground">{site.note}</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Documents */}
        <h2 className="text-base font-bold flex items-center gap-2 mb-3">
          <FolderOpen className="h-4 w-4 text-sky-500" /> Dokumenty
        </h2>

        <Card className="mb-6">
          <CardContent className="p-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-2 block">Kategorie</label>
              <div className="flex flex-wrap gap-2">
                {DOC_CATEGORIES.map((c) => (
                  <Button
                    key={c.value}
                    type="button"
                    size="sm"
                    variant={category === c.value ? "default" : "outline"}
                    className="h-9"
                    onClick={() => setCategory(c.value)}
                  >
                    {c.label}
                  </Button>
                ))}
              </div>
            </div>

            <input
              type="file"
              accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
              multiple
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={createAttachment.isPending || isUploading}
              variant="secondary"
              className="w-full h-12 text-base"
            >
              <Upload className="w-5 h-5 mr-2" />
              {isUploading ? statusLabel : `Nahrát do: ${categoryLabel(category)}`}
            </Button>
            <FileDropZone
              onFiles={uploadDocumentFiles}
              accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
              disabled={createAttachment.isPending || isUploading}
              label={`Sem přetáhněte dokumenty do: ${categoryLabel(category)}`}
            />
            <UploadProgressBar isUploading={isUploading} progress={displayProgress} />
          </CardContent>
        </Card>

        {/* Document list grouped by category */}
        {loadingDocs ? (
          <Skeleton className="h-20 w-full" />
        ) : docs && docs.length > 0 ? (
          <div className="space-y-6">
            {DOC_CATEGORIES.map((cat) => {
              const items = docs.filter((d) => d.type === cat.value);
              if (items.length === 0) return null;
              return (
                <div key={cat.value}>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">
                    {cat.label} ({items.length})
                  </h3>
                  <div className="space-y-2">
                    {items.map((doc) => {
                      const displayUrl = getAttachmentUrl(doc.url);
                      return (
                        <div key={doc.id} className="flex items-center gap-3 p-3 bg-muted/40 border rounded-lg group">
                          <div className="p-1.5 bg-sky-100 dark:bg-sky-900/30 rounded text-sky-600 dark:text-sky-400 shrink-0">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{doc.fileName || "Dokument"}</p>
                          </div>
                          {displayUrl && (
                            <button
                              onClick={() => setViewer({ url: displayUrl, fileName: doc.fileName })}
                              className="text-xs text-primary hover:underline shrink-0"
                            >
                              Zobrazit
                            </button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            onClick={() => handleDelete(doc.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-10 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm">Zatím žádné dokumenty. Nahrajte projektovou dokumentaci, revize atd.</p>
          </div>
        )}
      </div>

      {viewer && (
        <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
