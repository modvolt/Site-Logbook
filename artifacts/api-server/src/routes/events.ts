import { Router, type IRouter } from "express";
import { registerClient } from "../lib/live-updates";

const router: IRouter = Router();

// Keep-alive comment cadence. Must be shorter than nginx's proxy_read_timeout
// (120s) and any intermediate proxy idle timeout, or an otherwise-quiet stream
// gets reaped and the client has to reconnect.
const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream for real-time cross-device refresh. Authenticated
 * (it sits behind the global requireAuth gate). The client opens this with an
 * `EventSource` and listens for `invalidate` events; see
 * `artifacts/stavba/src/hooks/use-live-updates.ts`.
 *
 * The browser may pass its `clientId` as a query parameter so the server can
 * skip sending the event back to the browser that triggered the mutation —
 * that browser already has fresh data from the mutation response.
 */
router.get("/events", (req, res) => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tell nginx not to buffer this response (SSE must flush immediately).
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // Advise the browser to wait 5s before reconnecting after a drop, and send an
  // initial comment so the connection is considered open right away.
  res.write("retry: 5000\n\n");
  res.write(": connected\n\n");

  const unregister = registerClient(res, clientId);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // Ignore — the close handler tears everything down.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unregister();
    res.end();
  });
});

export default router;
