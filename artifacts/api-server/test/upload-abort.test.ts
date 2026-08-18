import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import http, { type Server } from "node:http";

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("bounded raw upload parsing", () => {
  it("returns 413 without invoking storage work for an oversized body", async () => {
    let invoked = false;
    const app = express();
    app.post("/upload", express.raw({ type: () => true, limit: 16 }), (_req, res) => {
      invoked = true;
      res.sendStatus(204);
    });
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.sendStatus(error.status ?? 500);
    });
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ method: "POST", port, path: "/upload", headers: { "Content-Type": "application/octet-stream" } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end(Buffer.alloc(17));
    });
    expect(status).toBe(413);
    expect(invoked).toBe(false);
  });

  it("does not invoke storage work after the client aborts a partial upload", async () => {
    let invoked = false;
    const app = express();
    app.post("/upload", express.raw({ type: () => true, limit: 1_024 }), (_req, res) => {
      invoked = true;
      res.sendStatus(204);
    });
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (!res.headersSent) res.sendStatus(400);
    });
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      const req = http.request({
        method: "POST",
        port,
        path: "/upload",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "100" },
      });
      req.on("error", () => resolve());
      req.write(Buffer.alloc(10));
      req.destroy();
      req.on("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(invoked).toBe(false);
  });
});
