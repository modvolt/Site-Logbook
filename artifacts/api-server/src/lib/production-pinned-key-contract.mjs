import { createHash, createPublicKey } from "node:crypto";

const KEY_ID = /^ed25519:[a-z0-9][a-z0-9._-]{2,63}$/;
const PIN = /^sha256:[0-9a-f]{64}$/;

export function assertSingleEd25519TrustRootBinding(keys, pin, label) {
  const entries = Object.entries(keys);
  if (entries.length === 0 && pin === null) return false;
  if (
    entries.length !== 1 ||
    !KEY_ID.test(entries[0][0]) ||
    !PIN.test(pin ?? "") ||
    /PRIVATE KEY/.test(entries[0][1])
  ) {
    throw new Error(`${label} trust root binding is invalid.`);
  }
  const publicKey = createPublicKey(entries[0][1]);
  const canonicalPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const actual = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    canonicalPem !== entries[0][1] ||
    actual !== pin
  ) {
    throw new Error(`${label} SPKI does not match its pin.`);
  }
  return true;
}
