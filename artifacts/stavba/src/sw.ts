/// <reference lib="webworker" />
/// <reference types="vite-plugin-pwa/client" />

import { clientsClaim } from "workbox-core";
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
  apiCacheName,
  API_CACHE_PREFIX,
  isManagedApiCacheName,
  isOfflineCacheableApiPath,
  isValidOfflineScope,
} from "./lib/offline-cache-policy";

declare let self: ServiceWorkerGlobalScope;

const clientScopes = new Map<string, string>();
const scopedStrategies = new Map<string, NetworkFirst>();
const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";

function requestWithScope(request: Request, scope: string): Request {
  const headers = new Headers(request.headers);
  headers.set(OFFLINE_SCOPE_HEADER, scope);
  return new Request(request, { headers });
}

function eventClientId(event?: ExtendableEvent): string | undefined {
  const fetchEvent = event as FetchEvent | undefined;
  return fetchEvent?.clientId || fetchEvent?.resultingClientId || undefined;
}

async function enforceResponseScopeBeforeDelivery(
  scope: string,
  response: Response,
  event?: ExtendableEvent,
): Promise<Response> {
  if (response.status !== 200) return response;
  const responseScope = response.headers.get(OFFLINE_SCOPE_HEADER);
  if (responseScope === scope) return response;

  // Never deliver the response body to a client whose proven scope differs.
  // A missing header means an old API is serving a new SW and also fails closed.
  const clientId = eventClientId(event);
  if (clientId) {
    clientScopes.delete(clientId);
    const client = await self.clients.get(clientId);
    client?.postMessage({
      type: "AUTH_SCOPE_MISMATCH",
      reason: responseScope ? "mismatch" : "missing-response-scope",
    });
  }
  await purgeApiCaches();
  return new Response(JSON.stringify({
    error: responseScope ? "Offline identity changed" : "Identity scope required",
    code: responseScope ? "offline_scope_mismatch" : "identity_scope_required",
  }), {
    status: responseScope ? 409 : 428,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function strategyForScope(scope: string): NetworkFirst {
  const existing = scopedStrategies.get(scope);
  if (existing) return existing;
  const strategy = new NetworkFirst({
    cacheName: apiCacheName(scope),
    networkTimeoutSeconds: 5,
    plugins: [
      {
        fetchDidSucceed: ({ response, event }) =>
          enforceResponseScopeBeforeDelivery(scope, response, event),
      },
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 }),
    ],
  });
  scopedStrategies.set(scope, strategy);
  return strategy;
}

async function purgeApiCaches(keepScope?: string): Promise<void> {
  const keepName = keepScope ? apiCacheName(keepScope) : null;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isManagedApiCacheName(name) && name !== keepName)
      .map((name) => caches.delete(name)),
  );
}

// SyncEvent is not in lib.webworker — declare minimally for Background Sync API.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

clientsClaim();

// Prompt-update flow (registerType: "prompt"): when the user clicks
// "Aktualizovat", the page calls updateServiceWorker(true), which posts a
// SKIP_WAITING message to THIS waiting worker. In injectManifest mode that
// message is NOT handled automatically — without this listener the waiting
// worker never activates, "controllerchange" never fires, and the page never
// reloads, so the update button appears to do nothing. We must skipWaiting()
// ourselves to activate immediately and let the client reload onto the new SW.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  const sourceId = (event.source as Client | null)?.id;
  if (event.data?.type === "SET_IDENTITY_SCOPE" && sourceId) {
    const scope = event.data.scope;
    if (!isValidOfflineScope(scope)) {
      clientScopes.delete(sourceId);
      event.waitUntil(purgeApiCaches());
      return;
    }
    clientScopes.set(sourceId, scope);
    event.waitUntil(purgeApiCaches(scope));
    return;
  }

  if (event.data?.type === "CLEAR_IDENTITY_SCOPE") {
    // Session cookies are origin-wide, not tab-local. One tab logging out or
    // changing identity invalidates every remembered client mapping.
    clientScopes.clear();
    event.waitUntil(purgeApiCaches());
  }
});

// Inject precache manifest (replaced by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Remove the pre-partitioning runtime cache on activation. Scoped v2 caches
// remain unreachable until a controlled client proves its current scope.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name === "stavba-api" || (name.startsWith("stavba-api-") && !name.startsWith(API_CACHE_PREFIX)))
          .map((name) => caches.delete(name)),
      ),
    ),
  );
});

// SPA navigation fallback: serve index.html for all non-API navigations.
// import.meta.env.BASE_URL is replaced by Vite at build time (e.g. "/").
const navHandler = createHandlerBoundToURL(import.meta.env.BASE_URL + "index.html");
const navRoute = new NavigationRoute(navHandler, {
  denylist: [/^\/api\//],
});
registerRoute(navRoute);

// Bind every controlled API request to the tab's proven identity epoch. Only
// the explicit field-work read model is cached; every other endpoint remains
// network-only but receives the same server-verifiable scope header.
registerRoute(
  ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
    sameOrigin && url.pathname.startsWith("/api/") && url.pathname !== "/api/events",
  async (options) => {
    const event = options.event as FetchEvent;
    const clientId = eventClientId(event);
    const scope = clientId ? clientScopes.get(clientId) : undefined;
    if (!scope) {
      if (clientId) {
        const client = await self.clients.get(clientId);
        client?.postMessage({ type: "REQUEST_IDENTITY_SCOPE" });
      }
      return fetch(options.request);
    }
    const scopedRequest = requestWithScope(options.request, scope);
    if (scopedRequest.method === "GET" && isOfflineCacheableApiPath(new URL(scopedRequest.url).pathname)) {
      return strategyForScope(scope).handle({ ...options, request: scopedRequest });
    }
    const response = await fetch(scopedRequest);
    if (scopedRequest.method !== "GET" && scopedRequest.method !== "HEAD") return response;
    return enforceResponseScopeBeforeDelivery(scope, response, event);
  },
);

// Background Sync: when the browser fires the "offline-flush" sync tag,
// notify all open app windows so they flush their IndexedDB queue.
// The actual flush logic stays in the main-thread OfflineQueueProvider;
// the SW only acts as a reliable wake-up signal.
self.addEventListener("sync", (event) => {
  const syncEvent = event as SyncEvent;
  if (syncEvent.tag === "offline-flush") {
    syncEvent.waitUntil(
      self.clients.matchAll({ type: "window" }).then((openClients) => {
        for (const client of openClients) {
          client.postMessage({ type: "OFFLINE_FLUSH" });
        }
      }),
    );
  }
});
