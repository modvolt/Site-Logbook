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
  type OfflineOp,
  type OfflineOwner,
  type OfflineOpType,
} from "@/lib/offline-queue";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { invalidateData } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { debugLog } from "@/lib/pwa";
import { useAuth } from "@/hooks/use-auth";
import { verifyOfflineReplayIdentity } from "@/lib/offline-replay";

const MAX_ATTEMPTS = 3;

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
  headers: Record<string, string> = {},
): Record<string, string> {
  return { ...headers, "X-Stavba-Offline-Scope": owner.scope };
}

async function executeOp(owner: OfflineOwner, op: OfflineOp): Promise<void> {
  const { type, jobId, payload } = op;

  switch (type) {
    case "add_material": {
      const res = await fetch(`/api/jobs/${jobId}/materials`, {
        method: "POST",
        headers: replayHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "start_timer": {
      const { personId } = payload as { personId: number };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}/start`, {
        method: "POST",
        headers: replayHeaders(owner, { "Idempotency-Key": op.id }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "stop_timer": {
      const { personId } = payload as { personId: number };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}/stop`, {
        method: "POST",
        headers: replayHeaders(owner, { "Idempotency-Key": op.id }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "set_material_consumed": {
      const { materialId, done } = payload as { materialId: number; done: boolean };
      const res = await fetch(`/api/jobs/${jobId}/materials/${materialId}`, {
        method: "PATCH",
        headers: replayHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({ done }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "add_work_session": {
      const res = await fetch(`/api/jobs/${jobId}/work-sessions`, {
        method: "POST",
        headers: replayHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ...payload, idempotencyKey: op.id }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "set_hours": {
      const { personId, hours, reason } = payload as { personId: number; hours: number; reason: string };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}`, {
        method: "PATCH",
        headers: replayHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({ hours, reason }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
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

      // Upload the blob to object storage
      const query = new URLSearchParams({ name: fileName, contentType });
      const uploadRes = await fetch(`/api/storage/uploads?${query}`, {
        method: "POST",
        headers: replayHeaders(owner, { "Content-Type": contentType }),
        body: blobEntry.blob,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.text().catch(() => "");
        throw new Error(`Nahrání fotky selhalo (HTTP ${uploadRes.status}): ${body.slice(0, 200)}`);
      }
      const { objectPath } = (await uploadRes.json()) as { objectPath: string };

      // Register attachment record
      const attachRes = await fetch(`/api/jobs/${jobId}/attachments`, {
        method: "POST",
        headers: replayHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          type: "photo",
          fileName,
          url: objectPath,
          description: "Foto ze stavby",
        }),
      });
      if (!attachRes.ok) {
        const body = await attachRes.text().catch(() => "");
        throw new Error(`Uložení fotky selhalo (HTTP ${attachRes.status}): ${body.slice(0, 200)}`);
      }

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
      const query = new URLSearchParams({ ...metadata, name: fileName, contentType });
      const uploadRes = await fetch(`/api/switchboards/${boardId}/photos?${query}`, { method: "POST", headers: replayHeaders(owner, { "Content-Type": contentType, "Idempotency-Key": op.id }), body: blobEntry.blob });
      if (!uploadRes.ok) {
        const responseBody = await uploadRes.text().catch(() => "");
        throw new Error(`Nahrání fotografie rozvaděče selhalo (HTTP ${uploadRes.status}): ${responseBody.slice(0, 200)}`);
      }
      if (completeChecklist) {
        const response = await fetch(`/api/switchboards/${boardId}/checklist/responses/${encodeURIComponent(completeChecklist.itemKey)}`, { method: "PATCH", headers: replayHeaders(owner, { "Content-Type": "application/json", "Idempotency-Key": `${op.id}-complete` }), body: JSON.stringify(completeChecklist.body) });
        if (!response.ok) {
          const responseBody = await response.text().catch(() => "");
          throw new Error(`Dokončení fotografického bodu selhalo (HTTP ${response.status}): ${responseBody.slice(0, 200)}`);
        }
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
        headers: replayHeaders(owner, { "Content-Type": "application/json", "Idempotency-Key": op.id }),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${responseBody.slice(0, 200)}`);
      }
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

    try {
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
      const pending = current.filter((o) => o.status === "pending");
      if (pending.length === 0) return;

      let succeeded = 0;
      let failedCount = 0;
      const jobsAffected = new Set<number>();
      const domainsToInvalidate = new Set<string>();

      for (const op of pending) {
        try {
          await executeOp(owner, op);
          await deleteOp(owner, op.id);
          succeeded++;
          jobsAffected.add(op.jobId);
          domainsToInvalidate.add("jobs");
          if (op.type === "add_material" || op.type === "set_material_consumed" || op.type === "add_photo") {
            domainsToInvalidate.add("warehouse");
          }
          if (op.type === "set_switchboard_checklist_response" || op.type === "add_switchboard_photo") {
            domainsToInvalidate.add("switchboards");
          }
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : "Neznámá chyba";
          const updated: OfflineOp = {
            ...op,
            attempts: op.attempts + 1,
            errorMessage,
            status: op.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending",
          };
          await updateOp(owner, updated);
          failedCount++;
          debugLog("offline-queue", `op ${op.id} (${op.type}) failed`, errorMessage);
        }
      }

      // Refresh data for affected domains
      if (domainsToInvalidate.has("jobs") && domainsToInvalidate.has("warehouse")) {
        invalidateData(queryClient, "jobs", "warehouse");
      } else if (domainsToInvalidate.has("jobs")) {
        invalidateData(queryClient, "jobs");
      }

      await reloadOps();

      if (succeeded > 0 && failedCount === 0) {
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
      if (!op || !owner) return;
      const updated: OfflineOp = { ...op, attempts: 0, status: "pending", errorMessage: undefined };
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
