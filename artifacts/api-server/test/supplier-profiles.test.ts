import { describe, it, expect } from "vitest";
import {
  recognizeSupplier,
  genericProfile,
  SUPPLIER_PROFILE_SEEDS,
  type SupplierProfile,
} from "../src/lib/supplier-profiles";

/**
 * Tests for deterministic supplier recognition (DEK / Schrack / Varnet / K&V),
 * including IČO precedence and DB-profile override of the in-code seeds.
 */

describe("recognizeSupplier — known suppliers by name", () => {
  it("recognizes DEK", () => {
    expect(recognizeSupplier("DEK a.s.", null).parserType).toBe("dek");
    expect(recognizeSupplier("DEKTRADE", null).parserType).toBe("dek");
  });

  it("recognizes Schrack", () => {
    expect(recognizeSupplier("Schrack Technik s.r.o.", null).parserType).toBe(
      "schrack",
    );
  });

  it("recognizes Varnet", () => {
    expect(recognizeSupplier("VARNET s.r.o.", null).parserType).toBe("varnet");
  });

  it("recognizes K&V Elektro in several spellings", () => {
    expect(recognizeSupplier("K&V ELEKTRO a.s.", null).parserType).toBe(
      "kv_elektro",
    );
    expect(recognizeSupplier("K a V ELEKTRO", null).parserType).toBe(
      "kv_elektro",
    );
    expect(recognizeSupplier("KV ELEKTRO", null).parserType).toBe("kv_elektro");
  });
});

describe("recognizeSupplier — fallbacks and precedence", () => {
  it("falls back to the generic profile when nothing matches", () => {
    const p = recognizeSupplier("Někdo Jiný s.r.o.", null);
    expect(p.parserType).toBe("generic");
    expect(p).toEqual(genericProfile());
  });

  it("matches by IČO decisively even when the name does not match", () => {
    // DEK seed carries a known IČO.
    const p = recognizeSupplier("Úplně jiný název", "276 368 01");
    expect(p.parserType).toBe("dek");
  });

  it("lets an extra (DB) profile override the in-code seeds", () => {
    const custom: SupplierProfile = {
      supplierName: "DEK custom",
      supplierNamePattern: String.raw`\bDEK\b`,
      ico: null,
      parserType: "generic",
      rules: {
        preferIsdoc: true,
        defaultVatRate: 15,
        pricePerBaseQuantity: false,
        usesDeliveryNotes: false,
        feeKeywords: [],
      },
    };
    const p = recognizeSupplier("DEK a.s.", null, [custom]);
    expect(p.supplierName).toBe("DEK custom");
    expect(p.rules.defaultVatRate).toBe(15);
  });
});

describe("SUPPLIER_PROFILE_SEEDS", () => {
  it("covers all four real sample suppliers", () => {
    const types = SUPPLIER_PROFILE_SEEDS.map((p) => p.parserType);
    expect(types).toEqual(
      expect.arrayContaining(["dek", "schrack", "varnet", "kv_elektro"]),
    );
  });

  it("prefers ISDOC over PDF by default", () => {
    for (const seed of SUPPLIER_PROFILE_SEEDS) {
      expect(seed.rules.preferIsdoc).toBe(true);
    }
  });
});
