import {
  publicGrantToken,
  type PublicGrantPurpose,
} from "./public-grant-bootstrap";
import { canonicalPublicGrantApiFamily } from "./public-api-policy";

export class MissingPublicGrantError extends Error {
  readonly name = "MissingPublicGrantError";

  constructor() {
    super("Veřejný odkaz není v tomto okně dostupný. Otevřete původní odkaz znovu.");
  }
}

export function publicGrantFetch(
  purpose: PublicGrantPurpose,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = publicGrantToken(purpose);
  if (!token) throw new MissingPublicGrantError();

  const requestInput =
    typeof Request !== "undefined" && input instanceof Request ? input : null;
  const method = (init.method ?? requestInput?.method ?? "GET").toUpperCase();
  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const inputUrl = new URL(
    requestInput?.url ?? (input instanceof URL ? input.href : String(input)),
    currentOrigin,
  );
  if (
    inputUrl.origin !== currentOrigin ||
    inputUrl.username ||
    inputUrl.password ||
    inputUrl.search ||
    inputUrl.hash ||
    canonicalPublicGrantApiFamily(method, inputUrl.pathname) !== purpose
  ) {
    throw new Error("Public grant request is outside its allowed API family.");
  }

  const headers = new Headers(
    requestInput?.headers,
  );
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  if (headers.has("Authorization")) {
    throw new Error("Public grant request already contains Authorization.");
  }
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "omit",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
}
