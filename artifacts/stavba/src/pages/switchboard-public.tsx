import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CircuitBoard,
  ExternalLink,
  FileText,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicGrantToken } from "@/lib/public-grant-bootstrap";
import { publicGrantFetch } from "@/lib/public-grant-fetch";

type PublicDocument = {
  sha256: string;
  documentType: string;
  version: number;
  originalFileName: string;
  uploadedAt: string;
};

type PublicBoard = {
  designation: string;
  serialNumber: string | null;
  manufacturer: string;
  productionDate: string | null;
  documentationStatus: string;
  contact: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  publicDocuments: PublicDocument[];
};

export default function SwitchboardPublic() {
  const hasGrant = useRef(publicGrantToken("switchboard") !== null).current;
  const [data, setData] = useState<PublicBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    if (!hasGrant) {
      setError("Otevřete původní QR odkaz znovu.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void publicGrantFetch("switchboard", "/api/q/board", {
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "QR odkaz se nepodařilo načíst.");
      }
      setData(body);
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "QR odkaz se nepodařilo načíst.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [hasGrant]);

  async function openDocument(item: PublicDocument): Promise<void> {
    if (downloading) return;
    setDownloading(item.sha256);
    setError(null);
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    let blobUrl: string | null = null;
    let handedOff = false;
    try {
      const response = await publicGrantFetch(
        "switchboard",
        `/api/q/board/documents/${item.sha256}`,
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Dokument není dostupný.");
      }
      blobUrl = URL.createObjectURL(await response.blob());
      if (popup) {
        popup.location.replace(blobUrl);
      } else {
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = item.originalFileName;
        link.rel = "noreferrer";
        link.click();
      }
      handedOff = true;
      const handedOffBlobUrl = blobUrl;
      window.setTimeout(() => URL.revokeObjectURL(handedOffBlobUrl), 60_000);
    } catch (reason) {
      popup?.close();
      setError(reason instanceof Error ? reason.message : "Dokument není dostupný.");
    } finally {
      if (blobUrl && !handedOff) URL.revokeObjectURL(blobUrl);
      setDownloading(null);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-neutral-100 text-neutral-900">
      <header className="bg-white border-b px-4 py-3">
        <div className="max-w-xl mx-auto flex items-center gap-2">
          <CircuitBoard className="h-6 w-6 text-cyan-700" />
          <span className="font-bold">Dokumentace rozvaděče</span>
        </div>
      </header>
      <div className="max-w-xl mx-auto p-4 space-y-4">
        {loading && (
          <div className="py-20 text-center text-sm text-neutral-500">
            Načítám dokumentaci…
          </div>
        )}
        {error && (
          <div className="border border-red-200 bg-red-50 p-6 text-center">
            <AlertCircle className="h-10 w-10 mx-auto text-red-600 mb-2" />
            <div className="font-semibold">Odkaz nebo dokument není dostupný</div>
            <p className="text-sm text-neutral-600 mt-1">{error}</p>
          </div>
        )}
        {data && (
          <>
            <section className="bg-white border p-5">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-7 w-7 text-emerald-600" />
                <div>
                  <h1 className="text-2xl font-bold">{data.designation}</h1>
                  <p className="text-sm text-neutral-500">{data.manufacturer}</p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mt-5">
                <dt className="text-neutral-500">Výrobní číslo</dt>
                <dd className="font-medium">{data.serialNumber || "—"}</dd>
                <dt className="text-neutral-500">Datum výroby</dt>
                <dd>{data.productionDate || "—"}</dd>
                <dt className="text-neutral-500">Dokumentace</dt>
                <dd>{data.documentationStatus === "completed" ? "Zkontrolována" : "Ve zpracování"}</dd>
              </dl>
            </section>
            {data.publicDocuments.length > 0 && (
              <section className="bg-white border">
                <div className="px-4 py-3 border-b font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4" />Veřejné dokumenty
                </div>
                <div className="divide-y">
                  {data.publicDocuments.map((item) => (
                    <button
                      key={`${item.sha256}-${item.version}`}
                      type="button"
                      onClick={() => void openDocument(item)}
                      disabled={downloading !== null}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-neutral-50 disabled:opacity-60"
                    >
                      {downloading === item.sha256
                        ? <Loader2 className="h-5 w-5 text-neutral-500 animate-spin" />
                        : <FileText className="h-5 w-5 text-neutral-500" />}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{item.originalFileName}</div>
                        <div className="text-xs text-neutral-500">Verze {item.version}</div>
                      </div>
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="bg-white border p-4 text-sm">
              <div className="font-semibold">Kontakt</div>
              <div className="mt-1 text-neutral-600">{data.contact.name}</div>
              {data.contact.address && <div>{data.contact.address}</div>}
              {data.contact.phone && <div>{data.contact.phone}</div>}
              {data.contact.email && (
                <Button variant="outline" size="sm" className="mt-3" asChild>
                  <a href={`mailto:${data.contact.email}`}>Napsat e-mail</a>
                </Button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
