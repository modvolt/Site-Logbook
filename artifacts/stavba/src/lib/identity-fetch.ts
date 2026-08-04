import { isValidOfflineScope } from "@/lib/offline-cache-policy";

const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";
const AUTH_INVALIDATED_EVENT = "stavba:auth-invalidated";

const PUBLIC_API_ROUTES: ReadonlyArray<{ methods: ReadonlySet<string>; path: RegExp }> = [
  { methods: new Set(["GET", "HEAD"]), path: /^\/api\/healthz$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/api\/auth\/me$/ },
  { methods: new Set(["POST"]), path: /^\/api\/auth\/(?:login|logout|setup)$/ },
  { methods: new Set(["POST"]), path: /^\/api\/auth\/webauthn\/login\/(?:begin|complete)$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/api\/storage\/public-objects\/.+$/ },
  { methods: new Set(["GET", "HEAD", "POST"]), path: /^\/api\/(?:ppe\/sign|sign)\/[^/]+$/ },
  { methods: new Set(["GET", "HEAD", "POST"]), path: /^\/api\/ppe\/confirm$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/api\/quotes\/public\/[^/]+$/ },
  { methods: new Set(["POST"]), path: /^\/api\/quotes\/public\/[^/]+\/(?:accept|reject)$/ },
  { methods: new Set(["GET", "HEAD"]), path: /^\/api\/q\/board\/[^/]+(?:\/documents\/[^/]+)?$/ },
  { methods: new Set(["POST"]), path: /^\/api\/internal\/backup-trigger$/ },
];

let activeScope: string | null = null;
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

function isPublicApiRequest(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_API_ROUTES.some(
    (route) => route.methods.has(method) && route.path.test(normalized),
  );
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
    } | null;
    if (body?.authenticated && isValidOfflineScope(body.offlineScope)) {
      activeScope = body.offlineScope;
    } else {
      activeScope = null;
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
      if (transitionActive || !activeScope) throw new IdentityTransitionError(url.pathname);
      [guardedInput, guardedInit] = withScopeHeader(input, init, activeScope);
    }

    const response = await nativeFetch(guardedInput, guardedInit);
    if (isSameOriginApi) await observeIdentityResponse(url, response);
    return response;
  };
}

/** Synchronous identity boundary used before any cookie-changing request. */
export function beginIdentityRequestTransition(): void {
  activeScope = null;
  transitionActive = true;
}

/** The transition message completed; private traffic still waits for /auth/me. */
export function completeIdentityRequestTransition(): void {
  transitionActive = false;
}

/** Reinforce the scope learned from /auth/me after React Query publishes it. */
export function setIdentityRequestScope(scope: string | null): void {
  activeScope = isValidOfflineScope(scope) ? scope : null;
  if (activeScope) transitionActive = false;
}

export function identityFetchStateForTest(): { scope: string | null; transitionActive: boolean } {
  return { scope: activeScope, transitionActive };
}
