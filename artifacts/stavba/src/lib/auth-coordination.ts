import type { QueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";

export type AuthTransitionStage = "changing" | "changed";

export interface AuthTransitionHandle {
  transitionId: string;
  issuedAt: number;
}

export interface AuthTransitionEvent extends AuthTransitionHandle {
  stage: AuthTransitionStage;
}

interface AuthTransitionMessage extends AuthTransitionEvent {
  type: "stavba-auth-transition";
  nonce: string;
}

const AUTH_CHANNEL_NAME = "stavba-auth-v1";
const AUTH_STORAGE_KEY = "stavba.auth-transition";
const seenNonces = new Set<string>();

let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(AUTH_CHANNEL_NAME);
  return channel;
}

function isTransitionMessage(value: unknown): value is AuthTransitionMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AuthTransitionMessage>;
  return candidate.type === "stavba-auth-transition"
    && (candidate.stage === "changing" || candidate.stage === "changed")
    && typeof candidate.transitionId === "string"
    && typeof candidate.nonce === "string"
    && typeof candidate.issuedAt === "number";
}

function remember(nonce: string): boolean {
  if (seenNonces.has(nonce)) return false;
  seenNonces.add(nonce);
  if (seenNonces.size > 100) {
    const oldest = seenNonces.values().next().value;
    if (oldest) seenNonces.delete(oldest);
  }
  return true;
}

export function createAuthTransitionOrderGuard(): (event: AuthTransitionEvent) => boolean {
  let latestIssuedAt = -1;
  let latestTransitionId = "";
  let latestStageRank = -1;
  return (event) => {
    const stageRank = event.stage === "changed" ? 1 : 0;
    if (event.issuedAt < latestIssuedAt) return false;
    if (event.issuedAt === latestIssuedAt) {
      if (event.transitionId === latestTransitionId && stageRank <= latestStageRank) return false;
      if (event.transitionId !== latestTransitionId && stageRank < latestStageRank) return false;
    }
    latestIssuedAt = event.issuedAt;
    latestTransitionId = event.transitionId;
    latestStageRank = stageRank;
    return true;
  };
}

/**
 * Notify other tabs that the origin-wide session cookie is changing. The
 * payload intentionally contains no user data or identity scope.
 */
export function publishAuthTransition(
  stage: AuthTransitionStage,
  existing?: AuthTransitionHandle,
): AuthTransitionHandle {
  const handle = existing ?? {
    transitionId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    issuedAt: Date.now(),
  };
  if (typeof window === "undefined") return handle;
  const message: AuthTransitionMessage = {
    type: "stavba-auth-transition",
    stage,
    ...handle,
    nonce: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  };
  getChannel()?.postMessage(message);
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // BroadcastChannel remains the primary transport when storage is blocked.
  }
  return handle;
}

export function subscribeAuthTransitions(
  listener: (event: AuthTransitionEvent) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const acceptInOrder = createAuthTransitionOrderGuard();

  const deliver = (value: unknown) => {
    if (!isTransitionMessage(value) || !remember(value.nonce)) return;
    const event: AuthTransitionEvent = {
      stage: value.stage,
      transitionId: value.transitionId,
      issuedAt: value.issuedAt,
    };
    if (acceptInOrder(event)) listener(event);
  };
  const authChannel = getChannel();
  const onChannelMessage = (event: MessageEvent<unknown>) => deliver(event.data);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_STORAGE_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed values written by extensions or old clients.
    }
  };

  authChannel?.addEventListener("message", onChannelMessage);
  window.addEventListener("storage", onStorage);
  return () => {
    authChannel?.removeEventListener("message", onChannelMessage);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Fail closed at an identity boundary. Query cancellation starts first, but
 * the signed-out snapshot and removal of identity data happen synchronously,
 * before the first await can yield to a cookie-changing request.
 */
export async function resetIdentityQueries(queryClient: QueryClient): Promise<void> {
  const cancellation = queryClient.cancelQueries();
  const authKey = getGetMeQueryKey();
  queryClient.setQueryData(authKey, {
    authenticated: false,
    needsSetup: false,
    user: null,
    offlineScope: null,
  });
  const authQuery = queryClient.getQueryCache().find({ queryKey: authKey, exact: true });
  queryClient.removeQueries({
    predicate: (query) => query.queryHash !== authQuery?.queryHash,
  });
  await cancellation;
}
