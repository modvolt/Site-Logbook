import {
  createContext,
  useContext,
  useEffect,
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
  type OfflineOp,
  type OfflineOpType,
} from "@/lib/offline-queue";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { invalidateData } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { debugLog } from "@/lib/pwa";

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
  enqueue: (params: EnqueueParams) => Promise<void>;
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

async function executeOp(op: OfflineOp): Promise<void> {
  const { type, jobId, payload } = op;

  switch (type) {
    case "add_material": {
      const res = await fetch(`/api/jobs/${jobId}/materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      break;
    }
    case "set_hours": {
      const { personId, hours } = payload as { personId: number; hours: number };
      const res = await fetch(`/api/jobs/${jobId}/time-entries/${personId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours }),
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
      const blobEntry = await getBlob(blobKey);
      if (!blobEntry) throw new Error("Fotka nebyla nalezena v lokálním úložišti.");

      // Upload the blob to object storage
      const query = new URLSearchParams({ name: fileName, contentType });
      const uploadRes = await fetch(`/api/storage/uploads?${query}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
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
        headers: { "Content-Type": "application/json" },
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
      await deleteBlob(blobKey);
      break;
    }
    default:
      throw new Error(`Neznámý typ operace: ${String(type)}`);
  }
}

// Human-readable Czech labels for each op type
export function opTypeLabel(type: OfflineOpType): string {
  switch (type) {
    case "add_material": return "Přidání materiálu";
    case "start_timer": return "Spuštění časovače";
    case "stop_timer": return "Zastavení časovače";
    case "set_hours": return "Nastavení hodin";
    case "add_photo": return "Nahrání fotky";
    default: return "Neznámá akce";
  }
}

// --- Provider ---

export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [ops, setOps] = useState<OfflineOp[]>([]);
  const [isFlushing, setIsFlushing] = useState(false);
  const isFlushingRef = useRef(false);

  // Load all ops from IndexedDB on mount
  useEffect(() => {
    getAllOps().then(setOps).catch((e) => debugLog("offline-queue", "load error", e));
  }, []);

  const reloadOps = useCallback(async () => {
    const fresh = await getAllOps();
    setOps(fresh);
    return fresh;
  }, []);

  const enqueue = useCallback(
    async (params: EnqueueParams) => {
      const op = await enqueueOp(params);
      setOps((prev) => [...prev, op]);
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
    [],
  );

  // Flush all pending ops. Called when coming back online or manually.
  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;
    setIsFlushing(true);

    try {
      const current = await reloadOps();
      const pending = current.filter((o) => o.status === "pending");
      if (pending.length === 0) return;

      let succeeded = 0;
      let failedCount = 0;
      const jobsAffected = new Set<number>();
      const domainsToInvalidate = new Set<string>();

      for (const op of pending) {
        try {
          await executeOp(op);
          await deleteOp(op.id);
          succeeded++;
          jobsAffected.add(op.jobId);
          domainsToInvalidate.add("jobs");
          if (op.type === "add_material" || op.type === "add_photo") {
            domainsToInvalidate.add("warehouse");
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
          await updateOp(updated);
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
  }, [queryClient, reloadOps, toast]);

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
      if (!op) return;
      const updated: OfflineOp = { ...op, attempts: 0, status: "pending", errorMessage: undefined };
      await updateOp(updated);
      await reloadOps();
      if (isOnline) await flushQueue();
    },
    [ops, reloadOps, isOnline, flushQueue],
  );

  const discardOp = useCallback(
    async (id: string) => {
      const op = ops.find((o) => o.id === id);
      if (op?.type === "add_photo") {
        const blobKey = op.payload.blobKey as string | undefined;
        if (blobKey) await deleteBlob(blobKey).catch(() => {});
      }
      await deleteOp(id);
      await reloadOps();
    },
    [ops, reloadOps],
  );

  const discardAll = useCallback(async () => {
    const failed = ops.filter((o) => o.status === "failed");
    for (const op of failed) {
      if (op.type === "add_photo") {
        const blobKey = op.payload.blobKey as string | undefined;
        if (blobKey) await deleteBlob(blobKey).catch(() => {});
      }
      await deleteOp(op.id);
    }
    await reloadOps();
  }, [ops, reloadOps]);

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
        enqueue,
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
