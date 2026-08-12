import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { assertSingleEd25519TrustRootBinding } from "../../artifacts/api-server/src/lib/production-pinned-key-contract.mjs";

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
