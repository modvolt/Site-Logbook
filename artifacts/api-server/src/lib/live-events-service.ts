/**
 * PG LISTEN/NOTIFY service for cross-instance real-time event broadcasting.
 *
 * Architecture:
 *   1. A dedicated pg.Client (outside the pool) holds a persistent LISTEN
 *      connection to the channel "stavba_live_events".
 *   2. Any API route that mutates data calls publishLiveEvent() after a
 *      successful commit — this runs pg_notify via the pool (one-shot, no
 *      dedicated connection needed for NOTIFY).
 *   3. Every API instance receives the NOTIFY (including the one that sent it)
 *      and fans it out to its local SSE clients, filtering out the
 *      originClientId so the originating browser does not double-refetch.
 *
 * Rollback safety:
 *   publishLiveEvent() MUST be called AFTER the transaction commits.
 *   A rolled-back transaction never reaches publishLiveEvent(); therefore
 *   stale events from failed writes are impossible by design.
 *
 * Reconnect:
 *   Uses exponential back-off (1s → 2s → 4s → … → 60s cap). The connection
 *   is re-established on error or unexpected end. A graceful shutdown (SIGTERM)
 *   calls shutdown() which tears down the listener without triggering reconnect.
 */

import pg from "pg";
import { logger } from "./logger";
import { parseLiveEventPayload, type LiveDomain } from "@workspace/live-events";
import { publishToLocalClients } from "./live-updates";

const CHANNEL = "stavba_live_events";
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_FACTOR = 2;

let listenerClient: pg.Client | null = null;
let shuttingDown = false;
let backoffMs = BACKOFF_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let eventIdCounter = 0;

/** Create and connect a fresh pg.Client for LISTEN. */
async function createListenerClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  // Unhandled async errors (socket drop, etc.) bypass connect() try/catch —
  // an unregistered 'error' event would crash the process (EventEmitter rule).
  client.on("error", (err) => {
    logger.warn({ err }, "[live-events] LISTEN client error — will reconnect");
  });

  await client.connect();
  return client;
}

async function startListening(): Promise<void> {
  if (shuttingDown) return;
  try {
    const client = await createListenerClient();
    listenerClient = client;
    backoffMs = BACKOFF_BASE_MS;

    await client.query(`LISTEN "${CHANNEL}"`);
    logger.info(`[live-events] LISTEN active on channel "${CHANNEL}"`);

    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      const payload = parseLiveEventPayload(msg.payload);
      if (!payload) {
        logger.warn({ raw: msg.payload }, "[live-events] Skipping unparseable NOTIFY payload");
        return;
      }
      publishToLocalClients(payload);
    });

    client.on("end", () => {
      if (shuttingDown) return;
      logger.warn("[live-events] LISTEN connection ended — scheduling reconnect");
      listenerClient = null;
      scheduleReconnect();
    });

    client.on("error", () => {
      if (shuttingDown) return;
      listenerClient = null;
      scheduleReconnect();
    });
  } catch (err) {
    logger.warn({ err }, "[live-events] Failed to start LISTEN — scheduling reconnect");
    listenerClient = null;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  logger.info(`[live-events] Reconnecting in ${backoffMs}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startListening();
  }, backoffMs);
  reconnectTimer.unref?.();
  backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
}

/** Start the PG LISTEN service. Call once from index.ts. */
export async function startLiveEventsService(): Promise<void> {
  shuttingDown = false;
  await startListening();
}

/** Graceful shutdown — call from SIGTERM handler. */
export async function shutdownLiveEventsService(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenerClient) {
    try {
      await listenerClient.end();
    } catch {
      // Ignore errors on shutdown.
    }
    listenerClient = null;
  }
}

// ---------------------------------------------------------------------------
// Publish helper — call AFTER a successful commit, never inside a transaction.
// ---------------------------------------------------------------------------

/**
 * Shared pool reference — set once from publishLiveEvent so we can NOTIFY
 * without keeping a second dedicated connection open. We use the existing db
 * pool (imported lazily to avoid circular deps at module load time).
 */
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    _pool.on("error", (err) => {
      logger.warn({ err }, "[live-events] Notify pool error");
    });
  }
  return _pool;
}

/**
 * Publish a live event by calling pg_notify. Must be called AFTER the
 * originating transaction commits; a rollback will never reach this call.
 *
 * @param domains        The domain(s) whose data became stale.
 * @param entityIds      Optional map of domain → affected entity IDs.
 * @param originClientId The client-id of the browser that triggered the
 *                       mutation; that browser will skip the invalidation.
 */
export async function publishLiveEvent(
  domains: readonly LiveDomain[],
  entityIds?: Partial<Record<LiveDomain, number[]>>,
  originClientId?: string,
): Promise<void> {
  if (domains.length === 0) return;
  const id = ++eventIdCounter;
  const payload = JSON.stringify({
    eventId: id,
    ts: new Date().toISOString(),
    domains,
    ...(entityIds ? { entityIds } : {}),
    ...(originClientId ? { originClientId } : {}),
  });
  try {
    const pool = getPool();
    await pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
  } catch (err) {
    logger.warn({ err, domains }, "[live-events] pg_notify failed — skipping broadcast");
  }
}
