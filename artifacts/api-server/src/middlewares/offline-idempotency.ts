import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { OFFLINE_SCOPE_HEADER } from "./offline-replay-scope";
import {
  OFFLINE_CONTENT_DIGEST_HEADER,
  offlineContentDigest,
  requiresOfflineContentDigest,
} from "../lib/offline-content-digest";

const IDEMPOTENCY_HEADER = "idempotency-key";
const LOCK_NAMESPACE = 8452;
const MAX_CAPTURED_RESPONSE_BYTES = 64 * 1024;
const PENDING_HEARTBEAT_MS = 30_000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

type LedgerState = "pending" | "completed" | "ambiguous";

interface LedgerRow {
  id: number;
  request_hash: string;
  state: LedgerState;
  response_status: number | null;
  response_content_type: string | null;
  response_body: unknown;
  active_pending: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  if (Buffer.isBuffer(value)) {
    return { sha256: createHash("sha256").update(value).digest("hex"), bytes: value.length };
  }
  return value ?? null;
}

export function fingerprintOfflineReplayRequest(req: Pick<
  Request,
  "method" | "originalUrl" | "body" | "headers"
>): string {
  const url = new URL(req.originalUrl, "http://offline.local");
  const query = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
  );
  const contentType = typeof req.headers["content-type"] === "string"
    ? req.headers["content-type"].split(";", 1)[0]!.trim().toLowerCase()
    : null;
  const contentLength = typeof req.headers["content-length"] === "string"
    ? req.headers["content-length"]
    : null;
  const canonical = stableValue({
    method: req.method.toUpperCase(),
    path: url.pathname,
    query,
    contentType,
    contentLength: req.body === undefined ? contentLength : null,
    contentDigest: req.headers[OFFLINE_CONTENT_DIGEST_HEADER] ?? null,
    body: req.body === undefined ? null : req.body,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function pathWithoutQuery(req: Request): string {
  return new URL(req.originalUrl, "http://offline.local").pathname;
}

function capturedResponseBody(body: unknown): unknown {
  if (body === undefined) return null;
  try {
    return Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_CAPTURED_RESPONSE_BYTES
      ? body
      : null;
  } catch {
    return null;
  }
}

async function finishTransaction(
  client: PoolClient,
  command: "COMMIT" | "ROLLBACK",
): Promise<void> {
  try {
    await client.query(command);
  } finally {
    client.release();
  }
}

/**
 * Durable replay envelope for mutations emitted by the scoped offline queue.
 * A short transaction-level advisory lock serializes ledger admission without
 * reserving a shared pool connection for the whole HTTP operation. The durable
 * pending record has a heartbeat while the request is active. A stale pending
 * request is promoted to `ambiguous` and is never executed automatically again.
 */
export async function enforceOfflineIdempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const method = req.method.toUpperCase();
  const offlineScope = req.get(OFFLINE_SCOPE_HEADER);
  const idempotencyKey = req.get(IDEMPOTENCY_HEADER);
  if (!MUTATION_METHODS.has(method) || !offlineScope) {
    next();
    return;
  }
  if (!idempotencyKey) {
    res.status(400).json({
      error: "Offline mutace vyžaduje Idempotency-Key.",
      code: "idempotency_key_required",
    });
    return;
  }
  if (!KEY_PATTERN.test(idempotencyKey)) {
    res.status(400).json({
      error: "Neplatný Idempotency-Key.",
      code: "invalid_idempotency_key",
    });
    return;
  }
  if (requiresOfflineContentDigest(req) && !offlineContentDigest(req)) {
    res.status(400).json({
      error: "Offline upload vyžaduje platný SHA-256 obsahu.",
      code: "offline_content_digest_required",
    });
    return;
  }
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized", code: "offline_identity_unavailable" });
    return;
  }

  const path = pathWithoutQuery(req);
  const requestHash = fingerprintOfflineReplayRequest(req);
  const lockIdentity = `${req.auth.userId}:${offlineScope}:${method}:${path}:${idempotencyKey}`;
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const lockResult = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock($1, hashtext($2)) as acquired",
      [LOCK_NAMESPACE, lockIdentity],
    );
    if (lockResult.rows[0]?.acquired !== true) {
      await finishTransaction(client, "ROLLBACK");
      client = null;
      res.setHeader("Retry-After", "2");
      res.status(409).json({
        error: "Stejná offline operace se právě zpracovává.",
        code: "idempotency_in_progress",
      });
      return;
    }

    const existingResult = await client.query<LedgerRow>(
      `select id, request_hash, state, response_status, response_content_type, response_body,
              (state = 'pending' and last_seen_at >= now() - interval '90 seconds') as active_pending
         from api_idempotency_records
        where user_id = $1
          and offline_scope = $2
          and method = $3
          and path = $4
          and idempotency_key = $5`,
      [req.auth.userId, offlineScope, method, path, idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        await finishTransaction(client, "ROLLBACK");
        client = null;
        res.status(409).json({
          error: "Idempotency-Key už byl použit pro jiný požadavek.",
          code: "idempotency_key_reused",
        });
        return;
      }
      if (existing.active_pending) {
        await finishTransaction(client, "ROLLBACK");
        client = null;
        res.setHeader("Retry-After", "2");
        res.status(409).json({
          error: "Stejná offline operace se právě zpracovává.",
          code: "idempotency_in_progress",
        });
        return;
      }
      if (existing.state !== "completed") {
        await client.query(
          "update api_idempotency_records set state = 'ambiguous', last_seen_at = now() where id = $1",
          [existing.id],
        );
        await finishTransaction(client, "COMMIT");
        client = null;
        res.status(409).json({
          error: "Výsledek předchozího pokusu nelze bezpečně určit. Operace nebyla zopakována.",
          code: "idempotency_ambiguous",
        });
        return;
      }

      await client.query(
        "update api_idempotency_records set last_seen_at = now() where id = $1",
        [existing.id],
      );
      await finishTransaction(client, "COMMIT");
      client = null;
      res.setHeader("Idempotency-Replayed", "true");
      if (existing.response_content_type) {
        res.setHeader("Content-Type", existing.response_content_type);
      }
      res.status(existing.response_status ?? 200);
      if (existing.response_body === null) res.end();
      else res.json(existing.response_body);
      return;
    }

    const inserted = await client.query<{ id: number }>(
      `insert into api_idempotency_records
        (user_id, offline_scope, idempotency_key, method, path, request_hash, state)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       returning id`,
      [req.auth.userId, offlineScope, idempotencyKey, method, path, requestHash],
    );
    const recordId = inserted.rows[0]!.id;
    await finishTransaction(client, "COMMIT");
    client = null;

    let jsonBody: unknown = undefined;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      jsonBody = body;
      return originalJson(body);
    }) as Response["json"];

    let finalized = false;
    const heartbeat = setInterval(() => {
      void pool.query(
        "update api_idempotency_records set last_seen_at = now() where id = $1 and state = 'pending'",
        [recordId],
      ).catch((error) => {
        req.log?.error({ err: error, recordId }, "Failed to heartbeat offline idempotency record");
      });
    }, PENDING_HEARTBEAT_MS);
    heartbeat.unref();

    const finalize = async (state: LedgerState): Promise<void> => {
      if (finalized) return;
      finalized = true;
      clearInterval(heartbeat);
      try {
        if (state === "completed" && [408, 425, 429].includes(res.statusCode)) {
          await pool.query("delete from api_idempotency_records where id = $1", [recordId]);
        } else {
          const finalState: LedgerState = res.statusCode >= 500 ? "ambiguous" : state;
          await pool.query(
            `update api_idempotency_records
                set state = $2,
                    response_status = $3,
                    response_content_type = $4,
                    response_body = $5,
                    completed_at = case when $2 = 'completed' then now() else null end,
                    last_seen_at = now()
              where id = $1`,
            [
              recordId,
              finalState,
              finalState === "completed" ? res.statusCode : null,
              finalState === "completed" ? String(res.getHeader("Content-Type") ?? "") || null : null,
              finalState === "completed" ? capturedResponseBody(jsonBody) : null,
            ],
          );
        }
      } catch (error) {
        req.log?.error({ err: error, recordId }, "Failed to finalize offline idempotency record");
      }
    };

    res.once("finish", () => { void finalize("completed"); });
    res.once("close", () => {
      if (!res.writableFinished) void finalize("ambiguous");
    });
    next();
  } catch (error) {
    if (client) {
      await finishTransaction(client, "ROLLBACK").catch(() => undefined);
    }
    req.log?.error({ err: error }, "Offline idempotency ledger unavailable");
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: "Offline operaci nyní nelze bezpečně deduplikovat.",
      code: "idempotency_unavailable",
    });
  }
}
