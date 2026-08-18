export type PublicGrantApiFamily =
  | "job_signature"
  | "ppe_signature"
  | "ppe_confirmation"
  | "quote"
  | "switchboard";

const READ_METHODS = new Set(["GET", "HEAD"]);

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function canonicalPublicGrantApiFamily(
  method: string,
  pathname: string,
): PublicGrantApiFamily | null {
  const path = normalizedPath(pathname);
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) {
    if (path === "/api/sign") return "job_signature";
    if (path === "/api/ppe/sign") return "ppe_signature";
    if (path === "/api/ppe/confirm") return "ppe_confirmation";
    if (path === "/api/quotes/public") return "quote";
    if (
      path === "/api/q/board" ||
      /^\/api\/q\/board\/documents\/[^/]+$/.test(path)
    ) return "switchboard";
  }
  if (verb === "POST") {
    if (path === "/api/sign") return "job_signature";
    if (path === "/api/ppe/sign") return "ppe_signature";
    if (path === "/api/ppe/confirm") return "ppe_confirmation";
    if (/^\/api\/quotes\/public\/(?:accept|reject)$/.test(path)) return "quote";
  }
  return null;
}

export function publicGrantApiFamily(
  method: string,
  pathname: string,
): PublicGrantApiFamily | null {
  const path = normalizedPath(pathname);
  const verb = method.toUpperCase();
  const canonical = canonicalPublicGrantApiFamily(verb, path);
  if (canonical) return canonical;
  if (READ_METHODS.has(verb)) {
    if (/^\/api\/sign(?:\/[^/]+)?$/.test(path)) return "job_signature";
    if (/^\/api\/ppe\/sign(?:\/[^/]+)?$/.test(path)) return "ppe_signature";
    if (path === "/api/ppe/confirm") return "ppe_confirmation";
    if (/^\/api\/quotes\/public(?:\/[^/]+)?$/.test(path)) return "quote";
    if (
      /^\/api\/q\/board(?:\/[^/]+)?$/.test(path) ||
      /^\/api\/q\/board\/documents\/[^/]+$/.test(path) ||
      /^\/api\/q\/board\/[^/]+\/documents\/[^/]+$/.test(path)
    ) return "switchboard";
  }
  if (verb === "POST") {
    if (/^\/api\/sign(?:\/[^/]+)?$/.test(path)) return "job_signature";
    if (/^\/api\/ppe\/sign(?:\/[^/]+)?$/.test(path)) return "ppe_signature";
    if (path === "/api/ppe/confirm") return "ppe_confirmation";
    if (
      /^\/api\/quotes\/public\/(?:accept|reject)$/.test(path) ||
      /^\/api\/quotes\/public\/[^/]+\/(?:accept|reject)$/.test(path)
    ) return "quote";
  }
  return null;
}

const OTHER_PUBLIC_API_ROUTES: ReadonlyArray<{
  methods: ReadonlySet<string>;
  path: RegExp;
}> = [
  { methods: READ_METHODS, path: /^\/api\/healthz$/ },
  { methods: READ_METHODS, path: /^\/api\/auth\/me$/ },
  { methods: new Set(["POST"]), path: /^\/api\/auth\/(?:login|logout|setup)$/ },
  { methods: new Set(["POST"]), path: /^\/api\/auth\/webauthn\/login\/(?:begin|complete)$/ },
  { methods: READ_METHODS, path: /^\/api\/storage\/public-objects\/.+$/ },
  { methods: new Set(["POST"]), path: /^\/api\/internal\/backup-trigger$/ },
];

export function isPublicApiRequest(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  const path = normalizedPath(pathname);
  if (publicGrantApiFamily(verb, path)) return true;
  return OTHER_PUBLIC_API_ROUTES.some(
    (route) => route.methods.has(verb) && route.path.test(path),
  );
}
