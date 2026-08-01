import {
  apiCacheName,
  isManagedApiCacheName,
  isValidOfflineScope,
} from "@/lib/offline-cache-policy";

// Lightweight debug logger for PWA / auth diagnostics. Logs are namespaced so
// they're easy to filter in the browser console (filter by "[stavba]"). Kept on
// in production on purpose — they're cheap and invaluable when debugging a
// stuck-on-login or stale-cache report from a phone in the field.
export function debugLog(scope: string, message: string, ...rest: unknown[]): void {
  if (typeof console === "undefined") return;
  // eslint-disable-next-line no-console
  console.info(`[stavba:${scope}] ${message}`, ...rest);
}

// Clears every managed identity-scoped API cache. Devices are shared between
// crew members, so logout must ensure one user's data cannot be served to the
// next user while offline. Best-effort and a no-op when Cache Storage is
// unavailable (e.g. dev or unsupported browsers).
export async function clearApiCache(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_IDENTITY_SCOPE" });
    const registration = await navigator.serviceWorker?.getRegistration();
    registration?.active?.postMessage({ type: "CLEAR_IDENTITY_SCOPE" });
  } catch {
    // Continue with direct Cache Storage cleanup.
  }
  try {
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter(isManagedApiCacheName).map((key) => caches.delete(key)));
  } catch {
    // Ignore — the next identity activation repeats the purge.
  }
}

export async function activateApiCacheScope(scope: string): Promise<void> {
  if (typeof window === "undefined" || !isValidOfflineScope(scope)) return;
  const keepName = apiCacheName(scope);
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => isManagedApiCacheName(key) && key !== keepName)
          .map((key) => caches.delete(key)),
      );
    }
  } catch {
    // The service worker repeats the purge after receiving the scope.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "SET_IDENTITY_SCOPE", scope });
    const registration = await navigator.serviceWorker?.getRegistration();
    registration?.active?.postMessage({ type: "SET_IDENTITY_SCOPE", scope });
  } catch {
    // Without a confirmed scope the service worker falls back to network-only.
  }
}

// Full app recovery for when a device is stuck on a stale cached version (the
// classic "I see the old version / login won't go away" PWA problem). Deletes
// every Cache Storage entry, unregisters all service workers, then hard-reloads
// so the next load fetches a fresh shell from the network. Best-effort: any step
// that fails is ignored so we always reach the reload.
export async function hardRefreshApp(): Promise<void> {
  debugLog("pwa", "hardRefreshApp: clearing caches + unregistering SWs");
  if (typeof window === "undefined") return;
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // ignore — best effort
  }
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
  } catch {
    // ignore — best effort
  }
  // Reload from the server, bypassing the bfcache.
  window.location.reload();
}
