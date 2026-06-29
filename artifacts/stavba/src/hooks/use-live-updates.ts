import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LIVE_DOMAINS, parseLiveEventPayload } from "@workspace/live-events";
import {
  invalidateData,
  type InvalidationDomain,
} from "@/lib/query-invalidation";

// Build the known-domains set once from the shared source of truth.
const KNOWN_DOMAIN_SET = new Set<string>(LIVE_DOMAINS);

// Same-origin SSE endpoint. The API is reverse-proxied at /api (nginx in prod,
// the Replit shared proxy in dev), matching the root-relative URLs the generated
// API client already uses. EventSource sends the session cookie automatically
// for same-origin requests.
const EVENTS_URL = "/api/events";

/**
 * Generate a stable random client ID for this browser session. Used to
 * suppress duplicate invalidation on the originating browser — it already
 * has fresh data from the mutation response, so we skip the refetch.
 */
function generateClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const SESSION_CLIENT_ID = generateClientId();

/**
 * Returns the client ID for this browser session. Routes that mutate data
 * can include this in the X-Client-Id header so the server skips sending
 * the event back to us.
 */
export function getLiveClientId(): string {
  return SESSION_CLIENT_ID;
}

/**
 * Subscribes to the server's real-time event stream and refreshes any open
 * screen whose data was changed on another device. This is additive on top of
 * the existing refetch-on-focus / refetch-on-reconnect behaviour: if the stream
 * is unavailable (no EventSource, proxy drops it, offline), those passive
 * refreshes still keep data fresh — we simply lose the few-seconds latency.
 *
 * The browser identifies itself via the `clientId` query parameter so that
 * events originating from THIS browser are skipped (no double-refetch).
 *
 * EventSource reconnects automatically after a drop (honouring the server's
 * `retry` hint), so there is nothing to manage beyond closing on unmount.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  const clientIdRef = useRef(SESSION_CLIENT_ID);

  useEffect(() => {
    // Graceful fallback: runtimes without EventSource just rely on focus/reconnect.
    if (typeof EventSource === "undefined") return;

    const url = new URL(EVENTS_URL, window.location.origin);
    url.searchParams.set("clientId", clientIdRef.current);

    const source = new EventSource(url.toString(), { withCredentials: true });

    const onInvalidate = (event: MessageEvent<string>) => {
      const payload = parseLiveEventPayload(event.data);
      if (!payload) return;

      // originClientId filtering: if the server echoed our own clientId back
      // (shouldn't happen — the server filters it out — but double-check here).
      if (payload.originClientId && payload.originClientId === clientIdRef.current) {
        return;
      }

      const valid = payload.domains.filter(
        (d): d is InvalidationDomain =>
          KNOWN_DOMAIN_SET.has(d),
      );
      if (valid.length > 0) invalidateData(queryClient, ...valid);
    };

    source.addEventListener("invalidate", onInvalidate as EventListener);

    return () => {
      source.removeEventListener("invalidate", onInvalidate as EventListener);
      source.close();
    };
  }, [queryClient]);
}
