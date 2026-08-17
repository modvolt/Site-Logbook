import { createHash } from "node:crypto";

import snapshot0096 from "../../../../lib/db/migrations/meta/0096_snapshot.json";

const EXPECTED_SNAPSHOT_ID = "1c804503-6c96-4453-8bae-5f20d854810c";
const EXPECTED_RELATION_NAMES_SHA256 =
  "sha256:e33cf78623be6c405f46eb0bf044d95e4519a98ed4cec8e46d252469c72bedf3";

const relationNames = Object.freeze(
  ["drizzle.__drizzle_migrations", ...Object.keys(snapshot0096.tables)].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  ),
);
const relationNamesSha256 = `sha256:${createHash("sha256")
  .update(JSON.stringify(relationNames))
  .digest("hex")}`;

if (
  snapshot0096.id !== EXPECTED_SNAPSHOT_ID ||
  relationNames.length !== 91 ||
  relationNamesSha256 !== EXPECTED_RELATION_NAMES_SHA256
) {
  throw new Error("PRODUCTION_BACKUP_RELATION_MANIFEST_BUILD_DRIFT");
}

/**
 * Runtime copy of the source-pinned exact-0096 relation manifest. It is built
 * from the same checked-in snapshot as the control-plane bundle and verifies
 * both its snapshot id and ordered relation-name digest before any DB access.
 */
export const PRODUCTION_EXACT_0096_RUNTIME_RELATION_MANIFEST = Object.freeze({
  schemaVersion: "site-logbook.production-exact-0096-relation-manifest/v1",
  source: "lib/db/migrations/meta/0096_snapshot.json#tables+drizzle-journal",
  sourceSnapshotId: EXPECTED_SNAPSHOT_ID,
  sourceFileLfSha256:
    "sha256:75ec78bc67dc60211d1c63560952347a2c11d3f92bb5f86f22d75e33fd94402e",
  contentDigestAlgorithm:
    "sha256-canonical-jsonl-column-order-pk-or-all-column-sort-v1",
  relationNames,
  relationNamesSha256,
});
