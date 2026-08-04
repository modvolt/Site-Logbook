import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey, useLogout } from "@workspace/api-client-react";
import { useOfflineQueue } from "@/hooks/use-offline-queue";
import { clearApiCache } from "@/lib/pwa";
import { clearTimerNotification } from "@/lib/timer-notification";
import { publishAuthTransition, resetIdentityQueries } from "@/lib/auth-coordination";
import {
  beginIdentityRequestTransition,
  completeIdentityRequestTransition,
} from "@/lib/identity-fetch";

export function useSecureLogout() {
  const queryClient = useQueryClient();
  const { pendingCount, failedCount } = useOfflineQueue();
  const logout = useLogout();

  const requestLogout = useCallback(async () => {
    const ownedCount = pendingCount + failedCount;
    if (
      ownedCount > 0 &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Máte ${ownedCount} neodeslaných offline akcí. Po odhlášení zůstanou uzamčené pro tuto identitu a jiný uživatel je nemůže odeslat.\n\nZvolte OK pro odhlášení, nebo Zrušit a nejprve akce synchronizujte či odstraňte.`,
      )
    ) {
      return;
    }

    beginIdentityRequestTransition();
    const transition = publishAuthTransition("changing");
    const reset = resetIdentityQueries(queryClient);
    const cleanup = Promise.allSettled([clearApiCache(), clearTimerNotification()]);
    try {
      await logout.mutateAsync(undefined);
      await Promise.allSettled([reset, cleanup]);
      publishAuthTransition("changed", transition);
      completeIdentityRequestTransition();
    } catch {
      // A lost response may mean the server committed the logout. Keep the
      // browser signed out, finish local cleanup, then trust only a fresh /me.
      await Promise.allSettled([reset, cleanup]);
      publishAuthTransition("changed", transition);
      completeIdentityRequestTransition();
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    }
  }, [failedCount, logout, pendingCount, queryClient]);

  return { requestLogout, isPending: logout.isPending };
}
