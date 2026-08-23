import { isValidOfflineScope } from "./offline-cache-policy";
import { isPublicApiRequest } from "./public-api-policy";

const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";
const IDEMPOTENCY_HEADER = "idempotency-key";
const CONTENT_SHA256_HEADER = "x-stavba-content-sha256";
const AUTH_INVALIDATED_EVENT = "stavba:auth-invalidated";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let activeScope: string | null = null;
let networkOnlyIdentity = false;
let transitionActive = false;
let installed = false;
let identityRevision = 0;

export class IdentityTransitionError extends Error {
  readonly name = "IdentityTransitionError";

  constructor(path: string) {
    super(`API request blocked while identity is unverified: ${path}`);
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.method.toUpperCase();
  return "GET";
}

function requestUrl(input: RequestInfo | URL): URL {
  const value =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return new URL(value, window.location.href);
}

function mergedHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  const inputHeaders =
    typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined;
  const headers = new Headers(inputHeaders);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function binaryBodyBytes(
  body: BodyInit | null | undefined,
): Promise<Uint8Array> | null {
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(body));
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return Promise.resolve(bytes);
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    digestInput.buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function withPrivateHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string,
  scope: string | null,
): Promise<[RequestInfo | URL, RequestInit]> {
  const headers = mergedHeaders(input, init);
  if (scope) headers.set(OFFLINE_SCOPE_HEADER, scope);

  if (MUTATION_METHODS.has(method)) {
    if (!headers.has(IDEMPOTENCY_HEADER)) {
      headers.set(IDEMPOTENCY_HEADER, globalThis.crypto.randomUUID());
    }
    if (headers.has("content-type") && !headers.has(CONTENT_SHA256_HEADER)) {
      const bodyBytes = binaryBodyBytes(init?.body);
      if (bodyBytes) {
        headers.set(CONTENT_SHA256_HEADER, await sha256Hex(await bodyBytes));
      }
    }
  }

  return [input, { ...init, headers }];
}

async function observeIdentityResponse(
  url: URL,
  response: Response,
): Promise<void> {
  if (url.pathname === "/api/auth/me" && response.ok) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
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
    identityRevision += 1;
    return;
  }

  if (response.status !== 409 && response.status !== 428) return;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  if (
    body?.code !== "offline_scope_mismatch" &&
    body?.code !== "identity_scope_required"
  )
    return;
  beginIdentityRequestTransition();
  queueMicrotask(() => window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT)));
}

/** Install before React mounts so every same-origin API fetch shares one guard. */
export function installIdentityFetchGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const isSameOriginApi =
      url.origin === window.location.origin && url.pathname.startsWith("/api/");
    let guardedInput = input;
    let guardedInit = init;

    if (isSameOriginApi && !isPublicApiRequest(method, url.pathname)) {
      if (transitionActive || (!activeScope && !networkOnlyIdentity)) {
        throw new IdentityTransitionError(url.pathname);
      }
      const guardedIdentityRevision = identityRevision;
      [guardedInput, guardedInit] = await withPrivateHeaders(
        input,
        init,
        method,
        activeScope,
      );
      if (transitionActive || identityRevision !== guardedIdentityRevision) {
        throw new IdentityTransitionError(url.pathname);
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
  identityRevision += 1;
}

/** The transition message completed; private traffic still waits for /auth/me. */
export function completeIdentityRequestTransition(): void {
  transitionActive = false;
  identityRevision += 1;
}

/** Reinforce the scope learned from /auth/me after React Query publishes it. */
export function setIdentityRequestScope(
  scope: string | null,
  networkOnly = false,
): void {
  activeScope = isValidOfflineScope(scope) ? scope : null;
  networkOnlyIdentity = !activeScope && networkOnly;
  if (activeScope || networkOnlyIdentity) transitionActive = false;
  identityRevision += 1;
}

export function identityFetchStateForTest(): {
  scope: string | null;
  networkOnly: boolean;
  transitionActive: boolean;
} {
  return {
    scope: activeScope,
    networkOnly: networkOnlyIdentity,
    transitionActive,
  };
}
