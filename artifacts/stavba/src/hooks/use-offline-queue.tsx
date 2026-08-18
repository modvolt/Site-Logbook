import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAllOps,
  enqueueOp,
  updateOp,
  deleteOp,
  getBlob,
  deleteBlob,
  saveBlob as saveStoredBlob,
  getOfflineIsolationSummary,
  acquireOfflineLease,
  renewOfflineLease,
  releaseOfflineLease,
  type OfflineOp,
  type OfflineOwner,
  type OfflineOpType,
} from "@/lib/offline-queue";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { invalidateData } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { debugLog } from "@/lib/pwa";
import { useAuth } from "@/hooks/use-auth";
import { offlineBlobSha256, verifyOfflineReplayIdentity } from "@/lib/offline-replay";
import {
  OFFLINE_MAX_ATTEMPTS,
  canManuallyRetryOfflineFailure,
  normalizeReplayError,
  offlineBackoffMs,
  throwReplayResponse,
} from "@/lib/offline-retry";

const LEASE_TTL_MS = 45_000;
const LEASE_RENEW_MS = 15_000;

interface EnqueueParams {
  id: string;
  type: OfflineOpType;
  jobId: number;
  payload: Record<string, unknown>;
}

interface OfflineQueueContextValue {
  isOnline: boolean;
  pendingOps: OfflineOp[];
  failedOps: OfflineOp[];
  pendingCount: number;
  failedCount: number;
  lockedCount: number;
  legacyCount: number;
  enqueue: (params: EnqueueParams) => Promise<void>;
  saveBlob: (key: string, blob: Blob, fileName: string) => Promise<void>;
  retryOp: (id: string) => Promise<void>;
  discardOp: (id: string) => Promise<void>;
  discardAll: () => Promise<void>;
  isFlushing: boolean;
}

const OfflineQueueContext = createContext<OfflineQueueContextValue | null>(null);

export function useOfflineQueue(): OfflineQueueContextValue {
  const ctx = useContext(OfflineQueueContext);
  if (!ctx) throw new Error("useOfflineQueue must be used inside OfflineQueueProvider");
  return ctx;
}

// --- Flush: execute a single pending op against the live API ---

function replayHeaders(
  owner: OfflineOwner,
  idempotencyKey: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    "Idempotency-Key": idempotencyKey,
    "X-Stavba-Offline-Scope": owner.scope,
  };
}

