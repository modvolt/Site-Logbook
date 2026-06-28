import { useEffect, useCallback } from "react";

const CONFIRM_MSG = "Máte neuložené změny. Opravdu chcete odejít?";

/**
 * Protects against accidental navigation when the form has unsaved changes.
 *
 * Intercepts:
 *  1. Browser close / refresh / tab close  (beforeunload)
 *  2. Browser back / forward button        (popstate sentinel)
 *  3. Wouter <Link> / <a> clicks           (capture-phase click handler)
 *
 * Returns `confirmNavigation` for guarding programmatic setLocation() calls.
 */
export function useUnsavedChanges(isDirty: boolean) {
  // 1. Browser beforeunload
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // 2. Push a sentinel history entry so the browser back-button fires popstate
  //    instead of silently leaving the page.
  useEffect(() => {
    if (!isDirty) return;
    window.history.pushState({ __unsavedGuard: true }, "");

    const handlePopState = () => {
      if (window.confirm(CONFIRM_MSG)) {
        // Navigate one more step back, past our sentinel
        window.history.go(-1);
      } else {
        // Re-push sentinel to stay on the page
        window.history.pushState({ __unsavedGuard: true }, "");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isDirty]);

  // 3. Intercept <a href> / wouter <Link> clicks in capture phase.
  //    If the user cancels, prevent the event from reaching wouter's handler.
  //    If the user confirms, let it propagate normally.
  useEffect(() => {
    if (!isDirty) return;
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const rel = anchor.getAttribute("href") ?? "";
      // Skip hash links, mailto, tel, and other protocol links
      if (!rel || rel.startsWith("#") || /^[a-z][a-z0-9+\-.]*:/i.test(rel)) return;

      if (!window.confirm(CONFIRM_MSG)) {
        e.preventDefault();
        e.stopPropagation();
      }
      // If confirmed, let wouter's handler run normally
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [isDirty]);

  /** Guard for programmatic navigation (e.g. calling setLocation from a button handler). */
  const confirmNavigation = useCallback(
    (navigate: () => void) => {
      if (!isDirty) { navigate(); return; }
      if (window.confirm(CONFIRM_MSG)) navigate();
    },
    [isDirty],
  );

  return { confirmNavigation };
}
