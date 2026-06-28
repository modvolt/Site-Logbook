---
name: PWA injectManifest update button (SKIP_WAITING)
description: Why the "Aktualizovat"/update prompt button silently does nothing with vite-plugin-pwa injectManifest + prompt mode.
---

# PWA injectManifest needs a SKIP_WAITING message handler

With `vite-plugin-pwa` `strategies:"injectManifest"` + `registerType:"prompt"`
(custom `sw.ts`), the "new version available" prompt's update button calls
`updateServiceWorker(true)`. Under the hood (vite-plugin-pwa 1.3.0) that goes
through `workbox-window`'s `messageSkipWaiting()`, which posts
`{ type: "SKIP_WAITING" }` to `registration.waiting` and reloads the page on the
Workbox `controlling` event.

**The custom service worker MUST handle that message itself** — injectManifest
does NOT inject a skip-waiting handler (only `generateSW`/autoUpdate does). Required:

```ts
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
```

**Why:** without it the waiting worker never activates, `controllerchange`/
`controlling` never fires, no reload happens, and the update button appears
completely dead even though the prompt shows. `clientsClaim()` alone is NOT
enough — it only matters once the worker activates, which requires skipWaiting.

**How to apply:** the handler lives in the NEW (waiting) worker, so the fix is
self-healing — it works the first time a user updates ONTO the fixed version.
But a device already stuck with a pre-fix worker in `waiting` can't respond; it
needs one more update poll / app reopen / hard-refresh (see `hardRefreshApp()` in
`src/lib/pwa.ts`) before the fixed worker takes over. After that the button works.
