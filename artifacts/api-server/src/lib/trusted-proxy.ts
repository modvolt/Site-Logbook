import { isIP } from "node:net";

export class TrustedProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedProxyConfigError";
  }
}

function isExplicitIpOrCidr(value: string): boolean {
  if (isIP(value)) return true;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const family = isIP(parts[0]);
  const prefix = Number(parts[1]);
  const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
  return Number.isInteger(prefix) && prefix > 0 && prefix <= maximum;
}

/**
 * Resolve only operator-declared proxy addresses. Production deliberately has
 * no broad private-range or hop-count fallback: the exact nginx/edge networks
 * must be recorded from the deployment topology before a release can start.
 */
export function trustedProxyRanges(
  nodeEnv = process.env.NODE_ENV,
  raw = process.env.API_TRUSTED_PROXY_CIDRS,
): string[] {
  const configured = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    if (nodeEnv === "production") {
      throw new TrustedProxyConfigError(
        "API_TRUSTED_PROXY_CIDRS is required in production.",
      );
    }
    return ["loopback"];
  }

  if (!configured.every(isExplicitIpOrCidr)) {
    throw new TrustedProxyConfigError(
      "API_TRUSTED_PROXY_CIDRS must contain only explicit IP addresses or non-zero CIDRs.",
    );
  }
  return configured;
}
