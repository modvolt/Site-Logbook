import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";
import { RefreshCw, X, CheckCircle2 } from "lucide-react";
import { debugLog } from "@/lib/pwa";

// How often to ask the browser to check for a new service worker (a new app
// version). Phones left open all day on a site would otherwise never notice a
// deploy until they're fully closed and reopened.
const SW_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Guard so the periodic update poller is started at most once for the page's
// lifetime, even if the SW registration callback fires again (re-registration /
// dev HMR). Prevents accumulating duplicate timers.
let updatePollerStarted = false;

// Shows a small banner when a new version of the app is available (prompt
// update flow) or when the app is ready to work offline. Choosing "Aktualizovat"
// activates the waiting service worker and reloads, so users never get stranded
// on stale assets.
export default function PwaUpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      debugLog("sw", `registered: ${swUrl}`);
      if (!registration || updatePollerStarted) return;
      updatePollerStarted = true;
      // Periodically poll for a new deployed version so long-lived sessions
      // (a phone open all day) still pick up updates.
      setInterval(() => {
        debugLog("sw", "periodic update check");
        registration.update().catch(() => {
          /* offline / transient — ignore, will retry next interval */
        });
      }, SW_UPDATE_CHECK_INTERVAL_MS);
    },
    onRegisterError(error) {
      debugLog("sw", "registration failed", error);
    },
    onNeedRefresh() {
      debugLog("sw", "new version available (needRefresh)");
    },
    onOfflineReady() {
      debugLog("sw", "app ready to work offline");
    },
  });

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
