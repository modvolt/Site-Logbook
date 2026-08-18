const PUBLIC_BEARER_PATHS: readonly [RegExp, string][] = [
  [/^(\/api)?(\/sign\/)[^/]+/i, "$1$2:token"],
  [/^(\/api)?(\/ppe\/sign\/)[^/]+/i, "$1$2:token"],
  [/^(\/api)?(\/quotes\/public\/)[^/]+/i, "$1$2:token"],
  [/^(\/api)?(\/q\/board\/)[^/]+/i, "$1$2:token"],
  [/^(\/oopp\/sign\/)[^/]+/i, "$1:token"],
  [/^(\/quote-share\/)[^/]+/i, "$1:token"],
] as const;

/**
 * Keep request and audit logs useful without persisting replayable bearer
 * credentials. Query strings were already omitted from request logs; this also
 * replaces the token segment used by the public signing, quote, and QR routes.
 */
export function redactPublicBearerPath(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let path = url.split("?", 1)[0] ?? "";
  for (const [pattern, replacement] of PUBLIC_BEARER_PATHS) {
    path = path.replace(pattern, replacement);
  }
  return path;
}

type LoggedRequest = {
  id?: unknown;
  method?: string;
  url?: string;
};

export function serializeRequestForLog(req: LoggedRequest) {
  return {
    id: req.id,
    method: req.method,
    url: redactPublicBearerPath(req.url),
  };
}
