// Single source of truth for the offline production host/evidence signer.
// Deliberately empty until the separately reviewed custody ceremony commits one
// public Ed25519 SPKI PEM and its matching SHA-256 pin. Never put private keys
// in this source, an image, environment variable, or evidence artifact.
export const PINNED_PRODUCTION_HOST_EVIDENCE_KEYS = Object.freeze({});
export const PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256 = null;
