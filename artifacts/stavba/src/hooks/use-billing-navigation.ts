import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import {
  buildBillingLocation,
  clearBillingScroll,
  readBillingReturnTo,
  readBillingScroll,
  saveBillingScroll,
  withBillingReturnTo,
} from "@/lib/billing-navigation";

function sessionStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function useBillingListNavigation(ready = true) {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const currentLocation = useMemo(
    () => buildBillingLocation(pathname, search),
    [pathname, search],
  );
  const restoredLocation = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || restoredLocation.current === currentLocation) return;

    const storage = sessionStorageOrNull();
    if (!storage) {
      restoredLocation.current = currentLocation;
      return;
    }

    let savedY: number | null = null;
    try {
      savedY = readBillingScroll(storage, currentLocation);
    } catch {
      restoredLocation.current = currentLocation;
      return;
    }

    if (savedY == null) {
      restoredLocation.current = currentLocation;
      return;
    }

    let secondFrame = 0;
    let finalTimer = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: savedY, left: 0, behavior: "auto" });
      secondFrame = window.requestAnimationFrame(() => {
        window.scrollTo({ top: savedY, left: 0, behavior: "auto" });
        finalTimer = window.setTimeout(() => {
          window.scrollTo({ top: savedY, left: 0, behavior: "auto" });
          try {
            clearBillingScroll(storage, currentLocation);
          } catch {
            // Navigation still works when storage is unavailable or full.
          }
          restoredLocation.current = currentLocation;
        }, 120);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (finalTimer) window.clearTimeout(finalTimer);
    };
  }, [currentLocation, ready]);

  const openDetail = useCallback(
    (target: string) => {
      const storage = sessionStorageOrNull();
      if (storage) {
        try {
          saveBillingScroll(storage, currentLocation, window.scrollY);
        } catch {
          // A blocked sessionStorage must not block opening the detail.
        }
      }
      navigate(withBillingReturnTo(target, currentLocation));
    },
    [currentLocation, navigate],
  );

  return { currentLocation, navigate, openDetail };
}

export function useBillingReturnNavigation(fallback: string) {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const currentLocation = useMemo(
    () => buildBillingLocation(pathname, search),
    [pathname, search],
  );
  const returnTo = useMemo(
    () => readBillingReturnTo(search, fallback),
    [fallback, search],
  );

  const goBack = useCallback(() => navigate(returnTo), [navigate, returnTo]);
  const preserveReturnTo = useCallback(
    (target: string) => withBillingReturnTo(target, returnTo),
    [returnTo],
  );
  const childLocation = useCallback(
    (target: string) => withBillingReturnTo(target, currentLocation),
    [currentLocation],
  );

  return {
    childLocation,
    currentLocation,
    goBack,
    navigate,
    preserveReturnTo,
    returnTo,
  };
}
