import type { APIRequestContext } from "@playwright/test";

/**
 * Delete a PPE assignment by ID, silently ignoring 404.
 */
export async function cleanupPpeAssignment(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/ppe/assignments/${id}`).catch(() => {});
}

/**
 * Soft-delete (archive) a PPE item by ID, silently ignoring errors.
 */
export async function cleanupPpeItem(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/ppe/items/${id}`).catch(() => {});
}

/**
 * Delete a person by ID, silently ignoring errors.
 */
export async function cleanupPerson(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/people/${id}`).catch(() => {});
}

/**
 * Delete a warehouse item by ID, silently ignoring 404 / 409 (items with
 * movements cannot be hard-deleted — they remain as test debris).
 */
export async function cleanupWarehouseItem(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/warehouse-items/${id}`).catch(() => {});
}

/**
 * Delete a job by ID, silently ignoring errors.
 * Cascades attached time-entries, materials, and visits on the server.
 */
export async function cleanupJob(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/jobs/${id}`).catch(() => {});
}

/**
 * Force-delete an activity (and all its visits) by ID, silently ignoring errors.
 * Uses ?force=true so the call succeeds even when visits are attached.
 */
export async function cleanupActivity(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/activities/${id}?force=true`).catch(() => {});
}

/**
 * Delete a quote by ID, silently ignoring errors.
 * Only draft/rejected/expired quotes can be deleted; accepted/converted ones
 * are left as test debris (they don't block re-runs).
 */
export async function cleanupQuote(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/quotes/${id}`).catch(() => {});
}
