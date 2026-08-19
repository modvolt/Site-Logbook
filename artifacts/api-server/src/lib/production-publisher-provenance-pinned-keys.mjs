import { assertSingleEd25519TrustRootBinding } from "./production-pinned-key-contract.mjs";

// Single source of truth for the production image-provenance publisher. These
// are public-only values bound by the attended 2026-08-17 custody ceremony. The
// corresponding private key remains outside the repository, image and env.
export const PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS = Object.freeze({
  "ed25519:production-publisher-2026-08":
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqufTxF0U4g4QIEGx9WWDWMQeYphrQoCJ5iiLXw9EIlI=\n-----END PUBLIC KEY-----\n",
});
export const PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256 =
  "sha256:5ad804df40f489ed1273796c393b51bf63b5497d06929f7e6726be9dbd54f4a6";

export function assertProductionPublisherProvenanceTrustRootBinding() {
  return assertSingleEd25519TrustRootBinding(
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
    "Production publisher provenance",
  );
}

assertProductionPublisherProvenanceTrustRootBinding();
