import { assertSingleEd25519TrustRootBinding } from "./production-pinned-key-contract.mjs";

// Single source of truth for the production image-provenance publisher.
// Deliberately empty until the independently reviewed custody ceremony commits
// one public Ed25519 SPKI PEM and its matching SHA-256 pin. The corresponding
// private key must remain outside the repository, image and environment.
export const PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS = Object.freeze({});
export const PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256 = null;

export function assertProductionPublisherProvenanceTrustRootBinding() {
  return assertSingleEd25519TrustRootBinding(
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
    "Production publisher provenance",
  );
}

assertProductionPublisherProvenanceTrustRootBinding();
