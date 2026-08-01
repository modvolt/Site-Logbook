const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

export class PublicOriginConfigError extends Error {
  readonly code = "public_origin_invalid";

  constructor(message = "PUBLIC_APP_URL is not configured correctly.") {
    super(message);
    this.name = "PublicOriginConfigError";
  }
}

/**
 * Return the single externally trusted application origin.
 *
 * Request Host / X-Forwarded-Host values are deliberately not accepted here:
 * links carrying bearer credentials must never be derived from request input.
 */
export function publicAppOrigin(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (!raw) throw new PublicOriginConfigError("PUBLIC_APP_URL is required.");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PublicOriginConfigError();
  }

  if (
    !SUPPORTED_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PublicOriginConfigError();
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new PublicOriginConfigError("PUBLIC_APP_URL must use HTTPS in production.");
  }

  return parsed.origin;
}

export function publicAppUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new PublicOriginConfigError("Public application path is invalid.");
  }
  const origin = publicAppOrigin();
  const result = new URL(path, `${origin}/`);
  if (result.origin !== origin) {
    throw new PublicOriginConfigError("Public application path is invalid.");
  }
  return result.toString();
}
