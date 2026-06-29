/**
 * Server-Sent Events (SSE) push channel for real-time, cross-device refresh.
 *
 * Domain types come from @workspace/live-events (the single source of truth
 * shared by both the API server and the frontend). This file owns:
 *   - The in-process SSE client registry (registerClient / liveClientCount).
 *   - publishToLocalClients() — fan-out from PG NOTIFY to local SSE streams.
 *   - domainsForPath() — fallback path→domains mapping for simple CRUD routes.
 *   - isMutatingMethod() — predicate used by the broadcast middleware.
 *
 * The publish pipeline is:
 *   route handler (after commit)
 *     → publishLiveEvent()    [live-events-service.ts — pg_notify]
 *       → PG channel          [received by every API instance]
 *         → publishToLocalClients()  [fan-out to this instance's SSE clients]
 */

import type { Response } from "express";
import type { LiveDomain, LiveEventPayload } from "@workspace/live-events";

// Re-export the shared type so callers that imported it from here keep working.
export type { LiveDomain };
export type { LiveDomain as ServerInvalidationDomain };

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Maps an API request path (relative to the `/api` mount) to the domain(s)
 * whose data it changed. Used as a fallback by the broadcastMutations
 * middleware for routes that don't call publishLiveEvent() explicitly.
 *
 * Returns an empty array for paths that have no cached counterpart on the
 * client (settings, auth, storage, device credentials, …).
 */
export function domainsForPath(relPath: string): LiveDomain[] {
  const p = relPath;
  const domains = new Set<LiveDomain>();
  const add = (...ds: LiveDomain[]) => {
    for (const d of ds) domains.add(d);
  };

  if (p.startsWith("/billing/invoices")) {
    add("billingInvoices");
  } else if (p.startsWith("/billing/recurring-templates")) {
    add("billingRecurringTemplates");
  } else if (p.startsWith("/billing/documents")) {
    add("billingDocuments", "reviewQueue");
  } else if (p.startsWith("/billing/approved-lines")) {
    add("billingDocuments");
  } else if (p.startsWith("/billing/bank-statements")) {
    add("bankImport");
  } else if (p.startsWith("/billing/email-import")) {
    add("emailImport");
  } else if (p.startsWith("/billing/review-queue")) {
    add("reviewQueue", "billingDocuments");
  } else if (p.startsWith("/jobs")) {
    add("jobs");
    if (p.includes("/materials")) add("warehouse");
    if (p.includes("/time-entries")) add("people");
  } else if (p.startsWith("/activities")) {
    add("activities");
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
    p.startsWith("/customer-site-attachments") ||
    p.startsWith("/customer-documents")
  ) {
    add("customers");
  } else if (p.startsWith("/people")) {
    add("people");
  } else if (p.startsWith("/machines")) {
    add("machines");
  } else if (p.startsWith("/leaves")) {
    add("leaves");
  } else if (p.startsWith("/ppe")) {
    add("ppe", "people");
  } else if (p.startsWith("/quotes")) {
    add("quotes");
    // Converting a quote to a job creates a new job and may touch a customer.
    if (p.includes("/convert-to-job")) add("jobs", "customers");
  } else if (p.startsWith("/sessions") || p.includes("/sessions")) {
    add("sessions");
  } else if (p.startsWith("/auth/login") || p.startsWith("/auth/setup")) {
    add("sessions");
  }

  return [...domains];
}

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// In-process SSE client registry.
// ---------------------------------------------------------------------------

interface LiveClient {
  res: Response;
  /** Opaque client identifier sent by the browser on SSE open. */
  clientId?: string;
}

const clients = new Set<LiveClient>();

/**
 * Register an SSE response stream. The optional clientId lets the publisher
 * skip sending the event back to the browser that triggered the mutation.
 */
export function registerClient(res: Response, clientId?: string): () => void {
  const client: LiveClient = { res, clientId };
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

export function liveClientCount(): number {
  return clients.size;
}

/**
 * Fan out a structured LiveEventPayload to all local SSE clients.
 * The browser whose originClientId matches is skipped (it already has the
 * fresh data from the mutation response and doesn't need a second refetch).
 *
 * Called by the PG NOTIFY listener (live-events-service.ts) so that every
 * API instance — including the one that issued the NOTIFY — delivers the
 * event to its own connected browsers.
 */
export function publishToLocalClients(payload: LiveEventPayload): void {
  if (clients.size === 0) return;
  const frame = `event: invalidate\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    // Skip the originating browser — it already updated its own view.
    if (
      payload.originClientId &&
      client.clientId &&
      payload.originClientId === client.clientId
    ) {
      continue;
    }
    try {
      client.res.write(frame);
    } catch {
      // Broken pipe — the close handler will unregister this client.
    }
  }
}

/**
 * Broadcast an `invalidate` event to every local SSE client.
 * This is the legacy path used by the middleware fallback; new explicit
 * publishLiveEvent() calls go through the PG NOTIFY pipeline instead.
 */
export function publishDomains(domains: readonly LiveDomain[]): void {
  if (domains.length === 0 || clients.size === 0) return;
  const payload: LiveEventPayload = {
    eventId: 0,
    ts: new Date().toISOString(),
    domains: domains as LiveDomain[],
  };
  publishToLocalClients(payload);
}
