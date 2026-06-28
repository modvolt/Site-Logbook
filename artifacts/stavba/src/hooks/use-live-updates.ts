import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  invalidateData,
  type InvalidationDomain,
} from "@/lib/query-invalidation";

// Known domains the server may push. Anything outside this set is ignored so a
// stray/unknown event can never throw. Keep in sync with `InvalidationDomain`.
const KNOWN_DOMAINS = new Set<InvalidationDomain>([
  "jobs",
  "activities",
  "warehouse",
  "customers",
  "people",
  "machines",
  "billingInvoices",
  "billingDocuments",
  "bankImport",
  "emailImport",
  "reviewQueue",
  "ppe",
]);

// Same-origin SSE endpoint. The API is reverse-proxied at /api (nginx in prod,
// the Replit shared proxy in dev), matching the root-relative URLs the generated
// API client already uses. EventSource sends the session cookie automatically
// for same-origin requests.
const EVENTS_URL = "/api/events";

/**
 * Subscribes to the server's real-time event stream and refreshes any open
 * screen whose data was changed on another device. This is additive on top of
 * the existing refetch-on-focus / refetch-on-reconnect behaviour: if the stream
 * is unavailable (no EventSource, proxy drops it, offline), those passive
 * refreshes still keep data fresh — we simply lose the few-seconds latency.
 *
 * EventSource reconnects automatically after a drop (honouring the server's
 * `retry` hint), so there is nothing to manage beyond closing on unmount.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Graceful fallback: runtimes without EventSource just rely on focus/reconnect.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource(EVENTS_URL, { withCredentials: true });

    const onInvalidate = (event: MessageEvent<string>) => {
      let domains: unknown;
      try {
        domains = (JSON.parse(event.data) as { domains?: unknown }).domains;
      } catch {
        return;
      }
      if (!Array.isArray(domains)) return;
      const valid = domains.filter(
        (d): d is InvalidationDomain =>
          typeof d === "string" && KNOWN_DOMAINS.has(d as InvalidationDomain),
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
