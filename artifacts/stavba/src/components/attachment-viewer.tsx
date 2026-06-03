import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { X, Download, FileText, Loader2, ExternalLink } from "lucide-react";

function matchesExt(name: string | null | undefined, url: string, exts: RegExp): boolean {
  const target = (name || url || "").toLowerCase().split("?")[0];
  return exts.test(target);
}

function isImage(name: string | null | undefined, url: string): boolean {
  if (url.startsWith("data:image")) return true;
  return matchesExt(name, url, /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif)$/);
}

function isPdf(name: string | null | undefined, url: string): boolean {
  if (url.startsWith("data:application/pdf")) return true;
  return matchesExt(name, url, /\.pdf$/);
}

export function AttachmentViewer({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName?: string | null;
  onClose: () => void;
}) {
  const img = isImage(fileName, url);
  const pdf = isPdf(fileName, url);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Brave (and some privacy browsers) block PDFs loaded directly into an
  // <iframe> by URL. Fetching the file and rendering it from a blob: URL
  // bypasses that block and keeps the PDF inside the app.
  useEffect(() => {
    if (!pdf) return;
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      setBlobUrl(url);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    setPdfError(false);
    setBlobUrl(null);
    fetch(url, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const pdfBlob = blob.type ? blob : new Blob([blob], { type: "application/pdf" });
        const objectUrl = URL.createObjectURL(pdfBlob);
        revoked = objectUrl;
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPdfError(true);
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [pdf, url]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/90 flex flex-col"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-3 p-3 text-white shrink-0"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <span className="text-sm font-medium truncate">{fileName || "Příloha"}</span>
        <div className="flex items-center gap-1 shrink-0">
          <a
            href={url}
            download={fileName || true}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 hover:bg-white/10 rounded-lg"
            aria-label="Stáhnout"
          >
            <Download className="w-5 h-5" />
          </a>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg"
            aria-label="Zavřít"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center p-2 pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {img ? (
          <img src={url} alt={fileName || "Příloha"} className="max-w-full max-h-full object-contain" />
        ) : pdf ? (
          pdfError ? (
            <div className="text-center text-white max-w-xs">
              <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="mb-5 text-sm opacity-80">Dokument se nepodařilo zobrazit v aplikaci.</p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-black rounded-lg font-medium"
              >
                <ExternalLink className="w-4 h-4" /> Otevřít v novém okně
              </a>
            </div>
          ) : blobUrl ? (
            <iframe src={blobUrl} title={fileName || "Dokument"} className="w-full h-full bg-white rounded-lg" />
          ) : (
            <div className="flex items-center gap-2 text-white/80">
              <Loader2 className="w-5 h-5 animate-spin" /> Načítání dokumentu…
            </div>
          )
        ) : (
          <div className="text-center text-white max-w-xs">
            <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="mb-5 text-sm opacity-80">Tento typ souboru nelze zobrazit přímo v aplikaci.</p>
            <a
              href={url}
              download={fileName || true}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-black rounded-lg font-medium"
            >
              <Download className="w-4 h-4" /> Stáhnout soubor
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
