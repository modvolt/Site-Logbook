import { isValidOfflineScope } from "@/lib/offline-cache-policy";
import { isPublicApiRequest } from "@/lib/public-api-policy";

const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";
const AUTH_INVALIDATED_EVENT = "stavba:auth-invalidated";

let activeScope: string | null = null;
let networkOnlyIdentity = false;
let transitionActive = false;
let installed = false;

export class IdentityTransitionError extends Error {
  readonly name = "IdentityTransitionError";

  constructor(path: string) {
    super(`API request blocked while identity is unverified: ${path}`);
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function requestUrl(input: RequestInfo | URL): URL {
  const value = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  return new URL(value, window.location.href);
}

function withScopeHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  scope: string,
): [RequestInfo | URL, RequestInit | undefined] {
  const inputHeaders = typeof Request !== "undefined" && input instanceof Request
    ? input.headers
    : undefined;
  const headers = new Headers(inputHeaders);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  headers.set(OFFLINE_SCOPE_HEADER, scope);
  return [input, { ...init, headers }];
}

async function observeIdentityResponse(url: URL, response: Response): Promise<void> {
  if (url.pathname === "/api/auth/me" && response.ok) {
    const body = await response.clone().json().catch(() => null) as {
      authenticated?: boolean;
      offlineScope?: unknown;
      cacheMode?: unknown;
    } | null;
    if (body?.authenticated && isValidOfflineScope(body.offlineScope)) {
      activeScope = body.offlineScope;
      networkOnlyIdentity = false;
    } else if (body?.authenticated && body.cacheMode === "network-only") {
      activeScope = null;
      networkOnlyIdentity = true;
    } else {
      activeScope = null;
      networkOnlyIdentity = false;
    }
    transitionActive = false;
    return;
  }

  if (response.status !== 409 && response.status !== 428) return;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  if (body?.code !== "offline_scope_mismatch" && body?.code !== "identity_scope_required") return;
  beginIdentityRequestTransition();
  queueMicrotask(() => window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT)));
}

/** Install before React mounts so every same-origin API fetch shares one guard. */
export function installIdentityFetchGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const isSameOriginApi = url.origin === window.location.origin && url.pathname.startsWith("/api/");
    let guardedInput = input;
    let guardedInit = init;

    if (isSameOriginApi && !isPublicApiRequest(method, url.pathname)) {
      if (transitionActive || (!activeScope && !networkOnlyIdentity)) {
        throw new IdentityTransitionError(url.pathname);
      }
      if (activeScope) {
        [guardedInput, guardedInit] = withScopeHeader(input, init, activeScope);
      }
    }

    const response = await nativeFetch(guardedInput, guardedInit);
    if (isSameOriginApi) await observeIdentityResponse(url, response);
    return response;
  };
}

/** Synchronous identity boundary used before any cookie-changing request. */
export function beginIdentityRequestTransition(): void {
  activeScope = null;
  networkOnlyIdentity = false;
  transitionActive = true;
}

/** The transition message completed; private traffic still waits for /auth/me. */
export function completeIdentityRequestTransition(): void {
  transitionActive = false;
}

/** Reinforce the scope learned from /auth/me after React Query publishes it. */
export function setIdentityRequestScope(
  scope: string | null,
  networkOnly = false,
): void {
  activeScope = isValidOfflineScope(scope) ? scope : null;
  networkOnlyIdentity = !activeScope && networkOnly;
  if (activeScope || networkOnlyIdentity) transitionActive = false;
}

export function identityFetchStateForTest(): { scope: string | null; networkOnly: boolean; transitionActive: boolean } {
  return { scope: activeScope, networkOnly: networkOnlyIdentity, transitionActive };
}
