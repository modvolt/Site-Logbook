import {
  PINNED_PRODUCTION_HOST_EVIDENCE_KEYS,
  PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
} from "../../artifacts/api-server/src/lib/production-host-evidence-pinned-keys.mjs";

// The migration backup authority cannot introduce a third trust root: these
// are aliases of the exact same source-pinned host/evidence values.
export const PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS =
  PINNED_PRODUCTION_HOST_EVIDENCE_KEYS;
export const PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256 =
  PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256;
