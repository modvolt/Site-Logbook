import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  OFFLINE_DB_NAME,
  deleteBlob,
  deleteOp,
  enqueueOp,
  getAllOps,
  getBlob,
  getOfflineIsolationSummary,
  saveBlob,
  updateOp,
  type OfflineOwner,
} from "../src/lib/offline-queue";

const ownerA: OfflineOwner = { userId: 7, scope: "a".repeat(64) };
const ownerB: OfflineOwner = { userId: 8, scope: "b".repeat(64) };
const queued = {
  id: "same-logical-id",
  type: "add_material" as const,
  jobId: 42,
  payload: { name: "Kabel" },
};

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB deletion blocked"));
  });
}

async function seedLegacyV1(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("ops", { keyPath: "id" });
      request.result.createObjectStore("blobs", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["ops", "blobs"], "readwrite");
    transaction.objectStore("ops").put({ ...queued, attempts: 0, status: "pending", createdAt: 1 });
    transaction.objectStore("blobs").put({ key: "legacy-photo", blob: new Blob(["legacy"]), fileName: "legacy.jpg" });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

describe.sequential("scoped offline IndexedDB", () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it("keeps equal operation IDs isolated and prevents cross-owner deletion", async () => {
    await enqueueOp(ownerA, queued);
    await enqueueOp(ownerB, { ...queued, payload: { name: "Jiný kabel" } });

    expect((await getAllOps(ownerA)).map((op) => op.payload.name)).toEqual(["Kabel"]);
    expect((await getAllOps(ownerB)).map((op) => op.payload.name)).toEqual(["Jiný kabel"]);

    await deleteOp(ownerA, queued.id);
    expect(await getAllOps(ownerA)).toEqual([]);
    expect(await getAllOps(ownerB)).toHaveLength(1);
  });

  it("partitions photo blobs by the same immutable owner", async () => {
    await saveBlob(ownerA, "photo", new Blob(["A"]), "a.jpg");
    await saveBlob(ownerB, "photo", new Blob(["B"]), "b.jpg");

    expect(await (await getBlob(ownerA, "photo"))?.blob.text()).toBe("A");
    expect(await (await getBlob(ownerB, "photo"))?.blob.text()).toBe("B");

    await deleteBlob(ownerA, "photo");
    expect(await getBlob(ownerA, "photo")).toBeNull();
    expect(await getBlob(ownerB, "photo")).not.toBeNull();
  });

  it("rejects attempts to rewrite an operation under another owner", async () => {
    const op = await enqueueOp(ownerA, queued);
    await expect(updateOp(ownerB, op)).rejects.toThrow("jiné identitě");
  });

  it("quarantines unowned v1 operations and blobs without replaying them", async () => {
    await seedLegacyV1();

    expect(await getAllOps(ownerA)).toEqual([]);
    await expect(getOfflineIsolationSummary(ownerA)).resolves.toEqual({
      lockedOps: 0,
      lockedBlobs: 0,
      legacyOps: 1,
      legacyBlobs: 1,
    });
  });

  it("counts other identity partitions without exposing their payload", async () => {
    await enqueueOp(ownerB, queued);
    await saveBlob(ownerB, "photo", new Blob(["B"]), "b.jpg");

    await expect(getOfflineIsolationSummary(ownerA)).resolves.toEqual({
      lockedOps: 1,
      lockedBlobs: 1,
      legacyOps: 0,
      legacyBlobs: 0,
    });
  });
});
