import { publicAppOrigin } from "./public-origin";

type WebauthnRequestOrigin = {
  protocol: string;
  hostname: string;
  get(header: string): string | undefined;
};

export type WebauthnRelyingParty = {
  rpId: string;
  origin: string;
};

function normalizedRpId(hostname: string): string {
  return hostname === "localhost" || hostname === "127.0.0.1"
    ? "localhost"
    : hostname;
}

export function webauthnRelyingParty(
  req: WebauthnRequestOrigin,
  nodeEnv = process.env.NODE_ENV,
): WebauthnRelyingParty {
  if (nodeEnv === "production") {
    const origin = new URL(publicAppOrigin(nodeEnv));
    return { rpId: normalizedRpId(origin.hostname), origin: origin.origin };
  }

  const protocol = req.protocol === "https" ? "https" : "http";
  const requestOrigin = new URL(`${protocol}://${req.get("host") ?? req.hostname}`);
  return {
    rpId: normalizedRpId(requestOrigin.hostname),
    origin: requestOrigin.origin,
  };
}
