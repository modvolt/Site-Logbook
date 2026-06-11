import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuth, requireAuth, requireWriteAccess } from "./middlewares/auth";
import { auditMutations } from "./middlewares/audit";

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
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

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

// Public endpoints: storage object proxy + auth endpoints + health
const PUBLIC_PREFIXES = ["/api/healthz", "/api/auth/", "/api/storage/public-objects/"];

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const url = req.originalUrl.split("?")[0];
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return next();
  return requireAuth(req, res, next);
});

// Block write operations for guests on all non-auth endpoints
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const url = req.originalUrl.split("?")[0];
  if (url.startsWith("/api/auth/")) return next();
  if (url.startsWith("/api/preferences")) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  return requireWriteAccess(req, res, next);
});

// Record successful data mutations to the audit log (after auth so the actor is known)
app.use("/api", auditMutations);

app.use("/api", router);

export default app;
