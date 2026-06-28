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
