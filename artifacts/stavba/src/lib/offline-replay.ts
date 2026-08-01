import type { OfflineOwner } from "@/lib/offline-queue";

export type OfflineReplayIdentityResult =
  | "verified"
  | "unauthenticated"
  | "scope_mismatch"
  | "unavailable";

interface MeResponse {
  authenticated?: boolean;
  offlineScope?: string;
  user?: { id?: number };
}

/**
 * Re-check the authoritative online identity immediately before replay. This
 * request bypasses both HTTP and service-worker caches.
 */
export async function verifyOfflineReplayIdentity(
  owner: OfflineOwner,
  fetcher: typeof fetch = fetch,
): Promise<OfflineReplayIdentityResult> {
  try {
    const response = await fetcher("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401) return "unauthenticated";
    if (!response.ok) return "unavailable";
    const data = (await response.json()) as MeResponse;
    if (!data.authenticated || !data.user) return "unauthenticated";
    return data.user.id === owner.userId && data.offlineScope === owner.scope
      ? "verified"
      : "scope_mismatch";
  } catch {
    return "unavailable";
  }
}
