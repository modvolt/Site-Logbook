export const EXTERNAL_ACCOUNT_IDEMPOTENCY_SCOPE =
  "online:external-accounts:v1" as const;

type OnlineIdempotencyPolicy = {
  scope: typeof EXTERNAL_ACCOUNT_IDEMPOTENCY_SCOPE;
  routeTemplate: string;
  encryptedAtRest: true;
};

const EXTERNAL_ACCOUNT_MUTATIONS = [
  {
    method: "POST",
    pattern: /^\/external-accounts$/,
    routeTemplate: "/external-accounts",
  },
  {
    method: "PUT",
    pattern: /^\/external-accounts\/[1-9][0-9]*\/scopes$/,
    routeTemplate: "/external-accounts/:id/scopes",
  },
  {
    method: "PATCH",
    pattern: /^\/external-accounts\/[1-9][0-9]*\/expiry$/,
    routeTemplate: "/external-accounts/:id/expiry",
  },
  {
    method: "POST",
    pattern: /^\/external-accounts\/[1-9][0-9]*\/activate$/,
    routeTemplate: "/external-accounts/:id/activate",
  },
  {
    method: "POST",
    pattern: /^\/external-accounts\/[1-9][0-9]*\/transfer$/,
    routeTemplate: "/external-accounts/:id/transfer",
  },
  {
    method: "POST",
    pattern: /^\/external-accounts\/[1-9][0-9]*\/revoke$/,
    routeTemplate: "/external-accounts/:id/revoke",
  },
] as const;

function apiRelativePath(req: { originalUrl: string }): string {
  const pathname = new URL(req.originalUrl, "http://api.local").pathname;
  return pathname === "/api" ? "/" : pathname.replace(/^\/api(?=\/)/, "");
}

export function onlineIdempotencyPolicyForRequest(req: {
  method: string;
  originalUrl: string;
}): OnlineIdempotencyPolicy | null {
  const method = req.method.toUpperCase();
  const path = apiRelativePath(req);
  const route = EXTERNAL_ACCOUNT_MUTATIONS.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  return route
    ? {
        scope: EXTERNAL_ACCOUNT_IDEMPOTENCY_SCOPE,
        routeTemplate: route.routeTemplate,
        encryptedAtRest: true,
      }
    : null;
}
