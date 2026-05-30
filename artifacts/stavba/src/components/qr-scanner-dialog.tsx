import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Camera } from "lucide-react";

export function QrScannerDialog({
  open,
  onOpenChange,
  onResult,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    if (!video) return;

    setError(null);
    let cancelled = false;
    let handled = false;

    const scanner = new QrScanner(
      video,
      (result) => {
        if (cancelled || handled) return;
        handled = true;
        scanner.stop();
        onResult(result.data);
      },
      { highlightScanRegion: true, highlightCodeOutline: true, preferredCamera: "environment" },
    );
    scannerRef.current = scanner;

    scanner.start().catch(() => {
      if (!cancelled) setError("Nepodařilo se spustit kameru. Zkontrolujte oprávnění.");
    });

    return () => {
      cancelled = true;
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [open, onResult]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" /> Skenovat QR kód stroje
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive py-8 text-center">{error}</p>
        ) : (
          <div className="relative overflow-hidden rounded-lg bg-black aspect-square">
            <video ref={videoRef} className="w-full h-full object-cover" />
          </div>
        )}
        <p className="text-xs text-muted-foreground text-center">
          Namiřte kameru na QR kód stroje.
        </p>
      </DialogContent>
    </Dialog>
  );
}
