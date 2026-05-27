import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuth, requireAuth, requireWriteAccess } from "./middlewares/auth";

const app: Express = express();

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
app.use(cors());
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
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 30,
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

app.use("/api", router);

export default app;
