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

declare let self: ServiceWorkerGlobalScope;

// SyncEvent is not in lib.webworker — declare minimally for Background Sync API.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

clientsClaim();

// Inject precache manifest (replaced by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback: serve index.html for all non-API navigations.
// import.meta.env.BASE_URL is replaced by Vite at build time (e.g. "/").
const navHandler = createHandlerBoundToURL(import.meta.env.BASE_URL + "index.html");
const navRoute = new NavigationRoute(navHandler, {
  denylist: [/^\/api\//],
});
registerRoute(navRoute);

// NetworkFirst for GET /api/* — excludes the SSE stream (/api/events)
// which must never be cached or cloned by the service worker.
registerRoute(
  ({ url, request }: { url: URL; request: Request }) =>
    url.pathname.startsWith("/api/") &&
    url.pathname !== "/api/events" &&
    request.method === "GET",
  new NetworkFirst({
    cacheName: "stavba-api",
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 }),
    ],
  }),
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
