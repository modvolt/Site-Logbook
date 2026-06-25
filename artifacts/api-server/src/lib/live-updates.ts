import type { Response } from "express";

/**
 * Server-Sent Events (SSE) push channel for real-time, cross-device refresh.
 *
 * When any browser/device successfully mutates data, the server broadcasts the
 * affected "domains" to every other open browser over a long-lived SSE stream
 * (`GET /api/events`). Each client maps those domain strings back through its
 * existing `invalidateData` helper, so an already-open list/detail screen
 * refreshes within a second or two — no manual reload, no polling.
 *
 * Graceful fallback: if the SSE channel is unavailable (proxy drops it, network
 * down, runtime without EventSource), the client still relies on the existing
 * refetch-on-focus / refetch-on-reconnect behaviour. The push is purely additive.
 *
 * IMPORTANT: `ServerInvalidationDomain` below MUST stay in sync with
 * `InvalidationDomain` in `artifacts/stavba/src/lib/query-invalidation.ts`. The
 * server only emits domain *names*; the client owns the query-key mapping and
 * the cross-domain cascades, so this file stays deliberately thin.
 */
export type ServerInvalidationDomain =
  | "jobs"
  | "activities"
  | "warehouse"
  | "customers"
  | "people"
  | "machines"
  | "billingInvoices"
  | "billingDocuments"
  | "bankImport"
  | "emailImport"
  | "reviewQueue";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Maps an API request path (relative to the `/api` mount, e.g. `/jobs/5` or
 * `/billing/invoices/3/issue`) to the domain(s) whose data it changed. Returns
 * an empty array for paths that have no cached counterpart on the client
 * (settings, auth, storage, device credentials, …) so they are never broadcast.
 *
 * Billing sub-areas are checked before the generic resource prefixes because
 * they live under `/billing/...`. Note we intentionally cover the paths that the
 * audit middleware skips (bank-statements, email-import) — those still change
 * data that open screens display.
 */
export function domainsForPath(relPath: string): ServerInvalidationDomain[] {
  const p = relPath;
  const domains = new Set<ServerInvalidationDomain>();
  const add = (...ds: ServerInvalidationDomain[]) => {
    for (const d of ds) domains.add(d);
  };

  if (p.startsWith("/billing/invoices")) {
    add("billingInvoices");
  } else if (p.startsWith("/billing/documents")) {
    add("billingDocuments", "reviewQueue");
  } else if (p.startsWith("/billing/approved-lines")) {
    add("billingDocuments");
  } else if (p.startsWith("/billing/bank-statements")) {
    add("bankImport");
  } else if (p.startsWith("/billing/email-import")) {
    add("emailImport");
  } else if (p.startsWith("/jobs")) {
    add("jobs");
    // Material writes (`/jobs/:id/materials`) also move stock.
    if (p.includes("/materials")) add("warehouse");
    // Timer start/stop changes a person's hasActiveTimer state.
    if (p.includes("/time-entries")) add("people");
  } else if (p.startsWith("/activities")) {
    add("activities");
    // Timer start/stop changes a person's hasActiveTimer state.
    if (p.includes("/time-entries")) add("people");
  } else if (p.startsWith("/tasks")) {
    add("jobs");
  } else if (p.startsWith("/materials")) {
    add("jobs", "warehouse");
  } else if (
    p.startsWith("/warehouse-items") ||
    p.startsWith("/warehouse-movements")
  ) {
    add("warehouse");
  } else if (
    p.startsWith("/customers") ||
    p.startsWith("/customer-contacts") ||
    p.startsWith("/customer-sites") ||
    p.startsWith("/customer-site-attachments")
  ) {
    add("customers");
  } else if (p.startsWith("/people")) {
    add("people");
  } else if (p.startsWith("/machines")) {
    add("machines");
  }

  return [...domains];
}

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Connected-client registry (in-process). A single API process serves all
// browsers, so a plain in-memory Set is sufficient. If the API is ever scaled
// to multiple instances, swap this for a shared bus (Redis pub/sub, Postgres
// LISTEN/NOTIFY) — the publish/subscribe surface stays the same.
// ---------------------------------------------------------------------------

interface LiveClient {
  res: Response;
}

const clients = new Set<LiveClient>();

/**
 * Register an SSE response stream. Returns an unregister function to call when
 * the connection closes.
 */
export function registerClient(res: Response): () => void {
  const client: LiveClient = { res };
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

export function liveClientCount(): number {
  return clients.size;
}

/**
 * Broadcast an `invalidate` event carrying the affected domains to every open
 * SSE stream. No-op when there is nothing to send or nobody listening.
 */
export function publishDomains(domains: readonly ServerInvalidationDomain[]): void {
  if (domains.length === 0 || clients.size === 0) return;
  const frame = `event: invalidate\ndata: ${JSON.stringify({ domains })}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(frame);
    } catch {
      // Broken pipe: the connection's own "close" handler unregisters it.
    }
  }
}
