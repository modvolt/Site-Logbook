import { assertSingleEd25519TrustRootBinding } from "./production-pinned-key-contract.mjs";

// Single source of truth for the offline production host/evidence signer. These
// are public-only values bound by the attended 2026-08-17 custody ceremony.
// Never put private keys in source, an image, env or an evidence artifact.
export const PINNED_PRODUCTION_HOST_EVIDENCE_KEYS = Object.freeze({
  "ed25519:production-host-evidence-2026-08":
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEATXLmrd12p1sS+5aAxWcm4VXioMH3h4xFfEw8LDK0ruE=\n-----END PUBLIC KEY-----\n",
});
export const PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256 =
  "sha256:caba1ae8a341ed7703769c06cde1e48a632d4d59f12b957fa2983a3319388af0";

export function assertProductionHostEvidenceTrustRootBinding() {
  return assertSingleEd25519TrustRootBinding(
    PINNED_PRODUCTION_HOST_EVIDENCE_KEYS,
    PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
    "Production host/evidence",
  );
}

assertProductionHostEvidenceTrustRootBinding();
