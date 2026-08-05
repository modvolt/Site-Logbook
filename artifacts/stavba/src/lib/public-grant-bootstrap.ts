export type PublicGrantPurpose =
  | "job_signature"
  | "ppe_signature"
  | "ppe_confirmation"
  | "quote"
  | "switchboard";

type ActivePublicGrant = {
  purpose: PublicGrantPurpose;
  token: string;
};

type PublicRoute = {
  purpose: PublicGrantPurpose;
  canonicalPath: string;
  legacyPath: RegExp;
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function normalizedBasePath(basePath: string): string {
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function appPath(pathname: string, basePath: string): string | null {
  const base = normalizedBasePath(basePath);
  if (base === "/") return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

function browserPath(pathname: string, basePath: string): string {
  const base = normalizedBasePath(basePath);
  return base === "/" ? pathname : `${base}${pathname}`;
}

const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { purpose: "job_signature", canonicalPath: "/sign", legacyPath: /^\/sign\/([^/]+)$/ },
  { purpose: "ppe_signature", canonicalPath: "/oopp/sign", legacyPath: /^\/oopp\/sign\/([^/]+)$/ },
  { purpose: "ppe_confirmation", canonicalPath: "/oopp/potvrdit", legacyPath: /$a/ },
  { purpose: "quote", canonicalPath: "/quote-share", legacyPath: /^\/quote-share\/([^/]+)$/ },
  { purpose: "switchboard", canonicalPath: "/q/board", legacyPath: /^\/q\/board\/([^/]+)$/ },
];

let activeGrant: ActivePublicGrant | null = null;

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function fragmentToken(hash: string): string | null | undefined {
  if (!hash) return undefined;
  const raw = hash.slice(1);
  if (!raw) return null;
  if (raw.startsWith("token=")) return decoded(raw.slice("token=".length));
  return decoded(raw);
}

function routeForPath(pathname: string): {
  route: PublicRoute;
  legacyToken?: string | null;
} | null {
  for (const route of PUBLIC_ROUTES) {
    if (pathname === route.canonicalPath) return { route };
    const match = route.legacyPath.exec(pathname);
    if (match) return { route, legacyToken: decoded(match[1] ?? "") };
  }
  return null;
}

export function capturePublicGrantLocation(
  location: Pick<Location, "pathname" | "search" | "hash">,
  replace: (path: string) => void,
  basePath = import.meta.env.BASE_URL,
): { publicRoute: boolean; captured: boolean; canonicalPath?: string } {
  const pathname = appPath(location.pathname, basePath);
  const match = pathname == null ? null : routeForPath(pathname);
  if (!match) {
    activeGrant = null;
    return { publicRoute: false, captured: false };
  }

  const candidates: Array<string | null> = [];
  if (match.legacyToken !== undefined) candidates.push(match.legacyToken);
  const hashToken = fragmentToken(location.hash);
  if (hashToken !== undefined) candidates.push(hashToken);
  if (match.route.purpose === "ppe_confirmation") {
    const query = new URLSearchParams(location.search);
    if (query.has("token")) {
      const values = query.getAll("token");
      candidates.push(values.length === 1 ? values[0] : null);
    }
  }

  if (
    candidates.length > 0 ||
    pathname !== match.route.canonicalPath ||
    location.search ||
    location.hash
  ) {
    replace(browserPath(match.route.canonicalPath, basePath));
  }

  activeGrant = null;
  if (
    candidates.length === 1 &&
    typeof candidates[0] === "string" &&
    TOKEN_PATTERN.test(candidates[0])
  ) {
    activeGrant = { purpose: match.route.purpose, token: candidates[0] };
  }

  return {
    publicRoute: true,
    captured: activeGrant !== null,
    canonicalPath: match.route.canonicalPath,
  };
}

export function bootstrapPublicGrantLocation(): void {
  if (typeof window === "undefined") return;
  capturePublicGrantLocation(window.location, (path) => {
    window.history.replaceState(null, "", path);
  });
}

export function requiresPublicGrantReload(
  location: Pick<Location, "pathname" | "hash">,
  basePath = import.meta.env.BASE_URL,
): boolean {
  const pathname = appPath(location.pathname, basePath);
  if (pathname == null || !routeForPath(pathname) || !location.hash) return false;
  const token = fragmentToken(location.hash);
  return location.hash.startsWith("#token=") ||
    (typeof token === "string" && TOKEN_PATTERN.test(token));
}

/**
 * A second same-purpose link differs only by its fragment, so the browser may
 * keep the old React tree alive. Reload before scrubbing to atomically bind the
 * new grant to freshly loaded public data and mutation handlers.
 */
export function installPublicGrantNavigationGuard(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("hashchange", () => {
    if (requiresPublicGrantReload(window.location)) window.location.reload();
  });
}

export function publicGrantToken(purpose: PublicGrantPurpose): string | null {
  return activeGrant?.purpose === purpose ? activeGrant.token : null;
}

export function clearPublicGrant(purpose?: PublicGrantPurpose): void {
  if (!purpose || activeGrant?.purpose === purpose) activeGrant = null;
}

/** Bind the in-memory credential to exactly one currently rendered route. */
export function retainPublicGrantForRoutePath(pathname: string): void {
  const route = PUBLIC_ROUTES.find((candidate) => candidate.canonicalPath === pathname);
  if (!route || activeGrant?.purpose !== route.purpose) activeGrant = null;
}

export function isPublicGrantRoutePath(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => route.canonicalPath === pathname);
}
