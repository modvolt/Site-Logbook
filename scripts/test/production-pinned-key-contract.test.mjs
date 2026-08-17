import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PINNED_PRODUCTION_HOST_EVIDENCE_KEYS,
  PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
  assertProductionHostEvidenceTrustRootBinding,
} from "../../artifacts/api-server/src/lib/production-host-evidence-pinned-keys.mjs";
import { assertSingleEd25519TrustRootBinding } from "../../artifacts/api-server/src/lib/production-pinned-key-contract.mjs";
import {
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
  assertProductionPublisherProvenanceTrustRootBinding,
} from "../../artifacts/api-server/src/lib/production-publisher-provenance-pinned-keys.mjs";

const PUBLISHER_KEY_ID = "ed25519:production-publisher-2026-08";
const PUBLISHER_PIN =
  "sha256:5ad804df40f489ed1273796c393b51bf63b5497d06929f7e6726be9dbd54f4a6";
const HOST_KEY_ID = "ed25519:production-host-evidence-2026-08";
const HOST_PIN =
  "sha256:caba1ae8a341ed7703769c06cde1e48a632d4d59f12b957fa2983a3319388af0";
const RECEIPT_URL = new URL(
  "../../docs/audit/evidence/21-production-signing-custody-ceremony-receipt.json",
  import.meta.url,
);

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

test("binds the attended production public trust roots exactly", () => {
  assert.deepEqual(Object.keys(PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS), [
    PUBLISHER_KEY_ID,
  ]);
  assert.equal(
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
    PUBLISHER_PIN,
  );
  assert.deepEqual(Object.keys(PINNED_PRODUCTION_HOST_EVIDENCE_KEYS), [
    HOST_KEY_ID,
  ]);
  assert.equal(PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256, HOST_PIN);
  assert.equal(assertProductionPublisherProvenanceTrustRootBinding(), true);
  assert.equal(assertProductionHostEvidenceTrustRootBinding(), true);
  assert.notEqual(
    PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS[PUBLISHER_KEY_ID],
    PINNED_PRODUCTION_HOST_EVIDENCE_KEYS[HOST_KEY_ID],
  );
});

test("keeps the attended ceremony receipt canonical, public-only and exact", () => {
  const receiptBytes = readFileSync(RECEIPT_URL, "utf8");
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receiptBytes, `${canonicalJson(receipt)}\n`);
  assert.equal(
    receipt.publicManifest.sha256,
    "sha256:407ebba2d8661fe9fd7aa660056827608bd1199a12b214de3757419ed711abc7",
  );
  assert.equal(receipt.ceremony.operatorConfirmedAllRoles, true);
  assert.equal(receipt.ceremony.storageSeparationConfirmed, true);
  assert.equal(receipt.ceremony.storageLocationLabelsProvided, false);
  assert.deepEqual(receipt.ceremony.storageLocationLabels, []);
  assert.deepEqual(
    receipt.roles.map(({ role, verified }) => ({ role, verified })),
    [
      { role: "publisher-provenance", verified: true },
      { role: "host-evidence", verified: true },
      { role: "secret-envelope", verified: true },
      { role: "backup-encryption", verified: true },
    ],
  );
  assert.doesNotMatch(
    receiptBytes,
    /BEGIN (?:RSA |EC )?PRIVATE KEY|\"(?:mnemonic|passphrase|derivedKey|keyMaterial)\"/i,
  );
});

test("accepts only one exact Ed25519 SPKI bound to its SHA-256 pin", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const pin = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const keys = { "ed25519:production-test": pem };
  assert.equal(assertSingleEd25519TrustRootBinding(keys, pin, "Test"), true);
  assert.throws(
    () =>
      assertSingleEd25519TrustRootBinding(
        keys,
        `sha256:${"0".repeat(64)}`,
        "Test",
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      assertSingleEd25519TrustRootBinding(
        { ...keys, "ed25519:production-other": pem },
        pin,
        "Test",
      ),
    /binding is invalid/,
  );
});

test("keeps an empty map default-dark only when its pin is also absent", () => {
  assert.equal(assertSingleEd25519TrustRootBinding({}, null, "Test"), false);
  assert.throws(
    () =>
      assertSingleEd25519TrustRootBinding(
        {},
        `sha256:${"1".repeat(64)}`,
        "Test",
      ),
    /binding is invalid/,
  );
});
