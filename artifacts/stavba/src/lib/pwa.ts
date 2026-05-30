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
