import type { Request, Response, NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Paths (relative to /api) whose mutations should NOT be auto-audited here:
// - auth: login/logout/setup are session events, not domain mutations
// - storage: file upload/serve requests are not domain mutations
// - gdpr: the erase route writes its own, richer audit entry
// - billing/bank-statements: parse is read-only (huge base64 body); confirm
//   writes its own per-invoice audit entries
const SKIP_PREFIXES = [
  "/auth/",
  "/storage/",
  "/gdpr/",
  "/billing/bank-statements/",
];

const REDACT_KEYS = new Set(["password", "passwordHash", "currentPassword", "newPassword"]);

function actionForMethod(method: string): string {
  switch (method) {
    case "POST":
      return "create";
    case "PATCH":
    case "PUT":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

function isNumericSegment(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && String(n) === s;
}

// Resolve the *deepest* resource in the path so nested routes are attributed to
// the entity actually mutated. For example:
//   /jobs/123              -> { entityType: "jobs",  entityId: 123 }
//   /jobs/123/tasks/456    -> { entityType: "tasks", entityId: 456 }
//   /jobs/123/tasks (POST) -> { entityType: "tasks", entityId: null }
function parsePath(path: string): { entityType: string; entityId: number | null } {
  const segments = path.split("/").filter((s) => s.length > 0);
  let entityType = "unknown";
  let entityId: number | null = null;
  for (const seg of segments) {
    if (isNumericSegment(seg)) {
      entityId = Number(seg);
    } else {
      // A new resource name starts a new entity context; clear any id that
      // belonged to the parent resource.
      entityType = seg;
      entityId = null;
    }
  }
  return { entityType, entityId };
}

function buildSummary(method: string, path: string, body: unknown): string {
  let bodyStr = "";
  if (body && typeof body === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      redacted[k] = REDACT_KEYS.has(k) ? "[redacted]" : v;
    }
    try {
      bodyStr = JSON.stringify(redacted);
    } catch {
      bodyStr = "";
    }
  }
  const base = `${method} ${path}`;
  const full = bodyStr ? `${base} ${bodyStr}` : base;
  return full.length > 1000 ? `${full.slice(0, 997)}...` : full;
}

export function auditMutations(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const relPath = req.path;
  if (SKIP_PREFIXES.some((p) => relPath.startsWith(p))) {
    next();
    return;
  }

  // Capture the JSON response body so we can recover the id of created entities.
  let responsePayload: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    responsePayload = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;

    const { entityType, entityId: pathId } = parsePath(relPath);
    let entityId = pathId;
    if (entityId == null && responsePayload && typeof responsePayload === "object") {
      const maybeId = (responsePayload as { id?: unknown }).id;
      if (typeof maybeId === "number" && Number.isInteger(maybeId)) {
        entityId = maybeId;
      }
    }

    const auth = req.auth;
    void db
      .insert(auditLogTable)
      .values({
        actorUserId: auth?.userId ?? null,
        actorName: auth?.name ?? auth?.username ?? null,
        action: actionForMethod(req.method),
        entityType,
        entityId,
        summary: buildSummary(req.method, relPath, req.body),
        method: req.method,
        path: relPath,
      })
      .catch((err) => {
        req.log.error({ err }, "Failed to write audit log entry");
      });
  });

  next();
}
