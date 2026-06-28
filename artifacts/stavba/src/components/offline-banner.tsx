import { useState } from "react";
import { WifiOff, CloudUpload, AlertTriangle, X } from "lucide-react";
import { useOfflineQueue } from "@/hooks/use-offline-queue";
import { OfflineFailedDialog } from "@/components/offline-failed-dialog";

export function OfflineBanner() {
  const { isOnline, pendingCount, failedCount, isFlushing } = useOfflineQueue();
  const [showFailed, setShowFailed] = useState(false);

  const showBanner = !isOnline || pendingCount > 0 || failedCount > 0;
  if (!showBanner) return null;

  return (
    <>
      <div className="sticky top-0 z-50 w-full">
        {/* Offline / pending banner */}
        {(!isOnline || pendingCount > 0) && (
          <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-amber-500 text-white">
            {isFlushing ? (
              <CloudUpload className="w-4 h-4 shrink-0 animate-pulse" />
            ) : (
              <WifiOff className="w-4 h-4 shrink-0" />
            )}
            <span className="flex-1 min-w-0 truncate">
              {isFlushing
                ? "Odesílám offline akce…"
                : !isOnline && pendingCount > 0
                ? `Offline – ${pendingCount} ${pendingCount === 1 ? "akce čeká" : "akcí čeká"} na odeslání`
                : !isOnline
                ? "Pracujete offline"
                : `${pendingCount} ${pendingCount === 1 ? "akce čeká" : "akcí čeká"} na odeslání…`}
            </span>
          </div>
        )}

        {/* Failed ops banner */}
        {failedCount > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1 min-w-0 truncate">
              {failedCount} {failedCount === 1 ? "akce se nepodařila" : "akcí se nepodařilo"} odeslat
            </span>
            <button
              onClick={() => setShowFailed(true)}
              className="shrink-0 underline underline-offset-2 hover:no-underline text-sm"
            >
              Zobrazit
            </button>
            <button
              onClick={() => setShowFailed(true)}
              className="shrink-0 p-0.5 rounded hover:bg-white/20"
              aria-label="Zobrazit chybné akce"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <OfflineFailedDialog open={showFailed} onClose={() => setShowFailed(false)} />
    </>
  );
}