async function executeOp(owner: OfflineOwner, op: OfflineOp): Promise<void> {
  const { type, jobId, payload } = op;

  switch (type) {
    case "add_material": {
      const res = await fetch(`/api/jobs/${jobId}/materials`, {
        method: "POST",
        headers: replayHeaders(owner, op.id, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) await throwReplayResponse(res, "Přidání materiálu selhalo");
      break;
    }
    case "start_timer": {
      const { personId } = payload as { personId: number };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}/start`, {
        method: "POST",
        headers: replayHeaders(owner, op.id),
      });
      if (!res.ok) await throwReplayResponse(res, "Spuštění časovače selhalo");
      break;
    }
    case "stop_timer": {
      const { personId } = payload as { personId: number };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}/stop`, {
        method: "POST",
        headers: replayHeaders(owner, op.id),
      });
      if (!res.ok) await throwReplayResponse(res, "Zastavení časovače selhalo");
      break;
    }
    case "set_material_consumed": {
      const { materialId, done } = payload as { materialId: number; done: boolean };
      const res = await fetch(`/api/jobs/${jobId}/materials/${materialId}`, {
        method: "PATCH",
        headers: replayHeaders(owner, op.id, { "Content-Type": "application/json" }),
        body: JSON.stringify({ done }),
      });
      if (!res.ok) await throwReplayResponse(res, "Změna spotřeby materiálu selhala");
      break;
    }
    case "add_work_session": {
      const res = await fetch(`/api/jobs/${jobId}/work-sessions`, {
        method: "POST",
        headers: replayHeaders(owner, op.id, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ...payload, idempotencyKey: op.id }),
      });
      if (!res.ok) await throwReplayResponse(res, "Uložení pracovní relace selhalo");
      break;
    }
    case "set_hours": {
      const { personId, hours, reason } = payload as { personId: number; hours: number; reason: string };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}`, {
        method: "PATCH",
        headers: replayHeaders(owner, op.id, { "Content-Type": "application/json" }),
        body: JSON.stringify({ hours, reason }),
      });
      if (!res.ok) await throwReplayResponse(res, "Nastavení hodin selhalo");
      break;
    }
    case "add_photo": {
      const { blobKey, fileName, contentType } = payload as {
        blobKey: string;
        fileName: string;
        contentType: string;
      };
      const blobEntry = await getBlob(owner, blobKey);
      if (!blobEntry) throw new Error("Fotka nebyla nalezena v lokálním úložišti.");
      const contentSha256 = await offlineBlobSha256(blobEntry.blob);

      // Upload the blob to object storage
      const query = new URLSearchParams({ name: fileName, contentType });
      const uploadRes = await fetch(`/api/storage/uploads?${query}`, {
        method: "POST",
        headers: replayHeaders(owner, `${op.id}-upload`, {
          "Content-Type": contentType,
          "X-Stavba-Content-SHA256": contentSha256,
        }),
        body: blobEntry.blob,
      });
      if (!uploadRes.ok) await throwReplayResponse(uploadRes, "Nahrání fotky selhalo");
      const { objectPath } = (await uploadRes.json()) as { objectPath: string };

      // Register attachment record
      const attachRes = await fetch(`/api/jobs/${jobId}/attachments`, {
        method: "POST",
        headers: replayHeaders(owner, `${op.id}-attachment`, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          type: "photo",
          fileName,
          url: objectPath,
          description: "Foto ze stavby",
        }),
      });
      if (!attachRes.ok) await throwReplayResponse(attachRes, "Uložení fotky selhalo");

      // Clean up the blob from IndexedDB now that it's on the server
      await deleteBlob(owner, blobKey);
      break;
    }
    case "add_switchboard_photo": {
      const { blobKey, fileName, contentType, boardId, metadata, completeChecklist } = payload as {
        blobKey: string; fileName: string; contentType: string; boardId: number;
        metadata: Record<string, string>;
        completeChecklist?: { itemKey: string; body: Record<string, unknown> };
      };
      const blobEntry = await getBlob(owner, blobKey);
      if (!blobEntry) throw new Error("Fotografie rozvaděče nebyla nalezena v lokálním úložišti.");
      const contentSha256 = await offlineBlobSha256(blobEntry.blob);
      const query = new URLSearchParams({ ...metadata, name: fileName, contentType });
      const uploadRes = await fetch(`/api/switchboards/${boardId}/photos?${query}`, { method: "POST", headers: replayHeaders(owner, op.id, { "Content-Type": contentType, "X-Stavba-Content-SHA256": contentSha256 }), body: blobEntry.blob });
      if (!uploadRes.ok) await throwReplayResponse(uploadRes, "Nahrání fotografie rozvaděče selhalo");
      if (completeChecklist) {
        const response = await fetch(`/api/switchboards/${boardId}/checklist/responses/${encodeURIComponent(completeChecklist.itemKey)}`, { method: "PATCH", headers: replayHeaders(owner, `${op.id}-complete`, { "Content-Type": "application/json" }), body: JSON.stringify(completeChecklist.body) });
        if (!response.ok) await throwReplayResponse(response, "Dokončení fotografického bodu selhalo");
      }
      await deleteBlob(owner, blobKey);
      break;
    }
    case "set_switchboard_checklist_response": {
      const { boardId, itemKey, body } = payload as {
        boardId: number;
        itemKey: string;
        body: Record<string, unknown>;
      };
      const res = await fetch(`/api/switchboards/${boardId}/checklist/responses/${encodeURIComponent(itemKey)}`, {
        method: "PATCH",
        headers: replayHeaders(owner, op.id, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) await throwReplayResponse(res, "Uložení kontroly rozvaděče selhalo");
      break;
    }
    default:
      throw new Error(`Neznámý typ operace: ${String(type)}`);
  }
}

// Human-readable Czech labels for each op type
export function opTypeLabel(type: OfflineOpType): string {
  switch (type) {
    case "set_material_consumed": return "Změna spotřeby materiálu";
    case "add_work_session": return "Uložení offline práce";
    case "add_material": return "Přidání materiálu";
    case "start_timer": return "Spuštění časovače";
    case "stop_timer": return "Zastavení časovače";
    case "set_hours": return "Nastavení hodin";
    case "add_photo": return "Nahrání fotky";
    case "add_switchboard_photo": return "Nahrání fotografie rozvaděče";
    case "set_switchboard_checklist_response": return "Uložení kontroly rozvaděče";
    default: return "Neznámá akce";
  }
}

// --- Provider ---

function createLeaseHolderId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `stavba-tab-${suffix}`;
}

export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user, offlineScope, refresh: refreshAuth } = useAuth();
  const owner = useMemo<OfflineOwner | null>(
    () => user && offlineScope ? { userId: user.id, scope: offlineScope } : null,
    [user?.id, offlineScope],
  );
  const [ops, setOps] = useState<OfflineOp[]>([]);
  const [lockedCount, setLockedCount] = useState(0);
  const [legacyCount, setLegacyCount] = useState(0);
  const [isFlushing, setIsFlushing] = useState(false);
  const isFlushingRef = useRef(false);
  const leaseHolderIdRef = useRef(createLeaseHolderId());

  // Load only the current identity partition. Other and legacy records remain
  // locked and are exposed only as counts, never as payloads.
  useEffect(() => {
    let cancelled = false;
    setOps([]);
    setLockedCount(0);
    setLegacyCount(0);
    if (!owner) return () => { cancelled = true; };
    Promise.all([getAllOps(owner), getOfflineIsolationSummary(owner)])
      .then(([ownedOps, summary]) => {
        if (cancelled) return;
        setOps(ownedOps);
        setLockedCount(summary.lockedOps + summary.lockedBlobs);
        setLegacyCount(summary.legacyOps + summary.legacyBlobs);
      })
      .catch((error) => debugLog("offline-queue", "load error", error));
    return () => { cancelled = true; };
  }, [owner]);

  const reloadOps = useCallback(async () => {
    if (!owner) {
      setOps([]);
      return [];
    }
    const fresh = await getAllOps(owner);
    setOps(fresh);
    return fresh;
  }, [owner]);

  const enqueue = useCallback(
    async (params: EnqueueParams) => {
      if (!owner) throw new Error("Offline operaci nelze uložit bez ověřené identity.");
      const op = await enqueueOp(owner, params);
      setOps((prev) => [...prev.filter((existing) => existing.id !== op.id), op]);
      // Register a Background Sync tag so the browser can trigger a flush
      // even when the tab is backgrounded and connectivity returns.
      // Falls back to the online-event flush on browsers without Sync API (Safari).
      if ("serviceWorker" in navigator && "SyncManager" in window) {
        navigator.serviceWorker.ready
          .then((reg) =>
            (reg as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register(
              "offline-flush",
            ),
          )
          .catch(() => {});
      }
    },
    [owner],
  );

  const saveBlob = useCallback(
    async (key: string, blob: Blob, fileName: string) => {
      if (!owner) throw new Error("Offline soubor nelze uložit bez ověřené identity.");
      await saveStoredBlob(owner, key, blob, fileName);
    },
    [owner],
  );

  // Flush all pending ops. Called when coming back online or manually.
  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current || !owner) return;
    isFlushingRef.current = true;
    setIsFlushing(true);
    const leaseHolderId = leaseHolderIdRef.current;
    let leaseHeld = false;
    let leaseLost = false;
    let leaseTimer: ReturnType<typeof setInterval> | null = null;

    try {
      leaseHeld = await acquireOfflineLease(owner, leaseHolderId, LEASE_TTL_MS);
      if (!leaseHeld) {
        debugLog("offline-queue", "replay skipped: another tab owns the lease");
        return;
      }
      leaseTimer = setInterval(() => {
        void renewOfflineLease(owner, leaseHolderId, LEASE_TTL_MS)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch((error) => {
            leaseLost = true;
            debugLog("offline-queue", "lease renewal failed", error);
          });
      }, LEASE_RENEW_MS);

      const identity = await verifyOfflineReplayIdentity(owner);
      if (identity !== "verified") {
        debugLog("offline-queue", `replay paused: ${identity}`);
        if (identity === "unauthenticated" || identity === "scope_mismatch") {
          setOps([]);
          refreshAuth();
          toast({
            title: "Synchronizace pozastavena",
            description: "Lokální akce patří jiné nebo již neplatné relaci a nebyly odeslány.",
            variant: "destructive",
          });
        }
        return;
      }
      const current = await reloadOps();
      const now = Date.now();
      const pending = current.filter(
        (op) => op.status === "pending" && (op.nextAttemptAt ?? 0) <= now,
      );
      if (pending.length === 0) return;

      let succeeded = 0;
      let failedCount = 0;
      let deferredCount = 0;
      const domainsToInvalidate = new Set<string>();

      for (const op of pending) {
        if (leaseLost) {
          debugLog("offline-queue", "replay stopped: cross-tab lease was lost");
          break;
        }
        try {
          await executeOp(owner, op);
          await deleteOp(owner, op.id);
          succeeded++;
          domainsToInvalidate.add("jobs");
          if (op.type === "add_material" || op.type === "set_material_consumed" || op.type === "add_photo") {
            domainsToInvalidate.add("warehouse");
          }
          if (op.type === "set_switchboard_checklist_response" || op.type === "add_switchboard_photo") {
            domainsToInvalidate.add("switchboards");
          }
        } catch (err) {
          const failure = normalizeReplayError(err);
          if (failure.kind === "auth") {
            setOps([]);
            refreshAuth();
            toast({
              title: "Synchronizace pozastavena",
              description: "Přihlášení nebo oprávnění se změnilo. Operace nebyla odeslána.",
              variant: "destructive",
            });
            break;
          }
          const attempts = op.attempts + 1;
          const retryable = failure.kind === "transient" && attempts < OFFLINE_MAX_ATTEMPTS;
          const updated: OfflineOp = {
            ...op,
            attempts,
            errorMessage: failure.message,
            failureKind: failure.kind,
            status: retryable ? "pending" : "failed",
            nextAttemptAt: retryable
              ? Date.now() + offlineBackoffMs(attempts, failure.retryAfterMs)
              : undefined,
          };
          await updateOp(owner, updated);
          if (retryable) deferredCount++;
          else failedCount++;
          debugLog("offline-queue", `op ${op.id} (${op.type}) failed as ${failure.kind}`, failure.message);
          // Preserve FIFO ordering after a transient result. Conflict and
          // permanent failures are isolated for manual resolution, so later
          // independent operations may continue.
          if (retryable) break;
        }
      }

      // Refresh data for affected domains
      if (domainsToInvalidate.has("jobs") && domainsToInvalidate.has("warehouse")) {
        invalidateData(queryClient, "jobs", "warehouse");
      } else if (domainsToInvalidate.has("jobs")) {
        invalidateData(queryClient, "jobs");
      }

      await reloadOps();

      if (deferredCount > 0) {
        toast({
          title: "Synchronizace bude zopakována",
          description: `${deferredCount} ${deferredCount === 1 ? "akce čeká" : "akcí čeká"} na automatický další pokus${succeeded > 0 ? `; ${succeeded} již odesláno` : ""}.`,
        });
      } else if (succeeded > 0 && failedCount === 0) {
        toast({
          title: `Synchronizace dokončena`,
          description: `${succeeded} ${succeeded === 1 ? "akce byla odeslána" : "akcí bylo odesláno"} na server.`,
        });
      } else if (succeeded > 0 && failedCount > 0) {
        toast({
          title: `Částečná synchronizace`,
          description: `${succeeded} odesláno, ${failedCount} selhalo.`,
          variant: "destructive",
        });
      } else if (failedCount > 0) {
        toast({
          title: `Synchronizace selhala`,
          description: `${failedCount} ${failedCount === 1 ? "akce selhala" : "akcí selhalo"}. Zkontrolujte chybovou frontu.`,
          variant: "destructive",
        });
      }
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      if (leaseHeld) {
        await releaseOfflineLease(owner, leaseHolderId).catch((error) => {
          debugLog("offline-queue", "lease release failed", error);
        });
      }
      isFlushingRef.current = false;
      setIsFlushing(false);
    }
  }, [owner, queryClient, refreshAuth, reloadOps, toast]);

  // Auto-flush when coming back online (online-event fallback, works in all browsers)
  useEffect(() => {
    if (!isOnline) return;
    // Small delay so the network is actually ready
    const timer = setTimeout(() => {
      void flushQueue();
    }, 800);
    return () => clearTimeout(timer);
  }, [isOnline, flushQueue]);

  // A transient failure stores its next eligible attempt in IndexedDB. Only
  // that bounded deadline schedules another flush; permanent, conflict and
  // ambiguous outcomes remain visible for explicit user action.
  useEffect(() => {
    if (!isOnline || isFlushing) return;
    const nextAttemptAt = ops
      .filter((op) => op.status === "pending" && op.nextAttemptAt != null)
      .reduce<number | null>(
        (earliest, op) => earliest == null ? op.nextAttemptAt! : Math.min(earliest, op.nextAttemptAt!),
        null,
      );
    if (nextAttemptAt == null) return;
    const timer = setTimeout(() => {
      void flushQueue();
    }, Math.max(0, nextAttemptAt - Date.now()));
    return () => clearTimeout(timer);
  }, [flushQueue, isFlushing, isOnline, ops]);

  // SW Background Sync flush: the service worker posts OFFLINE_FLUSH when the
  // browser fires a "sync" event for the "offline-flush" tag (Chrome/Android).
  // This wakes up the flush even when the tab was backgrounded at reconnection.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleMessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === "OFFLINE_FLUSH") {
        void flushQueue();
      }
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [flushQueue]);

  const retryOp = useCallback(
    async (id: string) => {
      const op = ops.find((o) => o.id === id);
      if (!op || !owner || !canManuallyRetryOfflineFailure(op.failureKind)) return;
      const updated: OfflineOp = {
        ...op,
        attempts: 0,
        status: "pending",
        errorMessage: undefined,
        failureKind: undefined,
        nextAttemptAt: undefined,
      };
      await updateOp(owner, updated);
      await reloadOps();
      if (isOnline) await flushQueue();
    },
    [ops, owner, reloadOps, isOnline, flushQueue],
  );

  const discardOp = useCallback(
    async (id: string) => {
      const op = ops.find((o) => o.id === id);
      if (!owner) return;
      if (op?.type === "add_photo" || op?.type === "add_switchboard_photo") {
        const blobKey = op.payload.blobKey as string | undefined;
        if (blobKey) await deleteBlob(owner, blobKey).catch(() => {});
      }
      await deleteOp(owner, id);
      await reloadOps();
    },
    [ops, owner, reloadOps],
  );

  const discardAll = useCallback(async () => {
    if (!owner) return;
    const failed = ops.filter((o) => o.status === "failed");
    for (const op of failed) {
      if (op.type === "add_photo" || op.type === "add_switchboard_photo") {
        const blobKey = op.payload.blobKey as string | undefined;
        if (blobKey) await deleteBlob(owner, blobKey).catch(() => {});
      }
      await deleteOp(owner, op.id);
    }
    await reloadOps();
  }, [ops, owner, reloadOps]);

  const pendingOps = ops.filter((o) => o.status === "pending");
  const failedOps = ops.filter((o) => o.status === "failed");

  return (
    <OfflineQueueContext.Provider
      value={{
        isOnline,
        pendingOps,
        failedOps,
        pendingCount: pendingOps.length,
        failedCount: failedOps.length,
        lockedCount,
        legacyCount,
        enqueue,
        saveBlob,
        retryOp,
        discardOp,
        discardAll,
        isFlushing,
      }}
    >
      {children}
    </OfflineQueueContext.Provider>
  );
}
