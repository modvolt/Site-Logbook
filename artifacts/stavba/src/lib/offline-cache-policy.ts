export const API_CACHE_PREFIX = "stavba-api-v2-";
export const LEGACY_API_CACHE_NAME = "stavba-api";

const OFFLINE_API_ALLOWLIST = [
  /^\/api\/jobs$/,
  /^\/api\/jobs\/calendar$/,
  /^\/api\/jobs\/\d+$/,
  /^\/api\/jobs\/\d+\/(?:completion-readiness|attachments|materials|tasks|time-entries|visits|work-sessions|work-summary)$/,
  /^\/api\/switchboards$/,
  /^\/api\/switchboards\/\d+$/,
  /^\/api\/switchboards\/\d+\/(?:checklist|operations)$/,
] as const;

export function isValidOfflineScope(scope: unknown): scope is string {
  return typeof scope === "string" && /^[a-f0-9]{64}$/.test(scope);
}

export function apiCacheName(scope: string): string {
  if (!isValidOfflineScope(scope)) {
    throw new Error("Invalid offline cache scope");
  }
  return `${API_CACHE_PREFIX}${scope}`;
}

/** Only the minimum field-work read model may be persisted for offline use. */
export function isOfflineCacheableApiPath(pathname: string): boolean {
  return OFFLINE_API_ALLOWLIST.some((pattern) => pattern.test(pathname));
}

export function isManagedApiCacheName(cacheName: string): boolean {
  return cacheName === LEGACY_API_CACHE_NAME || cacheName.startsWith(API_CACHE_PREFIX);
}
