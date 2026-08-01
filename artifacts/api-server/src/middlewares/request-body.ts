import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { isPublicApiRequest } from "../lib/public-api-policy";

const KIB = 1024;
const MIB = 1024 * KIB;

export const API_BODY_LIMITS = Object.freeze({
  authenticatedJsonBytes: 1 * MIB,
  publicJsonBytes: 1 * MIB,
  largeAuthenticatedJsonBytes: 32 * MIB,
  urlEncodedBytes: 256 * KIB,
});

const LARGE_AUTHENTICATED_JSON_ROUTES: readonly RegExp[] = [
  /^\/api\/billing\/bank-statements\/parse$/,
  /^\/api\/jobs\/\d+\/(?:send-email|job-sheet)$/,
  /^\/api\/customers\/\d+\/send-credentials-email$/,
];

function normalizedPath(req: Pick<Request, "originalUrl">): string {
  const path = req.originalUrl.split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function jsonBodyLimitForRequest(
  req: Pick<Request, "method" | "originalUrl">,
): number {
  const path = normalizedPath(req);
  if (isPublicApiRequest(req.method, path)) {
    return API_BODY_LIMITS.publicJsonBytes;
  }
  if (
    req.method.toUpperCase() === "POST" &&
    LARGE_AUTHENTICATED_JSON_ROUTES.some((pattern) => pattern.test(path))
  ) {
    return API_BODY_LIMITS.largeAuthenticatedJsonBytes;
  }
  return API_BODY_LIMITS.authenticatedJsonBytes;
}

const jsonParsers = new Map<number, RequestHandler>();
function jsonParser(limit: number): RequestHandler {
  let parser = jsonParsers.get(limit);
  if (!parser) {
    parser = express.json({ limit });
    jsonParsers.set(limit, parser);
  }
  return parser;
}

const urlEncodedParser = express.urlencoded({
  extended: true,
  limit: API_BODY_LIMITS.urlEncodedBytes,
});

/** Parse structured API bodies only after authentication and permission checks. */
export function parseApiRequestBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  jsonParser(jsonBodyLimitForRequest(req))(req, res, (jsonError?: unknown) => {
    if (jsonError) {
      next(jsonError);
      return;
    }
    urlEncodedParser(req, res, next);
  });
}

export function isRequestBodyTooLarge(error: unknown): boolean {
  const candidate = error as { type?: string; status?: number } | null;
  return candidate?.type === "entity.too.large" || candidate?.status === 413;
}
