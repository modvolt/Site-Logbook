/**
 * Machine-side ISDOC / XML parser for received cost documents.
 *
 * ISDOC is the Czech electronic-invoice standard (an XML document, usually a
 * `.isdoc` file; `.isdocx` is a ZIP wrapping the XML). This parser extracts the
 * header and line items we care about WITHOUT any AI — it only reads values
 * that are explicitly present in the document, and returns null for anything it
 * cannot read. Nothing is guessed.
 *
 * SECURITY (XXE): XML external-entity attacks are prevented in two layers:
 *   1. Any input containing a DOCTYPE or ENTITY declaration is rejected before
 *      parsing (defence in depth — ISDOC never legitimately needs them).
 *   2. fast-xml-parser is configured with `processEntities: false`, so even a
 *      custom internal entity is never expanded (blocks "billion laughs"); the
 *      parser also never resolves SYSTEM/external DTDs or makes any I/O.
 */
import { XMLParser } from "fast-xml-parser";
import { unzipSync, strFromU8 } from "fflate";
import { round2 } from "./invoice-calc";

export interface ParsedLine {
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPriceWithoutVat: number | null;
  vatRate: number | null;
  totalWithoutVat: number | null;
  totalWithVat: number | null;
}

export interface ParsedDocument {
  documentNumber: string | null;
  supplierName: string | null;
  supplierIc: string | null;
  supplierDic: string | null;
  supplierAddress: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  taxableSupplyDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotalWithoutVat: number | null;
  totalVat: number | null;
  totalWithVat: number | null;
  lines: ParsedLine[];
}

export class IsdocParseError extends Error {}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
});

/** Reject any XML that declares a DOCTYPE or ENTITY (XXE guard). */
function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new IsdocParseError(
      "Dokument obsahuje DOCTYPE/ENTITY a byl z bezpečnostních důvodů odmítnut.",
    );
  }
}

