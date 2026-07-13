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
import { broadcastMutations } from "./middlewares/live-updates";
import { trackSessionActivity } from "./middlewares/session-activity";
import { record5xxError } from "./lib/server-errors";

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

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
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
        route: _req.path,
        method: _req.method,
        requestId: String((_req as any).id ?? ""),
        statusCode: res.statusCode,
      });
    }
  });
  next();
});
// Security headers. CSP is left off because this service only serves JSON and
// proxied object streams (the SPA is served by nginx, which owns its own CSP);
// CORP is relaxed so the browser can load object/image streams from /api.
app.use(
  helmet({
    contentSecurityPolicy: false,
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
// Request body size cap for JSON / form payloads — this is what gates CSV bulk
// imports and base64 uploads. Tunable via MAX_REQUEST_BODY_MB (default 50). Keep
// nginx's client_max_body_size (artifacts/stavba/nginx.conf) at/above this.
// Binary file uploads (photos/documents) have their own, higher cap in
// storage.ts / billing-documents.ts and do not go through this parser.
const maxBodyMb = (() => {
  const n = Number(process.env.MAX_REQUEST_BODY_MB);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();
const bodyLimit = `${maxBodyMb}mb`;
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

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

app.use("/api", attachAuth);
app.use("/api", trackSessionActivity);

// Public endpoints must bypass both authentication and permission enforcement.
// Keep this list centralized so a route cannot pass one guard and fail the next.
const PUBLIC_PREFIXES = ["/api/healthz", "/api/auth/", "/api/storage/public-objects/", "/api/ppe/sign/", "/api/sign/", "/api/quotes/public/", "/api/q/board/", "/api/internal/"];

function isPublicApiRequest(req: Request): boolean {
  const url = req.originalUrl.split("?")[0];
  return PUBLIC_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix));
}

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApiRequest(req)) return next();
  return requireAuth(req, res, next);
});

// Enforce module permissions on the backend. Role defaults are resolved with
// per-user allow/deny overrides before this middleware runs.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApiRequest(req)) return next();
  const url = req.originalUrl.split("?")[0];
  if (url.startsWith("/api/preferences")) return next();
  return enforceApiPermission(req, res, next);
});

// Record successful data mutations to the audit log (after auth so the actor is known)
app.use("/api", auditMutations);

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
  const path = req.path;

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
