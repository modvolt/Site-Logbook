/**
 * Reference extractor — pulls structured reference numbers (delivery notes,
 * orders, jobs, invoices, …) out of the free text of a Czech supplier document.
 *
 * This is a pure, deterministic, AI-free module: it only returns reference
 * numbers that explicitly appear next to a recognized Czech label. Nothing is
 * guessed. It is the text-side counterpart to the structured references that the
 * ISDOC parser reads from XML — both feed the same `billing_document_references`
 * table so that delivery notes ↔ invoices ↔ jobs can be matched later.
 */

export type ReferenceType =
  | "delivery_note"
  | "order"
  | "supplier_order"
  | "job"
  | "invoice"
  | "contract"
  | "other";

export interface ExtractedReference {
  referenceType: ReferenceType;
  referenceNumber: string;
  /** 0..1 — how confident we are that this is a real reference of this type. */
  confidence: number;
  source: "text";
}

/**
 * The value that follows a label. Czech supplier reference numbers are
 * alphanumeric and may contain `-`, `/`, `_` and `.` (e.g. `OBJ-2024/001`,
 * `4500012345`, `DL.123`). We require at least 3 chars and at least one digit so
 * that stray words ("ze dne", "číslo") are never captured as a reference.
 */
const VALUE = String.raw`([A-Za-z0-9][A-Za-z0-9/_.\-]{2,31})`;

/**
 * The optional connective between a label and its value:
 * `č.`, `číslo`, `c.`, `no.`, `num.` plus optional `:` / `#` / dash.
 */
const SEP = String.raw`(?:\s*(?:č(?:íslo)?|c(?:islo)?|no|num)\.?)?\s*[:#.\-–]?\s*`;

interface LabelRule {
  type: ReferenceType;
  /** Alternation body (no anchors); matched case-insensitively. */
  label: string;
  confidence: number;
}

/**
 * Ordered most-specific-first. "Vaše objednávka" (our order placed with the
 * supplier) is an `order`; "Naše objednávka" (the supplier's own order number)
 * is a `supplier_order`. A bare "objednávka" defaults to `order`.
 */
const LABEL_RULES: LabelRule[] = [
  {
    type: "delivery_note",
    label: String.raw`dodac[íi]\s*list|dod\.\s*list|\bDL\b`,
    confidence: 0.9,
  },
  {
    type: "supplier_order",
    label: String.raw`naš[ei]\s*(?:č[íi]slo\s*)?objedn[áa]vk[ayi]|naš[ei]\s*obj\.?`,
    confidence: 0.85,
  },
  {
    type: "order",
    label: String.raw`vaš[ei]\s*(?:č[íi]slo\s*)?objedn[áa]vk[ayi]|vaš[ei]\s*obj\.?|objedn[áa]vk[ayi]|objedn[áa]vka|\bobj\.`,
    confidence: 0.8,
  },
  {
    type: "job",
    label: String.raw`zak[áa]zk[ayi]|zak[áa]zka|číslo\s*zak[áa]zky`,
    confidence: 0.8,
  },
  {
    type: "invoice",
    label: String.raw`faktur[ay]|da[ňn]ov[ýy]\s*doklad|variabiln[íi]\s*symbol|\bVS\b`,
    confidence: 0.6,
  },
  {
    type: "contract",
    label: String.raw`smlouv[ay]|č[íi]slo\s*smlouvy`,
    confidence: 0.7,
  },
];

function dedupeKey(r: ExtractedReference): string {
  return `${r.referenceType}::${normalizeReferenceNumber(r.referenceNumber)}`;
}

/** Canonical form for comparing two reference numbers (case/punctuation-free). */
export function normalizeReferenceNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Extract all recognizable references from a block of document text.
 * Returns at most one reference per (type, normalized-number) pair, keeping the
 * highest confidence. Order of first appearance is preserved.
 */
export function extractReferences(text: string): ExtractedReference[] {
  if (!text || typeof text !== "string") return [];
  const found = new Map<string, ExtractedReference>();
  for (const rule of LABEL_RULES) {
    const re = new RegExp(`(?:${rule.label})${SEP}${VALUE}`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1]?.trim();
      if (!raw || !/[0-9]/.test(raw)) continue;
      // Strip a trailing separator that the value pattern may have swallowed.
      const cleaned = raw.replace(/[.\-/_]+$/, "");
      if (cleaned.length < 3) continue;
      const ref: ExtractedReference = {
        referenceType: rule.type,
        referenceNumber: cleaned,
        confidence: rule.confidence,
        source: "text",
      };
      const key = dedupeKey(ref);
      const existing = found.get(key);
      if (!existing || existing.confidence < ref.confidence) {
        found.set(key, ref);
      }
    }
  }
  return [...found.values()];
}