/** Depth-first search for the first node whose (NS-stripped) tag === name. */
function findFirst(node: unknown, name: string): unknown {
  if (node == null || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (name in obj) return obj[name];
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        const found = findFirst(c, name);
        if (found !== undefined) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findFirst(child, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Coerce an XML text node (possibly `{ "#text": "..." }`) to a trimmed string. */
function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const t = (value as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t.trim() || null;
    if (typeof t === "number") return String(t);
  }
  return null;
}

function numberOf(value: unknown): number | null {
  const s = text(value);
  if (s == null) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? round2(n) : null;
}

/** Normalize an ISDOC date ("2024-05-01" or "2024-05-01T...") to YYYY-MM-DD. */
function isoDate(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// ISDOC mapping
// ---------------------------------------------------------------------------

function parseLines(invoice: Record<string, unknown>): ParsedLine[] {
  const linesNode = findFirst(invoice, "InvoiceLines");
  const rawLines = linesNode ? asArray(findFirst(linesNode, "InvoiceLine")) : [];
  const result: ParsedLine[] = [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== "object") continue;
    const line = raw as Record<string, unknown>;
    const item = findFirst(line, "Item");
    const description =
      text(findFirst(item ?? {}, "Description")) ??
      text(findFirst(line, "Note")) ??
      text(findFirst(line, "Description")) ??
      "Položka";
    const qtyNode = findFirst(line, "InvoicedQuantity");
    const quantity = numberOf(qtyNode);
    let unit: string | null = null;
    if (qtyNode && typeof qtyNode === "object") {
      unit = text((qtyNode as Record<string, unknown>)["@_unitCode"]);
    }
    const totalWithoutVat = numberOf(findFirst(line, "LineExtensionAmount"));
    const totalWithVat = numberOf(
      findFirst(line, "LineExtensionAmountTaxInclusive"),
    );
    const unitPrice =
      numberOf(findFirst(line, "UnitPrice")) ??
      (quantity && quantity !== 0 && totalWithoutVat != null
        ? round2(totalWithoutVat / quantity)
        : null);
    const taxCat = findFirst(line, "ClassifiedTaxCategory");
    const vatRate = numberOf(findFirst(taxCat ?? line, "Percent"));
    result.push({
      description,
      quantity,
      unit,
      unitPriceWithoutVat: unitPrice,
      vatRate,
      totalWithoutVat,
      totalWithVat,
    });
  }
  return result;
}

function mapInvoice(root: Record<string, unknown>): ParsedDocument {
  const invoice =
    (findFirst(root, "Invoice") as Record<string, unknown> | undefined) ?? root;

  const supplierParty = findFirst(invoice, "AccountingSupplierParty");
  const party = supplierParty
    ? (findFirst(supplierParty, "Party") as Record<string, unknown> | undefined)
    : undefined;
  const supplierName = party
    ? text(findFirst(findFirst(party, "PartyName") ?? {}, "Name")) ??
      text(findFirst(party, "Name"))
    : null;
  const supplierIc = party
    ? text(findFirst(findFirst(party, "PartyIdentification") ?? {}, "ID"))
    : null;
  const supplierDic = party
    ? text(findFirst(findFirst(party, "PartyTaxScheme") ?? {}, "CompanyID"))
    : null;
  const addr = party
    ? (findFirst(party, "PostalAddress") as Record<string, unknown> | undefined)
    : undefined;
  const supplierAddress = addr
    ? [
        text(findFirst(addr, "StreetName")),
        text(findFirst(addr, "BuildingNumber")),
        text(findFirst(addr, "CityName")),
        text(findFirst(addr, "PostalZone")),
      ]
        .filter(Boolean)
        .join(" ") || null
    : null;

  const total = findFirst(invoice, "LegalMonetaryTotal");
  const subtotalWithoutVat = numberOf(
    findFirst(total ?? invoice, "TaxExclusiveAmount"),
  );
  const totalWithVat = numberOf(
    findFirst(total ?? invoice, "TaxInclusiveAmount") ??
      findFirst(total ?? invoice, "PayableAmount"),
  );
  const taxTotal = findFirst(invoice, "TaxTotal");
  let totalVat = numberOf(findFirst(taxTotal ?? {}, "TaxAmount"));
  if (totalVat == null && subtotalWithoutVat != null && totalWithVat != null) {
    totalVat = round2(totalWithVat - subtotalWithoutVat);
  }

  return {
    documentNumber: text(findFirst(invoice, "ID")),
    supplierName,
    supplierIc,
    supplierDic,
    supplierAddress,
    variableSymbol: text(findFirst(invoice, "VariableSymbol")),
    issueDate: isoDate(findFirst(invoice, "IssueDate")),
    taxableSupplyDate: isoDate(
      findFirst(invoice, "TaxPointDate") ?? findFirst(invoice, "VATApplicableDate"),
    ),
    dueDate: isoDate(findFirst(invoice, "DueDate")),
    currency:
      text(findFirst(invoice, "LocalCurrencyCode")) ??
      text(findFirst(invoice, "CurrencyCode")),
    subtotalWithoutVat,
    totalVat,
    totalWithVat,
    lines: parseLines(invoice),
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** True for content types / filenames we attempt to machine-parse as ISDOC. */
export function isParsableIsdoc(contentType: string, fileName: string): boolean {
  const ct = (contentType || "").toLowerCase();
  const fn = (fileName || "").toLowerCase();
  return (
    ct.includes("xml") ||
    ct.includes("isdoc") ||
    fn.endsWith(".isdoc") ||
    fn.endsWith(".isdocx") ||
    fn.endsWith(".xml")
  );
}

/** Parse a raw ISDOC/XML buffer. Throws IsdocParseError on unsafe/invalid input. */
export function parseIsdocBuffer(buffer: Buffer, fileName = ""): ParsedDocument {
  let xml: string;
  const fn = fileName.toLowerCase();
  const looksZip =
    buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  if (fn.endsWith(".isdocx") || looksZip) {
    // ISDOCX is a ZIP; the invoice XML is the single .isdoc/.xml entry inside.
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(buffer));
    } catch {
      throw new IsdocParseError("Soubor ISDOCX se nepodařilo rozbalit.");
    }
    const key = Object.keys(entries).find(
      (k) => k.toLowerCase().endsWith(".isdoc") || k.toLowerCase().endsWith(".xml"),
    );
    if (!key) throw new IsdocParseError("Archiv neobsahuje soubor ISDOC.");
    xml = strFromU8(entries[key]);
  } else {
    xml = buffer.toString("utf8");
  }

  assertNoDoctype(xml);
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new IsdocParseError(
      `XML se nepodařilo zpracovat: ${err instanceof Error ? err.message : "neznámá chyba"}`,
    );
  }
  if (!root || typeof root !== "object") {
    throw new IsdocParseError("Neplatný obsah XML.");
  }
  return mapInvoice(root);
}
