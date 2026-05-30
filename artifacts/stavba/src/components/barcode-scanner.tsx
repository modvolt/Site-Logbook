import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScanLine, AlertTriangle } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (text: string) => void;
};

/**
 * Camera-based barcode/QR scanner used to read a device serial number (SN)
 * from a printed label. Uses ZXing to decode 1D/2D codes from the live video
 * stream of the rear ("environment") camera.
 */
export function BarcodeScanner({ open, onOpenChange, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    let cancelled = false;
    const reader = new BrowserMultiFormatReader();

    (async () => {
      try {
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current ?? undefined,
          (result) => {
            if (result && !cancelled) {
              const text = result.getText().trim();
              if (text) {
                onResult(text);
                onOpenChange(false);
              }
            }
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error && err.name === "NotAllowedError"
              ? "Přístup ke kameře byl zamítnut. Povolte kameru v prohlížeči."
              : "Kameru se nepodařilo spustit. Zkontrolujte oprávnění a zkuste to znovu.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [open, onOpenChange, onResult]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary" /> Naskenovat SN
          </DialogTitle>
          <DialogDescription>
            Namiřte fotoaparát na čárový/QR kód se sériovým číslem zařízení.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <AlertTriangle className="h-8 w-8 text-amber-500" />
            <p>{error}</p>
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-lg bg-black aspect-[4/3]">
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              muted
              playsInline
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-1/2 w-4/5 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
