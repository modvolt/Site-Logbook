export type PublicBearerRouteFamily =
  | "job_signature"
  | "ppe_signature"
  | "ppe_confirmation"
  | "quote"
  | "switchboard";

export type PublicBearerRoute = {
  family: PublicBearerRouteFamily;
  requestClass: "read" | "mutation";
};

const READ_METHODS = new Set(["GET", "HEAD"]);

function normalizePath(pathOrUrl: string): string {
  const path = pathOrUrl.split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function readRoute(path: string): PublicBearerRoute | null {
  if (/^\/api\/sign(?:\/[^/]+)?$/.test(path)) {
    return { family: "job_signature", requestClass: "read" };
  }
  if (/^\/api\/ppe\/sign(?:\/[^/]+)?$/.test(path)) {
    return { family: "ppe_signature", requestClass: "read" };
  }
  if (path === "/api/ppe/confirm") {
    return { family: "ppe_confirmation", requestClass: "read" };
  }
  if (/^\/api\/quotes\/public(?:\/[^/]+)?$/.test(path)) {
    return { family: "quote", requestClass: "read" };
  }
  if (
    /^\/api\/q\/board(?:\/[^/]+)?$/.test(path) ||
    /^\/api\/q\/board\/documents\/[^/]+$/.test(path) ||
    /^\/api\/q\/board\/[^/]+\/documents\/[^/]+$/.test(path)
  ) {
    return { family: "switchboard", requestClass: "read" };
  }
  return null;
}

function mutationRoute(path: string): PublicBearerRoute | null {
  if (/^\/api\/sign(?:\/[^/]+)?$/.test(path)) {
    return { family: "job_signature", requestClass: "mutation" };
  }
  if (/^\/api\/ppe\/sign(?:\/[^/]+)?$/.test(path)) {
    return { family: "ppe_signature", requestClass: "mutation" };
  }
  if (path === "/api/ppe/confirm") {
    return { family: "ppe_confirmation", requestClass: "mutation" };
  }
  if (
    /^\/api\/quotes\/public\/(?:accept|reject)$/.test(path) ||
    /^\/api\/quotes\/public\/[^/]+\/(?:accept|reject)$/.test(path)
  ) {
    return { family: "quote", requestClass: "mutation" };
  }
  return null;
}

export function classifyPublicBearerRoute(
  method: string,
  pathOrUrl: string,
): PublicBearerRoute | null {
  const normalizedMethod = method.toUpperCase();
  const path = normalizePath(pathOrUrl);
  if (READ_METHODS.has(normalizedMethod)) return readRoute(path);
  if (normalizedMethod === "POST") return mutationRoute(path);
  return null;
}
