// IndexedDB-backed offline queue for field operations. Version 2 stores every
// operation and blob under an immutable user + authorization scope. The v1
// stores remain as a quarantine: legacy unowned data is counted, but no runtime
// code reads or replays it.

export type OfflineOpType =
  | "add_material"
  | "set_material_consumed"
  | "start_timer"
  | "stop_timer"
  | "add_work_session"
  | "set_hours"
  | "add_photo"
  | "add_switchboard_photo"
  | "set_switchboard_checklist_response";

export type OfflineOpStatus = "pending" | "failed";

export interface OfflineOwner {
  userId: number;
  scope: string;
}

export interface OfflineOp {
  id: string;
  type: OfflineOpType;
  jobId: number;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  status: OfflineOpStatus;
  ownerUserId: number;
  ownerScope: string;
  errorMessage?: string;
}

interface StoredOfflineOp extends OfflineOp {
  storageKey: string;
}

interface StoredOfflineBlob {
  storageKey: string;
  key: string;
  blob: Blob;
  fileName: string;
  ownerUserId: number;
  ownerScope: string;
}

export interface OfflineIsolationSummary {
  lockedOps: number;
  lockedBlobs: number;
  legacyOps: number;
  legacyBlobs: number;
}

export const OFFLINE_DB_NAME = "stavba-offline-v1";
const DB_VERSION = 2;
const LEGACY_STORE_OPS = "ops";
const LEGACY_STORE_BLOBS = "blobs";
const STORE_OPS = "scoped-ops";
const STORE_BLOBS = "scoped-blobs";
const OWNER_SCOPE_INDEX = "ownerScope";

function storageKey(owner: OfflineOwner, recordId: string): string {
  return `${owner.scope}:${recordId}`;
}

