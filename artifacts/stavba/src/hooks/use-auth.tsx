import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { activateApiCacheScope, clearApiCache, debugLog } from "@/lib/pwa";
import {
  publishAuthTransition,
  resetIdentityQueries,
  subscribeAuthTransitions,
} from "@/lib/auth-coordination";
import {
  beginIdentityRequestTransition,
  completeIdentityRequestTransition,
  setIdentityRequestScope,
} from "@/lib/identity-fetch";

export type Role = "guest" | "master" | "admin";
export type Permission =
  | "jobs.view" | "jobs.work" | "jobs.manage"
  | "activities.view" | "activities.manage"
  | "customers.view" | "customers.manage"
  | "people.view" | "people.manage"
  | "warehouse.view" | "warehouse.manage"
  | "machines.view" | "machines.manage"
  | "time.manage"
  | "rates.cost.view" | "rates.sale.view" | "rates.manage"
  | "credentials.view" | "credentials.manage"
  | "billing.view" | "billing.manage" | "billing.approve" | "billing.settings"
  | "statistics.view"
  | "quotes.view" | "quotes.manage"
  | "settings.view" | "settings.manage"
  | "diagnostics.view" | "diagnostics.manage"
  | "audit.view"
  | "users.manage"
  | "switchboards.view" | "switchboards.create" | "switchboards.update" | "switchboards.archive"
  | "switchboards.documents.upload" | "switchboards.documents.view"
  | "switchboards.checklist.fill" | "switchboards.checklist.edit_own" | "switchboards.checklist.edit_all"
  | "switchboards.measurements.create" | "switchboards.photos.create"
  | "switchboards.defects.create" | "switchboards.defects.close"
  | "switchboards.extraction.review" | "switchboards.extraction.correct"
  | "switchboards.labels.approve" | "switchboards.labels.generate"
  | "switchboards.phases.complete" | "switchboards.protocol.complete" | "switchboards.protocol.override"
  | "switchboards.templates.manage" | "switchboards.parser.manage" | "switchboards.qr.manage"
  | "switchboards.documents.publish" | "switchboards.audit.view";

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  personId: number | null;
  email: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  permissions: Permission[];
  permissionOverrides: Array<{ permission: Permission; effect: "allow" | "deny" }>;
}

interface AuthCtx {
  user: AuthUser | null;
  role: Role | null;
  isAuthenticated: boolean;
  needsSetup: boolean;
  offlineScope: string | null;
  isLoading: boolean;
  can: (action: Permission | "write" | "manageUsers") => boolean;
  refresh: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      staleTime: 60_000,
      retry: false,
    },
  });

  const user = (data?.user as AuthUser | undefined) ?? null;
  const role = user?.role ?? null;
  const offlineScope = data?.authenticated ? (data.offlineScope ?? null) : null;

  // Diagnostics: log whenever the auth state is (re)loaded from /api/auth/me, so
  // a stuck-on-login or bounced-after-reload report can be traced in the console.
  useEffect(() => {
    if (isLoading) return;
    debugLog(
      "auth",
      `state loaded: authenticated=${data?.authenticated ?? false} role=${role ?? "—"} needsSetup=${data?.needsSetup ?? false}`,
    );
  }, [isLoading, data?.authenticated, data?.needsSetup, role]);

  useEffect(() => {
    if (isLoading) return;
    if (data?.authenticated && offlineScope) {
      setIdentityRequestScope(offlineScope);
      void activateApiCacheScope(offlineScope);
      return;
    }
    setIdentityRequestScope(null);
    void clearApiCache();
  }, [isLoading, data?.authenticated, offlineScope]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "REQUEST_IDENTITY_SCOPE" && offlineScope) {
        navigator.serviceWorker.controller?.postMessage({
          type: "SET_IDENTITY_SCOPE",
          scope: offlineScope,
        });
        return;
      }
      if (event.data?.type === "AUTH_SCOPE_MISMATCH") {
        beginIdentityRequestTransition();
        const reset = resetIdentityQueries(queryClient);
        void Promise.allSettled([reset, clearApiCache()]).then(() => {
          completeIdentityRequestTransition();
          publishAuthTransition("changed");
          void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        });
      }
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [offlineScope, queryClient]);

  useEffect(() => {
    let transitionWork = Promise.resolve();
    return subscribeAuthTransitions((event) => {
      beginIdentityRequestTransition();
      const reset = resetIdentityQueries(queryClient);
      transitionWork = transitionWork.then(async () => {
        await Promise.allSettled([reset, clearApiCache()]);
        if (event.stage === "changed") {
          completeIdentityRequestTransition();
          await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        }
      });
    });
  }, [queryClient]);

  useEffect(() => {
    const handleInvalidated = () => {
      beginIdentityRequestTransition();
      const reset = resetIdentityQueries(queryClient);
      void Promise.allSettled([reset, clearApiCache()]).then(async () => {
        completeIdentityRequestTransition();
        publishAuthTransition("changed");
        await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      });
    };
    window.addEventListener("stavba:auth-invalidated", handleInvalidated);
    return () => window.removeEventListener("stavba:auth-invalidated", handleInvalidated);
  }, [queryClient]);

  const can: AuthCtx["can"] = (action) => {
    if (!role) return false;
    if (action === "manageUsers") return user?.permissions.includes("users.manage") ?? false;
    if (action === "write") return role === "master" || role === "admin";
    return user?.permissions.includes(action) ?? false;
  };

  const value: AuthCtx = {
    user,
    role,
    isAuthenticated: data?.authenticated ?? false,
    needsSetup: data?.needsSetup ?? false,
    offlineScope,
    isLoading,
    can,
    refresh: () => queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() }),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
