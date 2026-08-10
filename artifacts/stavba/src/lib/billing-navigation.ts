const BILLING_BASE_URL = "https://billing-navigation.invalid";
const BILLING_SCROLL_KEY_PREFIX = "stavba:billing-scroll:";
const BILLING_SCROLL_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_RETURN_TO_LENGTH = 4096;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type BillingScrollSnapshot = {
  y: number;
  savedAt: number;
};

function relativeUrl(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildBillingLocation(pathname: string, search: string): string {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  return `${pathname}${normalizedSearch ? `?${normalizedSearch}` : ""}`;
}

export function sanitizeBillingReturnTo(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (
    !candidate ||
    candidate.length > MAX_RETURN_TO_LENGTH ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//")
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, BILLING_BASE_URL);
    if (
      parsed.origin !== BILLING_BASE_URL ||
      !/^\/billing(?:\/|$)/.test(parsed.pathname)
    ) {
      return fallback;
    }
    return relativeUrl(parsed);
  } catch {
    return fallback;
  }
}

export function readBillingReturnTo(search: string, fallback: string): string {
  const params = new URLSearchParams(search);
  return sanitizeBillingReturnTo(params.get("returnTo"), fallback);
}

export function withBillingReturnTo(target: string, returnTo: string): string {
  const parsedTarget = new URL(target, BILLING_BASE_URL);
  const safeReturnTo = sanitizeBillingReturnTo(returnTo, "/billing");
  parsedTarget.searchParams.set("returnTo", safeReturnTo);
  return relativeUrl(parsedTarget);
}

function billingScrollKey(location: string): string {
  return `${BILLING_SCROLL_KEY_PREFIX}${encodeURIComponent(location)}`;
}

export function saveBillingScroll(
  storage: SessionStorageLike,
  location: string,
  scrollY: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(scrollY) || scrollY < 0) return;
  const snapshot: BillingScrollSnapshot = {
    y: Math.round(scrollY),
    savedAt: now,
  };
  storage.setItem(billingScrollKey(location), JSON.stringify(snapshot));
}

export function readBillingScroll(
  storage: SessionStorageLike,
  location: string,
  now = Date.now(),
): number | null {
  const key = billingScrollKey(location);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<BillingScrollSnapshot>;
    if (
      typeof parsed.y !== "number" ||
      !Number.isFinite(parsed.y) ||
      parsed.y < 0 ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      now - parsed.savedAt > BILLING_SCROLL_TTL_MS ||
      parsed.savedAt > now + 60_000
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed.y;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearBillingScroll(
  storage: SessionStorageLike,
  location: string,
): void {
  storage.removeItem(billingScrollKey(location));
}
