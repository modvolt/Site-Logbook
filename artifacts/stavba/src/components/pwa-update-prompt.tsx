import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";
import { RefreshCw, X, CheckCircle2 } from "lucide-react";

// Shows a small banner when a new version of the app is available (prompt
// update flow) or when the app is ready to work offline. Choosing "Aktualizovat"
// activates the waiting service worker and reloads, so users never get stranded
// on stale assets.
export default function PwaUpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  if (!offlineReady && !needRefresh) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[100] flex justify-center p-4 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-sm rounded-xl border bg-card shadow-lg p-4 flex items-start gap-3">
        {needRefresh ? (
          <RefreshCw className="w-5 h-5 text-rose-600 mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          {needRefresh ? (
            <>
              <p className="text-sm font-medium">Nová verze je k dispozici</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Aktualizujte aplikaci, ať máte nejnovější funkce.
              </p>
              <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={() => updateServiceWorker(true)}>
                  Aktualizovat
                </Button>
                <Button size="sm" variant="ghost" onClick={close}>
                  Později
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm font-medium">
              Aplikace je připravena k použití offline.
            </p>
          )}
        </div>
        <button
          onClick={close}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label="Zavřít"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
