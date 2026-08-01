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

function strategyForScope(scope: string): NetworkFirst {
  const existing = scopedStrategies.get(scope);
  if (existing) return existing;
  const strategy = new NetworkFirst({
    cacheName: apiCacheName(scope),
    networkTimeoutSeconds: 5,
    plugins: [
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
    self.skipWaiting();
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
    if (sourceId) clientScopes.delete(sourceId);
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

// Cache only the explicit field-work read model, partitioned by the opaque
// user + authorization epoch supplied by /api/auth/me. Auth, vault, billing,
// storage objects and every unknown/future API path are always network-only.
registerRoute(
  ({ url, request, sameOrigin }: { url: URL; request: Request; sameOrigin: boolean }) =>
    sameOrigin && request.method === "GET" && isOfflineCacheableApiPath(url.pathname),
  async (options) => {
    const event = options.event as FetchEvent;
    const scope = event.clientId ? clientScopes.get(event.clientId) : undefined;
    if (!scope) {
      if (event.clientId) {
        const client = await self.clients.get(event.clientId);
        client?.postMessage({ type: "REQUEST_IDENTITY_SCOPE" });
      }
      return fetch(options.request, { cache: "no-store" });
    }
    return strategyForScope(scope).handle(options);
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