function validateOwner(owner: OfflineOwner): void {
  if (!Number.isInteger(owner.userId) || owner.userId <= 0 || !/^[a-f0-9]{64}$/.test(owner.scope)) {
    throw new Error("Neplatná identita offline úložiště.");
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Preserve the original stores as an unread quarantine for unowned v1
      // records. Fresh databases create them empty so the summary is uniform.
      if (!db.objectStoreNames.contains(LEGACY_STORE_OPS)) {
        db.createObjectStore(LEGACY_STORE_OPS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LEGACY_STORE_BLOBS)) {
        db.createObjectStore(LEGACY_STORE_BLOBS, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        const store = db.createObjectStore(STORE_OPS, { keyPath: "storageKey" });
        store.createIndex(OWNER_SCOPE_INDEX, OWNER_SCOPE_INDEX, { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        const store = db.createObjectStore(STORE_BLOBS, { keyPath: "storageKey" });
        store.createIndex(OWNER_SCOPE_INDEX, OWNER_SCOPE_INDEX, { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const req = fn(transaction.objectStore(storeName));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => reject(req.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? req.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return request<T[]>(db, storeName, "readonly", (store) => store.getAll());
}

export function offlineOpBelongsTo(owner: OfflineOwner, op: OfflineOp): boolean {
  return op.ownerUserId === owner.userId && op.ownerScope === owner.scope;
}

export async function getAllOps(owner: OfflineOwner): Promise<OfflineOp[]> {
  validateOwner(owner);
  const db = await openDb();
  try {
    const records = await request<StoredOfflineOp[]>(db, STORE_OPS, "readonly", (store) =>
      store.index(OWNER_SCOPE_INDEX).getAll(owner.scope),
    );
    return records
      .filter((record) => record.ownerUserId === owner.userId)
      .map(({ storageKey: _storageKey, ...op }) => op)
      .sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

export async function enqueueOp(
  owner: OfflineOwner,
  op: Omit<OfflineOp, "attempts" | "status" | "createdAt" | "ownerUserId" | "ownerScope">,
): Promise<OfflineOp> {
  validateOwner(owner);
  const record: StoredOfflineOp = {
    ...op,
    attempts: 0,
    status: "pending",
    createdAt: Date.now(),
    ownerUserId: owner.userId,
    ownerScope: owner.scope,
    storageKey: storageKey(owner, op.id),
  };
  const db = await openDb();
  try {
    await request(db, STORE_OPS, "readwrite", (store) => store.put(record));
  } finally {
    db.close();
  }
  const { storageKey: _storageKey, ...result } = record;
  return result;
}

export async function updateOp(owner: OfflineOwner, op: OfflineOp): Promise<void> {
  validateOwner(owner);
  if (!offlineOpBelongsTo(owner, op)) {
    throw new Error("Offline operace patří jiné identitě.");
  }
  const db = await openDb();
  try {
    await request(db, STORE_OPS, "readwrite", (store) =>
      store.put({ ...op, storageKey: storageKey(owner, op.id) } satisfies StoredOfflineOp),
    );
  } finally {
    db.close();
  }
}

export async function deleteOp(owner: OfflineOwner, id: string): Promise<void> {
  validateOwner(owner);
  const db = await openDb();
  try {
    await request(db, STORE_OPS, "readwrite", (store) => store.delete(storageKey(owner, id)));
  } finally {
    db.close();
  }
}

export async function saveBlob(
  owner: OfflineOwner,
  key: string,
  blob: Blob,
  fileName: string,
): Promise<void> {
  validateOwner(owner);
  const record: StoredOfflineBlob = {
    storageKey: storageKey(owner, key),
    key,
    blob,
    fileName,
    ownerUserId: owner.userId,
    ownerScope: owner.scope,
  };
  const db = await openDb();
  try {
    await request(db, STORE_BLOBS, "readwrite", (store) => store.put(record));
  } finally {
    db.close();
  }
}

export async function getBlob(
  owner: OfflineOwner,
  key: string,
): Promise<{ blob: Blob; fileName: string } | null> {
  validateOwner(owner);
  const db = await openDb();
  try {
    const record = await request<StoredOfflineBlob | undefined>(
      db,
      STORE_BLOBS,
      "readonly",
      (store) => store.get(storageKey(owner, key)),
    );
    if (!record || record.ownerUserId !== owner.userId || record.ownerScope !== owner.scope) {
      return null;
    }
    return { blob: record.blob, fileName: record.fileName };
  } finally {
    db.close();
  }
}

export async function deleteBlob(owner: OfflineOwner, key: string): Promise<void> {
  validateOwner(owner);
  const db = await openDb();
  try {
    await request(db, STORE_BLOBS, "readwrite", (store) =>
      store.delete(storageKey(owner, key)),
    );
  } finally {
    db.close();
  }
}

export async function getAllBlobs(
  owner: OfflineOwner,
): Promise<{ key: string; blob: Blob; fileName: string }[]> {
  validateOwner(owner);
  const db = await openDb();
  try {
    const records = await request<StoredOfflineBlob[]>(db, STORE_BLOBS, "readonly", (store) =>
      store.index(OWNER_SCOPE_INDEX).getAll(owner.scope),
    );
    return records
      .filter((record) => record.ownerUserId === owner.userId)
      .map(({ key, blob, fileName }) => ({ key, blob, fileName }));
  } finally {
    db.close();
  }
}

export async function getOfflineIsolationSummary(
  owner: OfflineOwner,
): Promise<OfflineIsolationSummary> {
  validateOwner(owner);
  const db = await openDb();
  try {
    const [ops, blobs, legacyOps, legacyBlobs] = await Promise.all([
      readAll<StoredOfflineOp>(db, STORE_OPS),
      readAll<StoredOfflineBlob>(db, STORE_BLOBS),
      request<number>(db, LEGACY_STORE_OPS, "readonly", (store) => store.count()),
      request<number>(db, LEGACY_STORE_BLOBS, "readonly", (store) => store.count()),
    ]);
    return {
      lockedOps: ops.filter(
        (record) => record.ownerScope !== owner.scope || record.ownerUserId !== owner.userId,
      ).length,
      lockedBlobs: blobs.filter(
        (record) => record.ownerScope !== owner.scope || record.ownerUserId !== owner.userId,
      ).length,
      legacyOps,
      legacyBlobs,
    };
  } finally {
    db.close();
  }
}
