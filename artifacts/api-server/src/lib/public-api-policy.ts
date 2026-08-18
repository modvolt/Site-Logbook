import { classifyPublicBearerRoute } from "./public-bearer-route-policy";

type PublicApiRoute = {
  methods: ReadonlySet<string>;
  path: RegExp;
};

const READ_METHODS = new Set(["GET", "HEAD"]);
const POST_ONLY = new Set(["POST"]);

/**
 * Explicit public API surface. A route is private unless both its HTTP method
 * and normalized path match one of these entries.
 */
const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  { methods: READ_METHODS, path: /^\/api\/healthz$/ },
  { methods: READ_METHODS, path: /^\/api\/auth\/me$/ },
  { methods: POST_ONLY, path: /^\/api\/auth\/(?:login|logout|setup)$/ },
  { methods: POST_ONLY, path: /^\/api\/auth\/webauthn\/login\/(?:begin|complete)$/ },
  { methods: READ_METHODS, path: /^\/api\/storage\/public-objects\/.+$/ },
  { methods: POST_ONLY, path: /^\/api\/internal\/backup-trigger$/ },
];

function normalizePath(originalUrl: string): string {
  const path = originalUrl.split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function isPublicApiRequest(method: string, originalUrl: string): boolean {
  if (classifyPublicBearerRoute(method, originalUrl)) return true;
  const normalizedMethod = method.toUpperCase();
  const path = normalizePath(originalUrl);
  return PUBLIC_API_ROUTES.some(
    (route) => route.methods.has(normalizedMethod) && route.path.test(path),
  );
}
