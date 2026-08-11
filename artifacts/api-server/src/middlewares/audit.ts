import type { Request, Response, NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";
import { redactPublicBearerPath } from "../lib/request-log-redaction";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Paths (relative to /api) whose mutations should NOT be auto-audited here:
// - auth: login/logout/setup are session events, not domain mutations
// - storage: file upload/serve requests are not domain mutations
// - gdpr: the erase route writes its own, richer audit entry
// - billing/bank-statements: parse is read-only (huge base64 body); confirm
//   writes its own per-invoice audit entries
// - billing/email-import: connect/disconnect/sync write their own richer audit
//   entries (and import/ignore/reprocess are not domain mutations worth a generic log)
const SKIP_PREFIXES = [
  "/auth/",
  "/storage/",
  "/gdpr/",
  "/billing/bank-statements/",
  "/billing/email-import/",
  // WebAuthn: challenges and credential management are session events, not domain mutations.
  // Admin credential deletions write their own richer audit entries in webauthn.ts.
  "/auth/webauthn/",
];

// Path suffixes to skip — these routes write their own richer audit entries.
const SKIP_SUFFIXES = ["/audit-access"];

// Exact route shapes whose domain mutation and audit row share one transaction.
const SKIP_PATTERNS = [
  /^\/admin\/health\/operational-alert-outbox\/\d+\/requeue$/,
  /^\/users\/\d+\/offboard$/,
  /^\/billing\/documents\/\d+\/(?:disposition|status)$/,
];

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
function parsePath(path: string): {
  entityType: string;
  entityId: number | null;
} {
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

function buildSummary(method: string, path: string): string {
  // This best-effort middleware is non-evidentiary request metadata. Request
  // bodies are intentionally excluded because a denylist cannot safely cover
  // future domain fields, mixed casing, or arbitrary nested payloads.
  return `${method} ${path}`;
}

export function auditMutations(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const requestPath = req.path;
  const relPath = redactPublicBearerPath(requestPath) ?? requestPath;
  if (SKIP_PREFIXES.some((p) => relPath.startsWith(p))) {
    next();
    return;
  }
  if (SKIP_SUFFIXES.some((s) => relPath.endsWith(s))) {
    next();
    return;
  }
  if (SKIP_PATTERNS.some((pattern) => pattern.test(relPath))) {
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
    if (
      entityId == null &&
      responsePayload &&
      typeof responsePayload === "object"
    ) {
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
        summary: buildSummary(req.method, relPath),
        method: req.method,
        path: relPath,
      })
      .catch((err) => {
        req.log.error({ err }, "Failed to write audit log entry");
      });
  });

  next();
}
