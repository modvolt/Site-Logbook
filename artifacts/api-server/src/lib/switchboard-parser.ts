export const SWITCHBOARD_PARSER_VERSION = "1.0.0";

export type TextElement = {
  text: string;
  page: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  blockId?: string;
  method?: "text_layer" | "ocr";
};

export type FieldDefinition = {
  fieldKey: string;
  canonicalNameCs: string;
  aliases: string[];
  dataType: string;
  required: boolean;
  minimumConfidence: number;
  allowedRelations: string[];
};

export type ExtractedField = {
  fieldKey: string;
  foundLabel: string;
  matchedAlias: string | null;
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number;
  pageNumber: number;
  blockId: string | null;
  extractionMethod: "text_layer" | "ocr";
  relativeRelation: string;
  validationStatus: "valid" | "invalid" | "missing";
  validationMessage: string | null;
  valueCandidates: Array<{
    raw: string;
    normalized: string | null;
    relation: string;
    score: number;
    valid: boolean;
    message: string | null;
  }>;
  parserVersion: string;
};

const technicalSubscripts: Record<string, string> = { "ₙ": "n", "ₐ": "a" };

export function normalizeFieldLabel(value: string): string {
  return value.normalize("NFKD")
    .replace(/[ₙₐ]/g, (char) => technicalSubscripts[char] ?? char)
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[=:]+\s*$/g, "")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("cs-CZ");
}

