import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuth, requireAuth } from "./middlewares/auth";
import { enforceApiPermission } from "./middlewares/permissions";
import { auditMutations } from "./middlewares/audit";
import { rejectArchivedJobMutations } from "./middlewares/archived-job";
import { broadcastMutations } from "./middlewares/live-updates";
import { trackSessionActivity } from "./middlewares/session-activity";
import {
  attachOfflineResponseScope,
  enforceOfflineReplayScope,
} from "./middlewares/offline-replay-scope";
import { enforceOfflineIdempotency } from "./middlewares/offline-idempotency";
import { record5xxError } from "./lib/server-errors";
import { isPublicApiRequest } from "./lib/public-api-policy";
import { SecretEncryptionError } from "./lib/secret-envelope";
import {
  PublicOriginConfigError,
  publicAppOrigin,
} from "./lib/public-origin";
import {
  redactPublicBearerPath,
  serializeRequestForLog,
} from "./lib/request-log-redaction";
import { PublicAccessTokenIssuanceError } from "./lib/public-access-token";
import {
  isRequestBodyTooLarge,
  parseApiRequestBody,
} from "./middlewares/request-body";

const app: Express = express();

// In production the app sits behind a TLS-terminating reverse proxy (Coolify /
// Traefik, nginx). Trust the first proxy hop so secure cookies are set and the
// client IP (for rate limiting) is read from X-Forwarded-For.
app.set("trust proxy", 1);

const PgStore = connectPgSimple(session);
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET env var is required");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}
if (process.env.NODE_ENV === "production") {
  // A production process must never become healthy while external bearer URLs
  // would be derived from an absent or insecure origin.
  publicAppOrigin();
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req: serializeRequestForLog,
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Track all 5xx responses in an in-memory ring buffer for the Diagnostica page.
// MUST be registered early (before the router and error handler) so that
// res.on('finish') is attached before the response is sent — a middleware
// registered after the router is never reached for handled requests.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.on("finish", () => {
    if (res.statusCode >= 500) {
      record5xxError({
        timestamp: new Date().toISOString(),
        route: redactPublicBearerPath(_req.path) ?? _req.path,
        method: _req.method,
        requestId: String((_req as any).id ?? ""),
        statusCode: res.statusCode,
      });
    }
  });
  next();
});
// API responses are JSON or object streams, so their own CSP can deny every
// active-content source. The SPA receives its more specific CSP from nginx.
// CORP stays relaxed so explicitly public object/image streams remain usable.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);
// The web app and API are served from the same origin (nginx proxies /api), so
// the browser never needs cross-origin access — a wildcard CORS policy only
// widens the attack surface. Lock it down: cross-origin requests are refused by
// default; set CORS_ORIGINS (comma-separated) to allowlist specific origins.
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  }),
);
// Session/authentication is deliberately installed before structured parsers;
// route-specific JSON/form limits are applied below after permission checks.
app.use(
  session({
    store: new PgStore({
      conString: process.env.DATABASE_URL,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    name: "stavba.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // "auto" marks the cookie Secure only when the request is actually HTTPS
      // (determined via "trust proxy" + X-Forwarded-Proto). Behind the Coolify
      // TLS-terminating proxy the cookie is Secure; over plain HTTP (local
      // docker compose) it is sent without the Secure flag so login still works.
      // A hard `secure: true` silently drops the cookie whenever the forwarded
      // proto is misread as http, leaving the user stuck on the login screen.
      secure: "auto",
      // 14 days of inactivity. `rolling: true` refreshes this on every request,
      // so active users are never logged out — only genuinely idle sessions
      // expire after two weeks (down from 30 days, per the security review).
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }),
);

// API responses contain user- and permission-scoped data. Browser HTTP caches
// must never retain them implicitly; the service worker may persist only its
// explicit offline allowlist in a separate identity-partitioned Cache Storage
// namespace.
app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

app.use("/api", attachAuth);
app.use("/api", attachOfflineResponseScope);
app.use("/api", trackSessionActivity);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApiRequest(req.method, req.originalUrl)) return next();
  return requireAuth(req, res, next);
});

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApiRequest(req.method, req.originalUrl)) return next();
  return enforceOfflineReplayScope(req, res, next);
});

// Enforce module permissions on the backend. Role defaults are resolved with
// per-user allow/deny overrides before this middleware runs.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApiRequest(req.method, req.originalUrl)) return next();
  return enforceApiPermission(req, res, next);
});

// Authentication and permission checks run before any structured body is
// buffered. Only named base64 workflows receive the larger authenticated cap.
app.use("/api", parseApiRequestBody);

app.use("/api", enforceOfflineIdempotency);

// Record successful data mutations to the audit log (after auth so the actor is known)
app.use("/api", auditMutations);

// Archived jobs remain readable for recovery/audit, but their related records
// are immutable until an administrator explicitly restores the job.
app.use("/api", rejectArchivedJobMutations);

// Broadcast successful mutations to other devices' open screens (SSE push)
app.use("/api", broadcastMutations);

app.use("/api", router);

// Catch-all 404 for unknown /api routes
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Zadaná cesta neexistuje." });
});

// Global error handler — must be last and must have 4 params so Express
// recognises it as an error-handling middleware.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as any).id ?? "unknown";
  const method = req.method;
  const path = redactPublicBearerPath(req.path) ?? req.path;

  if (isRequestBodyTooLarge(err)) {
    req.log?.warn({ requestId, method, path }, "Request body limit exceeded");
    if (!res.headersSent) {
      res.status(413).json({
        error: "Požadavek je příliš velký pro tuto operaci.",
        code: "request_body_too_large",
        requestId,
      });
    }
    return;
  }

  if (err instanceof SecretEncryptionError) {
    req.log?.error(
      { requestId, method, path, code: err.code },
      "Secret encryption operation failed",
    );
    if (!res.headersSent) {
      res.status(503).json({
        error: "Šifrování citlivých údajů není dostupné. Kontaktujte správce systému.",
        code: "secret_encryption_unavailable",
        requestId,
      });
    }
    return;
  }

  if (err instanceof PublicOriginConfigError) {
    req.log?.error(
      { requestId, method, path, code: err.code },
      "Trusted public application origin is unavailable",
    );
    if (!res.headersSent) {
      res.status(503).json({
        error: "Veřejný odkaz nyní nelze bezpečně vytvořit. Kontaktujte správce systému.",
        code: "public_origin_unavailable",
        requestId,
      });
    }
    return;
  }

  if (err instanceof PublicAccessTokenIssuanceError) {
    req.log?.warn(
      { requestId, method, path, code: err.code },
      "Public token issuance rejected for inactive issuer",
    );
    if (!res.headersSent) {
      res.status(409).json({
        error: "Váš přístup byl mezitím ukončen. Přihlaste se znovu.",
        code: err.code,
        requestId,
      });
    }
    return;
  }

  if (err instanceof Error) {
    req.log?.error({ requestId, method, path, stack: err.stack }, "Unhandled error");
  } else {
    req.log?.error({ requestId, method, path, err }, "Unhandled error (non-Error)");
  }

  if (res.headersSent) return;

  res.status(500).json({
    error: "Došlo k neočekávané chybě serveru. Zkuste to prosím znovu.",
    requestId,
  });
});

export default app;
