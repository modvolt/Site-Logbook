import { describe, expect, it } from "vitest";
import {
  compareSnapshotRecords,
  findRegistryNameCollision,
  normalizeRegistryAliases,
  redactSwitchboardAuditPayload,
  snapshotValuesEqual,
  type RegistryNameEntry,
} from "../src/lib/switchboard-admin";

const registry: RegistryNameEntry[] = [
  { id: 1, fieldKey: "serialNumber", canonicalNameCs: "Výrobní číslo", aliases: ["Výr. číslo"], isActive: true },
  { id: 2, fieldKey: "ratedCurrent", canonicalNameCs: "Jmenovitý proud", aliases: ["InA"], isActive: true },
  { id: 3, fieldKey: "legacy", canonicalNameCs: "Staré pole", aliases: ["Nepoužívaný alias"], isActive: false },
];

describe("switchboard parser registry administration", () => {
  it("trims aliases and deduplicates equivalent names", () => {
    expect(normalizeRegistryAliases(["  Výrobní   č. ", "Vyrobni c.", "InA", "ina", ""])).toEqual(["Výrobní č.", "InA"]);
  });

  it("rejects a normalized alias occupied by another active field", () => {
    expect(findRegistryNameCollision(registry, 1, { aliases: ["  INA: "] })).toMatchObject({ conflictingFieldKey: "ratedCurrent", submittedName: "INA:" });
  });

  it("allows names from an inactive field but validates them when activated", () => {
    expect(findRegistryNameCollision(registry, 1, { aliases: ["Nepouzivany alias"] })).toBeNull();
    const conflicting = registry.map((entry) => entry.id === 1 ? { ...entry, aliases: ["Staré pole"] } : entry);
    expect(findRegistryNameCollision(conflicting, 3, { isActive: true })).toMatchObject({ conflictingFieldKey: "serialNumber" });
  });
});

describe("switchboard version comparison", () => {
  it("reports only changed, added and removed snapshot fields", () => {
    expect(compareSnapshotRecords(
      { ratedCurrent: "25 A", standards: ["ČSN EN 61439-1"], removed: "old" },
      { ratedCurrent: "32 A", standards: ["ČSN EN 61439-1"], added: "new" },
    )).toEqual([
      { fieldKey: "added", before: null, after: "new" },
      { fieldKey: "ratedCurrent", before: "25 A", after: "32 A" },
      { fieldKey: "removed", before: "old", after: null },
    ]);
  });

  it("treats objects with different key order as equal", () => {
    expect(compareSnapshotRecords({ config: { a: 1, b: 2 } }, { config: { b: 2, a: 1 } })).toEqual([]);
    expect(snapshotValuesEqual(
      { outer: { second: 2, first: { b: true, a: false } } },
      { outer: { first: { a: false, b: true }, second: 2 } },
    )).toBe(true);
  });
});

describe("switchboard audit payload protection", () => {
  it("recursively removes tokens and storage paths while preserving useful prefixes", () => {
    expect(redactSwitchboardAuditPayload({
      before: { qrTokenHash: "hash", qrTokenCiphertext: "cipher", qrTokenPrefix: "abc123", apiKey: "key", nested: [{ storagePath: "/private/file", authorization: "Bearer secret", status: "done" }] },
      pdfStoragePath: "/private/protocol.pdf",
      protocolNumber: "RZ-1",
    })).toEqual({ before: { qrTokenPrefix: "abc123", nested: [{ status: "done" }] }, protocolNumber: "RZ-1" });
  });
});