type Validation = { valid: boolean; normalized: string | null; message: string | null };
function numberUnit(value: string, unit: string): Validation {
  const match = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${unit}$`, "i").exec(value.trim());
  return match ? { valid: true, normalized: `${match[1].replace(",", ".")} ${unit}`, message: null }
    : { valid: false, normalized: null, message: `Očekávána číselná hodnota s jednotkou ${unit}.` };
}

export function validateSwitchboardValue(dataType: string, raw: string): Validation {
  const value = raw.trim();
  if (!value) return { valid: false, normalized: null, message: "Hodnota je prázdná." };
  if (dataType === "text") return value.length <= 200 ? { valid: true, normalized: value, message: null } : { valid: false, normalized: null, message: "Text je příliš dlouhý." };
  if (dataType === "voltage") return numberUnit(value, "V");
  if (dataType === "frequency") return numberUnit(value, "Hz");
  if (dataType === "current") return numberUnit(value, "A");
  if (dataType === "weight") return numberUnit(value, "kg");
  if (dataType === "ip_rating") return /^IP\s*\d{2,3}(?:\s*\/\s*IP\s*\d{2,3})?$/i.test(value) ? { valid: true, normalized: value.toUpperCase().replace(/\s+/g, ""), message: null } : { valid: false, normalized: null, message: "Neplatné označení IP." };
  if (dataType === "ik_rating") return /^IK\d{2}$/i.test(value) ? { valid: true, normalized: value.toUpperCase(), message: null } : { valid: false, normalized: null, message: "Neplatné označení IK." };
  if (dataType === "network_system") return /^(TN-C|TN-S|TN-C-S|TT|IT)$/i.test(value) ? { valid: true, normalized: value.toUpperCase(), message: null } : { valid: false, normalized: null, message: "Neplatná síťová soustava." };
  if (dataType === "dimensions") return /^\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m)$/i.test(value) ? { valid: true, normalized: value.replace(/x/gi, "×").replace(/\s+/g, " "), message: null } : { valid: false, normalized: null, message: "Neplatný formát rozměrů." };
  if (dataType === "date") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const cs = /^(\d{1,2})[.\/]\s*(\d{1,2})[.\/]\s*(\d{4})$/.exec(value);
    const normalized = iso ? value : cs ? `${cs[3]}-${cs[2].padStart(2, "0")}-${cs[1].padStart(2, "0")}` : null;
    const parts = normalized?.split("-").map(Number) ?? [];
    const parsed = parts.length === 3 ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])) : null;
    const valid = parsed != null
      && parsed.getUTCFullYear() === parts[0]
      && parsed.getUTCMonth() === parts[1] - 1
      && parsed.getUTCDate() === parts[2];
    return valid ? { valid: true, normalized, message: null } : { valid: false, normalized: null, message: "Neplatné datum." };
  }
  if (dataType === "standards") return /\b(?:ČSN|CSN|EN|IEC)\b/i.test(value) ? { valid: true, normalized: value, message: null } : { valid: false, normalized: null, message: "Hodnota neobsahuje označení normy." };
  return { valid: true, normalized: value, message: null };
}

function labelMatch(element: TextElement, field: FieldDefinition) {
  const normalized = normalizeFieldLabel(element.text);
  const names = [field.canonicalNameCs, ...field.aliases];
  for (const name of names) {
    const target = normalizeFieldLabel(name);
    if (normalized === target) return { label: element.text, alias: name === field.canonicalNameCs ? null : name, inlineValue: null, fuzzy: false };
    if (normalized.startsWith(`${target} `)) return { label: element.text.slice(0, name.length), alias: name === field.canonicalNameCs ? null : name, inlineValue: element.text.slice(name.length).replace(/^\s*[=:]?\s*/, "") || null, fuzzy: false };
    if (target.length >= 6 && normalized.length >= 6 && levenshteinDistance(normalized, target) <= 1) return { label: element.text, alias: name === field.canonicalNameCs ? null : name, inlineValue: null, fuzzy: true };
  }
  return null;
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function relationAndScore(label: TextElement, candidate: TextElement): { relation: string; score: number } | null {
  if (candidate.page !== label.page || candidate.order === label.order) return null;
  const sameBlock = label.blockId && candidate.blockId === label.blockId ? 0.08 : 0;
  const verticalDelta = Math.abs(candidate.y - label.y);
  if (verticalDelta <= Math.max(label.height, candidate.height) * 0.75 && candidate.x >= label.x + label.width * 0.5) return { relation: "same_line", score: 0.92 + sameBlock };
  const horizontalOverlap = Math.min(label.x + label.width, candidate.x + candidate.width) - Math.max(label.x, candidate.x);
  if (candidate.y > label.y && candidate.y - label.y <= label.height * 3 && horizontalOverlap > 0) return { relation: "below", score: 0.82 + sameBlock };
  if (candidate.order > label.order && candidate.order - label.order <= 2) return { relation: "reading_order", score: 0.72 + sameBlock };
  return null;
}

export function parseSwitchboardLabel(elements: TextElement[], registry: FieldDefinition[]) {
  const activeMatches = elements.flatMap((element) => registry.flatMap((field) => {
    const match = labelMatch(element, field);
    return match ? [{ element, field, match }] : [];
  }));
  const pageScores = new Map<number, Set<string>>();
  for (const item of activeMatches) {
    const set = pageScores.get(item.element.page) ?? new Set<string>(); set.add(item.field.fieldKey); pageScores.set(item.element.page, set);
  }
  const ranked = [...pageScores.entries()].map(([page, keys]) => ({ page, score: keys.size })).sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < 3) return { status: "label_not_found" as const, candidatePages: ranked, fields: [] as ExtractedField[] };
  const tied = ranked.filter((item) => item.score === ranked[0].score);
  const selectedPage = tied[0].page;
  const knownLabelOrders = new Set(activeMatches.filter((item) => item.element.page === selectedPage).map((item) => item.element.order));
  const fields: ExtractedField[] = [];
  for (const { element: label, field, match } of activeMatches.filter((item) => item.element.page === selectedPage)) {
    const inlineCandidate = match.inlineValue ? { raw: match.inlineValue, relation: "same_line", score: 0.98 } : null;
    const relationCandidates = elements.filter((candidate) => !knownLabelOrders.has(candidate.order)).flatMap((candidate) => {
      const scored = relationAndScore(label, candidate); return scored ? [{ raw: candidate.text, ...scored }] : [];
    }).filter((candidate) => field.allowedRelations.includes(candidate.relation));
    if (field.allowedRelations.includes("until_next_label")) {
      const nextLabelOrder = [...knownLabelOrders].filter((order) => order > label.order).sort((a, b) => a - b)[0] ?? label.order + 7;
      const between = elements.filter((candidate) => candidate.page === label.page && candidate.order > label.order && candidate.order < nextLabelOrder && !knownLabelOrders.has(candidate.order)).sort((a, b) => a.order - b.order);
      if (between.length) relationCandidates.push({ raw: between.map((candidate) => candidate.text).join(", "), relation: "until_next_label", score: 1.05 });
    }
    const candidates = relationCandidates.map((candidate) => ({ ...candidate, validation: validateSwitchboardValue(field.dataType, candidate.raw) }))
      .sort((a, b) => (Number(b.validation.valid) - Number(a.validation.valid)) || b.score - a.score);
    const best = inlineCandidate ? { ...inlineCandidate, validation: validateSwitchboardValue(field.dataType, inlineCandidate.raw) } : candidates[0];
    const ambiguous = !inlineCandidate && !!best && !!candidates[1]
      && best.validation.valid && candidates[1].validation.valid
      && Math.abs(best.score - candidates[1].score) <= 0.03
      && best.validation.normalized !== candidates[1].validation.normalized;
    const valueCandidates = (inlineCandidate ? [{ ...inlineCandidate, validation: validateSwitchboardValue(field.dataType, inlineCandidate.raw) }] : candidates)
      .slice(0, 10)
      .map((candidate) => ({ raw: candidate.raw, normalized: candidate.validation.normalized, relation: candidate.relation, score: candidate.score, valid: candidate.validation.valid, message: candidate.validation.message }));
    fields.push({
      fieldKey: field.fieldKey, foundLabel: match.label, matchedAlias: match.alias,
      rawValue: best?.raw ?? null, normalizedValue: best?.validation.normalized ?? null,
      confidence: best ? Math.min(1, best.score * (best.validation.valid ? 1 : 0.65) * (label.method === "ocr" ? 0.9 : 1) * (match.fuzzy ? 0.88 : 1) * (ambiguous ? 0.5 : 1)) : 0,
      pageNumber: selectedPage, blockId: label.blockId ?? null,
      extractionMethod: label.method ?? "text_layer", relativeRelation: best?.relation ?? "none",
      validationStatus: !best ? "missing" : ambiguous ? "invalid" : best.validation.valid ? "valid" : "invalid",
      validationMessage: ambiguous ? "Bylo nalezeno více rovnocenných hodnot. Vyberte a potvrďte správnou hodnotu." : best?.validation.message ?? "Název pole byl nalezen, ale hodnota chybí.",
      valueCandidates,
      parserVersion: SWITCHBOARD_PARSER_VERSION,
    });
  }
  const uniqueFields: ExtractedField[] = [];
  for (const field of fields) {
    const existing = uniqueFields.find((item) => item.fieldKey === field.fieldKey);
    if (!existing) { uniqueFields.push(field); continue; }
    const candidates = [...existing.valueCandidates, ...field.valueCandidates].filter((candidate, index, all) => all.findIndex((item) => item.raw === candidate.raw && item.relation === candidate.relation) === index);
    if (existing.normalizedValue && field.normalizedValue && existing.normalizedValue !== field.normalizedValue) {
      existing.validationStatus = "invalid";
      existing.validationMessage = "Bylo nalezeno více rovnocenných hodnot. Vyberte a potvrďte správnou hodnotu.";
      existing.confidence = Math.min(existing.confidence, field.confidence, 0.5);
      existing.valueCandidates = candidates;
    } else if (field.confidence > existing.confidence) {
      Object.assign(existing, field, { valueCandidates: candidates });
    } else {
      existing.valueCandidates = candidates;
    }
  }
  const ambiguousFields = uniqueFields.filter((field) => field.validationMessage?.startsWith("Bylo nalezeno více rovnocenných hodnot")).map((field) => field.fieldKey);
  const missingRequired = registry.filter((field) => field.required && !uniqueFields.some((item) => item.fieldKey === field.fieldKey && item.validationStatus === "valid" && item.confidence >= field.minimumConfidence));
  return { status: tied.length > 1 || missingRequired.length || ambiguousFields.length ? "needs_review" as const : "complete" as const, candidatePages: ranked, selectedPage, ambiguousPages: tied.length > 1 ? tied.map((item) => item.page) : [], ambiguousFields, fields: uniqueFields, missingRequired: missingRequired.map((field) => field.fieldKey) };
}
