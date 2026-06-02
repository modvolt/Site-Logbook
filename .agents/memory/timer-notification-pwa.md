---
name: PWA ongoing timer notification
description: How the "časovač běží" persistent notification works in the Stavba PWA and its platform limits.
---

# Ongoing timer notification (Stavba PWA)

A persistent notification is shown while a job timer (`jobs.timerStartedAt`) runs,
via `serviceWorker.ready` → `reg.showNotification(tag:"stavba-timer", requireInteraction:true, silent:true)`.
Helper lib: `artifacts/stavba/src/lib/timer-notification.ts` (ensure/show/clear/sync).

**Why these choices:**
- It is NOT Web Push/VAPID. There is no server push; it's a local notification
  toggled by the client. The user only wanted a "timer is running" indicator, not
  event pushes — a local notification is enough and needs no backend/keys.
- iOS PWAs cannot do ongoing/persistent notifications (only installed PWAs on
  iOS 16.4+ get notifications at all, and they don't persist like Android). The
  crew is ~half iOS, so the feature is best-effort: every call is guarded by a
  support check + try/catch and silently no-ops on iOS.

**How to apply (don't regress these):**
- Request permission *synchronously inside the start click handler* and `await`
  it before calling show — `Notification.requestPermission()` needs user
  activation, and showing before the grant resolves is a race that drops the
  notification on first run.
- Show on start, clear on stop, in every start/stop handler (dashboard JobRow,
  dashboard ActiveTimerBanner, job-detail). Also clear on logout (layout.tsx)
  so a shared device doesn't keep a stale notification.
- Reconcile from server truth: dashboard `ActiveTimerBanner` runs a `syncTimerNotification`
  effect (show if a today-job runs, else clear). job-detail only *shows* (never
  clears) since it only knows one job and another job may be running.
