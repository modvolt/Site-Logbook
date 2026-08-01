import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useOfflineQueue } from "@/hooks/use-offline-queue";
import { clearApiCache } from "@/lib/pwa";
import { clearTimerNotification } from "@/lib/timer-notification";

export function useSecureLogout() {
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const { pendingCount, failedCount } = useOfflineQueue();
  const logout = useLogout();

  const requestLogout = useCallback(() => {
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

    logout.mutate(undefined, {
      onSuccess: async () => {
        await Promise.allSettled([clearApiCache(), clearTimerNotification()]);
        queryClient.clear();
        refresh();
      },
    });
  }, [failedCount, logout, pendingCount, queryClient, refresh]);

  return { requestLogout, isPending: logout.isPending };
}
