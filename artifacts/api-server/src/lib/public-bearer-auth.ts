import type { Request, Response } from "express";
import { isPlausiblePublicAccessToken } from "./public-access-token-format";

export type PublicBearerCredentialErrorCode =
  | "missing"
  | "malformed"
  | "ambiguous";

export class PublicBearerCredentialError extends Error {
  constructor(readonly code: PublicBearerCredentialErrorCode) {
    super(`Public bearer credential is ${code}.`);
    this.name = "PublicBearerCredentialError";
  }
}

type HeaderRequest = Pick<Request, "headers" | "rawHeaders">;

function authorizationValues(req: HeaderRequest): string[] {
  const rawValues: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() !== "authorization") continue;
    rawValues.push(req.rawHeaders[index + 1] ?? "");
  }
  if (rawValues.length > 0) return rawValues;

  const normalized = req.headers.authorization;
  if (Array.isArray(normalized)) return normalized;
  return typeof normalized === "string" ? [normalized] : [];
}

export function hasAuthorizationCredential(req: HeaderRequest): boolean {
  return authorizationValues(req).length > 0;
}

export function readPublicBearerToken(req: HeaderRequest): string {
  const values = authorizationValues(req);
  if (values.length === 0) throw new PublicBearerCredentialError("missing");
  if (values.length !== 1) throw new PublicBearerCredentialError("ambiguous");

  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(values[0]!);
  if (!match || !isPlausiblePublicAccessToken(match[1]!)) {
    throw new PublicBearerCredentialError("malformed");
  }
  return match[1]!;
}

export function assertNoAuthorizationCredential(req: HeaderRequest): void {
  if (hasAuthorizationCredential(req)) {
    throw new PublicBearerCredentialError("ambiguous");
  }
}

export function readPublicBearerOrLegacyToken(
  req: HeaderRequest,
  legacyToken: unknown,
): string {
  const hasAuthorization = hasAuthorizationCredential(req);
  const hasLegacy = legacyToken !== undefined;
  if (hasAuthorization && hasLegacy) {
    throw new PublicBearerCredentialError("ambiguous");
  }
  if (hasAuthorization) return readPublicBearerToken(req);
  if (!hasLegacy) throw new PublicBearerCredentialError("missing");
  if (
    typeof legacyToken !== "string" ||
    !isPlausiblePublicAccessToken(legacyToken)
  ) {
    throw new PublicBearerCredentialError("malformed");
  }
  return legacyToken;
}

export function sendPublicBearerCredentialError(
  res: Response,
  error: unknown,
): boolean {
  if (!(error instanceof PublicBearerCredentialError)) return false;

  if (error.code === "ambiguous") {
    res.status(400).json({
      error: "Požadavek obsahuje více veřejných přístupových údajů.",
      code: "ambiguous_public_credential",
    });
    return true;
  }

  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({
    error: "Chybí nebo je neplatný veřejný přístupový údaj.",
    code: "public_bearer_required",
  });
  return true;
}
