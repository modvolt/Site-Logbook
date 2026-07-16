const RETURN_EVENTS = ["focus", "pageshow"] as const;

/**
 * Opens the native file picker without letting mobile Safari/PWA restore the
 * page to the hidden file input after the picker closes.
 */
export function openFilePicker(input: HTMLInputElement | null): void {
  if (!input || input.disabled) return;

  const left = window.scrollX;
  const top = window.scrollY;
  const trigger = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  let cleanedUp = false;
  let cleanupTimer: number | undefined;

  const restoreViewport = () => {
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(left, top);
    trigger?.focus({ preventScroll: true });
    requestAnimationFrame(() => window.scrollTo(left, top));
    window.setTimeout(() => {
      window.scrollTo(left, top);
      root.style.scrollBehavior = previousScrollBehavior;
    }, 120);
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const event of RETURN_EVENTS) window.removeEventListener(event, onReturn);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    input.removeEventListener("change", onReturn);
    input.removeEventListener("cancel", onReturn);
    if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
  };

  const onReturn = () => {
    restoreViewport();
    window.setTimeout(cleanup, 250);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") onReturn();
  };

  for (const event of RETURN_EVENTS) window.addEventListener(event, onReturn);
  document.addEventListener("visibilitychange", onVisibilityChange);
  input.addEventListener("change", onReturn);
  input.addEventListener("cancel", onReturn);
  cleanupTimer = window.setTimeout(cleanup, 120_000);

  input.click();
  // Some embedded PWA browsers move the page immediately, before visibility
  // changes. Restore once now and again after the native picker returns.
  restoreViewport();
}
