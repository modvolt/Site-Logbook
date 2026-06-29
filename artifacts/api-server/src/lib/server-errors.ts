/**
 * In-process 5xx error ring buffer.
 *
 * Middleware calls `record5xxError` whenever a response with status ≥ 500 is
 * sent. The `/api/admin/health` endpoint reads back the buffer to power the
 * server-error card in the Diagnostica page.
 *
 * Deliberately kept in a standalone module so neither app.ts nor health.ts
 * needs to import from the other.
 */

export interface ServerErrorEntry {
  timestamp: string;
  route: string;
  method: string;
  requestId: string;
  statusCode: number;
}

const MAX_BUFFER = 200;
const buffer: ServerErrorEntry[] = [];

export function record5xxError(entry: ServerErrorEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

/**
 * Returns the most recent `limit` entries (newest first) that occurred within
 * the given time window.
 */
export function getRecentServerErrors(
  windowMs: number,
  limit: number,
): ServerErrorEntry[] {
  const cutoff = Date.now() - windowMs;
  const cutoffIso = new Date(cutoff).toISOString();
  return buffer
    .filter((e) => e.timestamp >= cutoffIso)
    .slice(-limit)
    .reverse();
}

/** Count of 5xx responses recorded within the given time window. */
export function countServerErrors(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  const cutoffIso = new Date(cutoff).toISOString();
  return buffer.filter((e) => e.timestamp >= cutoffIso).length;
}
