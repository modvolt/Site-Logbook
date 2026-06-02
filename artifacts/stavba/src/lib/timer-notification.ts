/**
 * Ongoing "timer running" notification for the installable PWA.
 *
 * Shows a persistent notification in the phone's notification shade while a job
 * timer is running, so workers see at a glance that time is being measured even
 * when the app is in the background.
 *
 * Platform support is uneven:
 *  - Android (installed PWA / Chrome): works, the notification stays in the
 *    shade until the timer is stopped (`requireInteraction`).
 *  - iOS: only installed PWAs on iOS 16.4+ support notifications at all, and
 *    persistent/ongoing notifications are effectively unsupported. We degrade
 *    gracefully (every call is wrapped in try/catch and a support check).
 */
const TAG = "stavba-timer";

export function notificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator
  );
}

/**
 * Request notification permission. Must be called from a user gesture (e.g. the
 * click that starts the timer), otherwise some browsers reject the request.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export async function showTimerNotification(jobTitle: string): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("Stavba – měření času běží", {
      body: jobTitle ? `Zakázka: ${jobTitle}` : "Časovač běží",
      tag: TAG,
      silent: true,
      requireInteraction: true,
      data: { type: "timer" },
    });
  } catch {
    // Unsupported platform (e.g. iOS) — ignore.
  }
}

export async function clearTimerNotification(): Promise<void> {
  if (!notificationsSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.getNotifications({ tag: TAG });
    existing.forEach((n) => n.close());
  } catch {
    // Ignore.
  }
}

/**
 * Reconcile the notification with the current timer state. Show it when a timer
 * is running, clear it otherwise. Safe to call repeatedly.
 */
export function syncTimerNotification(runningJobTitle: string | null): void {
  if (runningJobTitle) {
    void showTimerNotification(runningJobTitle);
  } else {
    void clearTimerNotification();
  }
}
