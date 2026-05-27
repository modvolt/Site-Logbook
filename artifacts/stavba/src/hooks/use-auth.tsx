import { createContext, useContext, type ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type Role = "guest" | "master" | "admin";

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

interface AuthCtx {
  user: AuthUser | null;
  role: Role | null;
  isAuthenticated: boolean;
  needsSetup: boolean;
  isLoading: boolean;
  can: (action: "write" | "manageUsers") => boolean;
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

  const can: AuthCtx["can"] = (action) => {
    if (!role) return false;
    if (action === "manageUsers") return role === "admin";
    if (action === "write") return role === "master" || role === "admin";
    return false;
  };

  const value: AuthCtx = {
    user,
    role,
    isAuthenticated: data?.authenticated ?? false,
    needsSetup: data?.needsSetup ?? false,
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
