// IndexedDB-backed offline queue for field operations.
// Stores pending mutations (add material, start/stop timer, set hours, add photo)
// so technicians can work without network and sync when connectivity returns.

export type OfflineOpType =
  | "add_material"
  | "start_timer"
  | "stop_timer"
  | "add_work_session"
  | "set_hours"
  | "add_photo";

export type OfflineOpStatus = "pending" | "failed";

export interface OfflineOp {
  id: string;
  type: OfflineOpType;
  jobId: number;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  status: OfflineOpStatus;
  errorMessage?: string;
}

const DB_NAME = "stavba-offline-v1";
const DB_VERSION = 1;
const STORE_OPS = "ops";
const STORE_BLOBS = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        db.createObjectStore(STORE_OPS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllOps(): Promise<OfflineOp[]> {
  const db = await openDb();
  const all = await tx<OfflineOp[]>(db, STORE_OPS, "readonly", (s) => s.getAll());
  db.close();
  // Sort by creation time ascending so older ops flush first
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function enqueueOp(
  op: Omit<OfflineOp, "attempts" | "status" | "createdAt">,
): Promise<OfflineOp> {
  const record: OfflineOp = {
    ...op,
    attempts: 0,
    status: "pending",
    createdAt: Date.now(),
  };
  const db = await openDb();
  await tx(db, STORE_OPS, "readwrite", (s) => s.put(record));
  db.close();
  return record;
}

export async function updateOp(op: OfflineOp): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_OPS, "readwrite", (s) => s.put(op));
  db.close();
}

export async function deleteOp(id: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_OPS, "readwrite", (s) => s.delete(id));
  db.close();
}

// --- Photo blob storage ---

export async function saveBlob(key: string, blob: Blob, fileName: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_BLOBS, "readwrite", (s) => s.put({ key, blob, fileName }));
  db.close();
}

export async function getBlob(key: string): Promise<{ blob: Blob; fileName: string } | null> {
  const db = await openDb();
  const record = await tx<{ key: string; blob: Blob; fileName: string } | undefined>(
    db,
    STORE_BLOBS,
    "readonly",
    (s) => s.get(key),
  );
  db.close();
  return record ?? null;
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_BLOBS, "readwrite", (s) => s.delete(key));
  db.close();
}

// Returns all blob entries for building pending photo previews in the UI
export async function getAllBlobs(): Promise<{ key: string; blob: Blob; fileName: string }[]> {
  const db = await openDb();
  const all = await tx<{ key: string; blob: Blob; fileName: string }[]>(
    db,
    STORE_BLOBS,
    "readonly",
    (s) => s.getAll(),
  );
  db.close();
  return all;
}
