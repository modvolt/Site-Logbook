/**
 * Document matching — pure scoring helpers that link the three sides of a Czech
 * supplier's paperwork: delivery notes (dodací listy) ↔ invoices (faktury) ↔
 * jobs (zakázky).
 *
 * Everything here is deterministic and side-effect free. The service layer feeds
 * in plain objects (documents, references, jobs) and gets back a numeric score +
 * a strength bucket + human-readable Czech reasons. Nothing is auto-confirmed:
 * the score only orders candidates for an admin to approve.
 */

import { round2 } from "./invoice-calc";
import { normalizeReferenceNumber } from "./reference-extractor";

export type MatchStrength = "strong" | "medium" | "weak" | "none";

export interface ScoredMatch {
  /** 0..1. */
  score: number;
  strength: MatchStrength;
  /** Czech, human-readable explanation of what contributed to the score. */
  reasons: string[];
}

export function strengthFromScore(score: number): MatchStrength {
  if (score >= 0.8) return "strong";
  if (score >= 0.5) return "medium";
  if (score > 0) return "weak";
  return "none";
}

interface MatchableReference {
  referenceType: string;
  referenceNumber: string;
}

export interface MatchableDocument {
  id?: number;
  supplierIc?: string | null;
  documentNumber?: string | null;
  deliveryNoteNumber?: string | null;
  orderNumber?: string | null;
  references?: MatchableReference[];
  totalWithoutVat?: number | null;
  totalWithVat?: number | null;
  issueDate?: string | null;
}

function norm(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = normalizeReferenceNumber(value);
  return n || null;
}

function ico(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = value.replace(/\D/g, "");
  return d || null;
}

/** All normalized reference numbers a document carries (header + references). */
function allRefs(doc: MatchableDocument): Set<string> {
  const set = new Set<string>();
  const add = (v: string | null | undefined) => {
    const n = norm(v);
    if (n) set.add(n);
  };
  add(doc.documentNumber);
  add(doc.deliveryNoteNumber);
  add(doc.orderNumber);
  for (const r of doc.references ?? []) add(r.referenceNumber);
  return set;
}

function refsOfType(
  doc: MatchableDocument,
  type: string,
): Set<string> {
  const set = new Set<string>();
  for (const r of doc.references ?? []) {
    if (r.referenceType === type) {
      const n = norm(r.referenceNumber);
      if (n) set.add(n);
    }
  }
  return set;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

function totalsClose(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 0.5;
}

/**
 * Score how likely a delivery note and an invoice describe the same goods.
 *
 * A supplier-IČO mismatch (when both are present and differ) is a hard fail and
 * returns score 0 — two different suppliers' documents are never the same goods.
 */
export function scoreDeliveryNoteToInvoice(
  deliveryNote: MatchableDocument,
  invoice: MatchableDocument,
): ScoredMatch {
  const reasons: string[] = [];
  const dnIco = ico(deliveryNote.supplierIc);
  const invIco = ico(invoice.supplierIc);
  if (dnIco && invIco && dnIco !== invIco) {
    return { score: 0, strength: "none", reasons: ["Rozdílné IČO dodavatele"] };
  }

  let score = 0;
  if (dnIco && invIco && dnIco === invIco) {
    score += 0.15;
    reasons.push("Shodné IČO dodavatele");
  }

  // The invoice references the delivery note's number — strongest signal.
  const dnNumber = norm(deliveryNote.deliveryNoteNumber) ?? norm(deliveryNote.documentNumber);
  if (dnNumber) {
    const invDeliveryRefs = refsOfType(invoice, "delivery_note");
    if (invDeliveryRefs.has(dnNumber) || norm(invoice.deliveryNoteNumber) === dnNumber) {
      score += 0.55;
      reasons.push("Faktura odkazuje číslo dodacího listu");
    }
  }

  // Shared order number.
  const dnOrder = norm(deliveryNote.orderNumber);
  const invOrder = norm(invoice.orderNumber);
  if (dnOrder && invOrder && dnOrder === invOrder) {
    score += 0.25;
    reasons.push("Shodné číslo objednávky");
  } else if (intersects(refsOfType(deliveryNote, "order"), refsOfType(invoice, "order"))) {
    score += 0.25;
    reasons.push("Shodné číslo objednávky");
  }

  // Any other shared reference number.
  if (score < 0.55 && intersects(allRefs(deliveryNote), allRefs(invoice))) {
    score += 0.2;
    reasons.push("Shodné referenční číslo");
  }

  // Totals agree.
  if (
    totalsClose(deliveryNote.totalWithoutVat, invoice.totalWithoutVat) ||
    totalsClose(deliveryNote.totalWithVat, invoice.totalWithVat)
  ) {
    score += 0.2;
    reasons.push("Shodná částka");
  }

  // Issue dates close together.
  const days = daysBetween(deliveryNote.issueDate, invoice.issueDate);
  if (days != null && days <= 31) {
    score += 0.1;
    reasons.push("Blízká data vystavení");
  }

  score = Math.min(1, round2(score));
  return { score, strength: strengthFromScore(score), reasons };
}

export interface MatchableJob {
  id: number;
  title?: string | null;
  notes?: string | null;
  address?: string | null;
  clientSite?: string | null;
  customerId?: number | null;
}

/**
 * Score how likely a reference number (typically a `job` reference, but any
 * reference is accepted) points at a given job. Matching is by the reference
 * number appearing as a token in the job's title / notes / address, optionally
 * boosted when the supplier document's customer matches the job's customer.
 */
export function scoreReferenceToJob(
  referenceNumber: string,
  job: MatchableJob,
  opts: { documentCustomerId?: number | null } = {},
): ScoredMatch {
  const reasons: string[] = [];
  const needle = norm(referenceNumber);
  if (!needle) return { score: 0, strength: "none", reasons: [] };

  let score = 0;
  const haystacks: { label: string; value: string | null | undefined; weight: number }[] = [
    { label: "názvu zakázky", value: job.title, weight: 0.7 },
    { label: "poznámce zakázky", value: job.notes, weight: 0.5 },
    { label: "adrese zakázky", value: job.address, weight: 0.4 },
    { label: "místě stavby", value: job.clientSite, weight: 0.4 },
  ];
  for (const h of haystacks) {
    const hay = norm(h.value);
    if (hay && hay.includes(needle)) {
      score = Math.max(score, h.weight);
      reasons.push(`Referenční číslo nalezeno v ${h.label}`);
      break;
    }
  }

  if (
    score > 0 &&
    opts.documentCustomerId != null &&
    job.customerId != null &&
    opts.documentCustomerId === job.customerId
  ) {
    score = Math.min(1, score + 0.2);
    reasons.push("Shodný zákazník");
  }

  score = round2(score);
  return { score, strength: strengthFromScore(score), reasons };
}

/**
 * Rank a set of jobs for a reference number, strongest first, dropping
 * zero-score candidates.
 */
export function rankJobsForReference(
  referenceNumber: string,
  jobs: MatchableJob[],
  opts: { documentCustomerId?: number | null } = {},
): { job: MatchableJob; match: ScoredMatch }[] {
  return jobs
    .map((job) => ({ job, match: scoreReferenceToJob(referenceNumber, job, opts) }))
    .filter((c) => c.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score);
}
