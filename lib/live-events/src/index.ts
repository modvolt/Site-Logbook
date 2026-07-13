/**
 * @workspace/live-events — shared contract for real-time domain invalidation.
 *
 * This package has NO dependency on React or Express — it is imported by both
 * the API server (Node.js) and the frontend (browser). A build failure here
 * means the two sides have drifted; fix it in this file, not at the call site.
 *
 * Domain semantics (what triggers invalidation in each domain):
 *   jobs                — job CRUD, status, tasks, attachments, visits, time-entries
 *   activities          — long-term activity CRUD, time-entries
 *   warehouse           — warehouse item CRUD, movements, material writes on jobs/activities
 *   customers           — customer, site, contact, site-attachment, customer-document CRUD
 *   people              — person CRUD, PPE assignments, timer start/stop
 *   machines            — machine CRUD
 *   leaves              — leave CRUD
 *   billingInvoices     — invoice issue/storno/payment/bank-match, recurring templates run
 *   billingDocuments    — cost-document CRUD/approve/reject, AI extraction, review-queue
 *   billingRecurringTemplates — recurring template CRUD
 *   bankImport          — bank-statement import / payment confirm
 *   emailImport         — email-import connect/disconnect/sync
 *   reviewQueue         — review-queue confirm/skip
 *   ppe                 — PPE catalogue, handover records
 *   quotes              — quote CRUD / convert to job
 *   sessions            — login / logout / admin session revoke
 *   auth                — role, active state, and individual permission changes
 */
export type LiveDomain =
  | "jobs"
  | "activities"
  | "warehouse"
  | "customers"
  | "people"
  | "machines"
  | "leaves"
  | "billingInvoices"
  | "billingDocuments"
  | "billingRecurringTemplates"
  | "bankImport"
  | "emailImport"
  | "reviewQueue"
  | "ppe"
  | "quotes"
  | "sessions"
  | "auth"
  | "switchboards";

/**
 * All valid domain strings as a runtime-accessible tuple. Use this wherever
 * you need to validate an unknown string against the known domain set without
 * duplicating the union members.
 */
export const LIVE_DOMAINS = [
  "jobs",
  "activities",
  "warehouse",
  "customers",
  "people",
  "machines",
  "leaves",
  "billingInvoices",
  "billingDocuments",
  "billingRecurringTemplates",
  "bankImport",
  "emailImport",
  "reviewQueue",
  "ppe",
  "quotes",
  "sessions",
  "auth",
  "switchboards",
] as const satisfies readonly LiveDomain[];

const LIVE_DOMAIN_SET = new Set<string>(LIVE_DOMAINS);

/**
 * Returns true when `value` is a valid `LiveDomain` string.
 * Safe to call on any `unknown` input from SSE payloads or NOTIFY messages.
 */
export function isLiveDomain(value: unknown): value is LiveDomain {
  return typeof value === "string" && LIVE_DOMAIN_SET.has(value);
}

/**
 * SSE / PG NOTIFY payload shape. Both the server publisher and the browser
 * subscriber must agree on this structure — changing it here is the single
 * place that enforces the contract.
 *
 * Fields:
 *   eventId        — monotonically increasing per-process counter; used by
 *                    the browser to detect missed events after a reconnect.
 *   ts             — ISO-8601 timestamp of the publish call (server time).
 *   domains        — one or more domains whose cached data became stale.
 *   entityIds      — optional map of domain → affected entity IDs, allowing
 *                    fine-grained (future) per-entity invalidation.
 *   originClientId — session-level ID of the browser that triggered the
 *                    mutation; the originating browser skips the invalidation
 *                    (it already has the updated data from the mutation response).
 */
export interface LiveEventPayload {
  eventId: number;
  ts: string;
  domains: LiveDomain[];
  entityIds?: Partial<Record<LiveDomain, number[]>>;
  originClientId?: string;
}

/**
 * Parse and validate an `invalidate` SSE event data string (or a raw PG
 * NOTIFY payload). Returns `null` when the string is unparseable or contains
 * no recognised domains — the caller should log and skip such payloads.
 */
export function parseLiveEventPayload(raw: string): LiveEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.domains)) return null;
  const domains = obj.domains.filter(isLiveDomain);
  if (domains.length === 0) return null;
  return {
    eventId: typeof obj.eventId === "number" ? obj.eventId : 0,
    ts: typeof obj.ts === "string" ? obj.ts : new Date().toISOString(),
    domains,
    entityIds:
      typeof obj.entityIds === "object" && obj.entityIds !== null
        ? (obj.entityIds as Partial<Record<LiveDomain, number[]>>)
        : undefined,
    originClientId:
      typeof obj.originClientId === "string" ? obj.originClientId : undefined,
  };
}
