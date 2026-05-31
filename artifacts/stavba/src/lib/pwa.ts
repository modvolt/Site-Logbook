// Lightweight debug logger for PWA / auth diagnostics. Logs are namespaced so
// they're easy to filter in the browser console (filter by "[stavba]"). Kept on
// in production on purpose — they're cheap and invaluable when debugging a
// stuck-on-login or stale-cache report from a phone in the field.
export function debugLog(scope: string, message: string, ...rest: unknown[]): void {
  if (typeof console === "undefined") return;
  // eslint-disable-next-line no-console
  console.info(`[stavba:${scope}] ${message}`, ...rest);
}

// Clears the service-worker runtime cache that may hold authenticated API
// responses ("stavba-api"). Devices are shared between crew members, so we
// purge cached data on logout to ensure one user's data can't be served from
// cache to the next user while offline. Best-effort and a no-op when the Cache
// Storage API is unavailable (e.g. dev, unsupported browsers).
export async function clearApiCache(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.includes("stavba-api"))
        .map((key) => caches.delete(key)),
    );
  } catch {
    // Ignore — cache clearing is a best-effort safeguard.
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
