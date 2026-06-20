/**
 * Supplier parser profiles — recognize a Czech construction/electrical supplier
 * from a document's header (name and/or IČO) and return the parsing rules that
 * are specific to that supplier's document layout.
 *
 * This is the in-code seed/source-of-truth for the well-known suppliers in the
 * project's real sample set (DEK, Schrack, Varnet, K&V Elektro). Profiles can
 * also be persisted/edited in `supplier_parser_profiles`; the DB rows win over
 * these seeds when present (an admin can tune a supplier without a code change).
 *
 * Recognition is deterministic and AI-free: a name regex and/or an IČO match.
 */

export type ParserType = "dek" | "schrack" | "varnet" | "kv_elektro" | "generic";

export interface SupplierRules {
  /**
   * ISDOC is always preferred over a PDF for the same logical document; this is
   * the default source priority used when merging. Profiles may override it.
   */
  preferIsdoc: boolean;
  /** Default VAT rate (%) to assume when a line omits it. null = do not guess. */
  defaultVatRate: number | null;
  /**
   * true when this supplier commonly prices per a base quantity (e.g. cable by
   * "Kč/100 m"); tells the line normalizer to look for a price-per multiplier.
   */
  pricePerBaseQuantity: boolean;
  /** true when this supplier issues separate delivery notes that summary-invoice. */
  usesDeliveryNotes: boolean;
  /** Extra fee keywords specific to this supplier (merged with global ones). */
  feeKeywords: string[];
}

export interface SupplierProfile {
  supplierName: string;
  /** Case-insensitive regex source matched against the document supplier name. */
  supplierNamePattern: string;
  /** Known IČO (8 digits) when stable; null when it should not be relied upon. */
  ico: string | null;
  parserType: ParserType;
  rules: SupplierRules;
}

const DEFAULT_RULES: SupplierRules = {
  preferIsdoc: true,
  defaultVatRate: null,
  pricePerBaseQuantity: false,
  usesDeliveryNotes: true,
  feeKeywords: [],
};

/**
 * Seed profiles for the known suppliers. IČO is left null where it should not be
 * relied on for matching; the name pattern is the primary recognition signal and
 * an admin can fill the IČO in the DB profile later.
 */
export const SUPPLIER_PROFILE_SEEDS: SupplierProfile[] = [
  {
    supplierName: "DEK a.s.",
    supplierNamePattern: String.raw`\bDEK\b|DEKTRADE|DEK\s*a\.?s\.?`,
    ico: "27636801",
    parserType: "dek",
    rules: {
      ...DEFAULT_RULES,
      usesDeliveryNotes: true,
      pricePerBaseQuantity: false,
      feeKeywords: ["recyklační příspěvek", "PHE"],
    },
  },
  {
    supplierName: "Schrack Technik s.r.o.",
    supplierNamePattern: String.raw`\bSchrack\b`,
    ico: null,
    parserType: "schrack",
    rules: {
      ...DEFAULT_RULES,
      pricePerBaseQuantity: true,
      feeKeywords: ["recyklační poplatek", "PHE", "elektroodpad"],
    },
  },
  {
    supplierName: "VARNET s.r.o.",
    supplierNamePattern: String.raw`\bVarnet\b`,
    ico: null,
    parserType: "varnet",
    rules: {
      ...DEFAULT_RULES,
      pricePerBaseQuantity: false,
    },
  },
  {
    supplierName: "K&V ELEKTRO a.s.",
    supplierNamePattern: String.raw`K\s*&\s*V\s*ELEKTRO|K\s*a\s*V\s*ELEKTRO|\bKV\s*ELEKTRO\b`,
    ico: null,
    parserType: "kv_elektro",
    rules: {
      ...DEFAULT_RULES,
      pricePerBaseQuantity: true,
      feeKeywords: ["recyklační poplatek", "PHE"],
    },
  },
];

/** Normalize an IČO for comparison (digits only). */
function normalizeIco(ico: string | null | undefined): string | null {
  if (!ico) return null;
  const digits = ico.replace(/\D/g, "");
  return digits || null;
}

/**
 * Recognize a supplier from its name and/or IČO. An IČO match (when both sides
 * have one) is decisive; otherwise the name regex decides. Returns the generic
 * fallback profile when nothing matches.
 *
 * `extraProfiles` (e.g. rows from `supplier_parser_profiles`) take precedence
 * over the in-code seeds.
 */
export function recognizeSupplier(
  supplierName: string | null | undefined,
  ico: string | null | undefined,
  extraProfiles: SupplierProfile[] = [],
): SupplierProfile {
  const candidates = [...extraProfiles, ...SUPPLIER_PROFILE_SEEDS];
  const wantIco = normalizeIco(ico);

  if (wantIco) {
    const byIco = candidates.find((p) => normalizeIco(p.ico) === wantIco);
    if (byIco) return byIco;
  }

  if (supplierName) {
    const byName = candidates.find((p) => {
      try {
        return new RegExp(p.supplierNamePattern, "i").test(supplierName);
      } catch {
        return false;
      }
    });
    if (byName) return byName;
  }

  return genericProfile();
}

export function genericProfile(): SupplierProfile {
  return {
    supplierName: "Obecný dodavatel",
    supplierNamePattern: "",
    ico: null,
    parserType: "generic",
    rules: { ...DEFAULT_RULES },
  };
}
