import { XMLParser } from "fast-xml-parser";

/**
 * Bank-statement parsing for payment matching.
 *
 * Two Komerční banka export formats are supported:
 *  - GPC / ABO  — a fixed-width text format (record types 074 header, 075 row).
 *    Czech accents are typically encoded as Windows-1250; we decode accordingly,
 *    but the fields we match on (amount, variable symbol) are ASCII digits so
 *    matching is encoding-independent.
 *  - CAMT.053   — ISO 20022 XML. Variable/constant/specific symbols are carried
 *    in proprietary reference tags (Tp=VS/KS/SS), per the Czech Banking
 *    Association profile.
 *
 * The parser is deliberately decoupled from invoices: it only normalizes raw
 * statement bytes into `BankTransaction[]`. The matching against invoices lives
 * in invoice-service.ts, so a future live bank-API feed can reuse the same
 * matching by producing the same `BankTransaction` shape.
 */

export type StatementFormat = "gpc" | "camt";
export type TransactionDirection = "credit" | "debit";

export interface BankTransaction {
  /** Always a positive magnitude in the statement currency (CZK normally). */
  amount: number;
  currency: string;
  /** Incoming (credit) payments are the ones matched to receivables. */
  direction: TransactionDirection;
  /** Variable symbol with leading zeros stripped, or null when absent. */
  variableSymbol: string | null;
  constantSymbol: string | null;
  specificSymbol: string | null;
  /** Counterparty (payer) display name, when the statement carries one. */
  counterparty: string | null;
  /** Counterparty account number / IBAN, when present. */
  counterpartyAccount: string | null;
  /** Free-text payment message, when present. */
  message: string | null;
  /** Booking/value date as ISO "YYYY-MM-DD", or null when unparseable. */
  date: string | null;
}

export interface ParsedStatement {
  format: StatementFormat;
  /** Statement owner's account number / IBAN, when detectable. */
  account: string | null;
  /** Statement date (header), ISO "YYYY-MM-DD" when detectable. */
  statementDate: string | null;
  transactions: BankTransaction[];
}

export class StatementParseError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "StatementParseError";
  }
}

/** Strip leading zeros and surrounding whitespace; empty/zero → null. */
function normalizeSymbol(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().replace(/^0+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** DDMMYY (GPC) → ISO "YYYY-MM-DD". Two-digit year pivoted at 2000. */
function gpcDateToIso(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d{6}$/.test(s)) return null;
  const dd = s.slice(0, 2);
  const mm = s.slice(2, 4);
  const yy = Number(s.slice(4, 6));
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** Sniff XML (CAMT) vs fixed-width text (GPC) from the first non-blank bytes. */
function detectFormat(text: string): StatementFormat {
  const head = text.slice(0, 2048).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<")) return "camt";
  // GPC rows begin with a 3-digit record type (074/075/078/079).
  if (/^\s*0(74|75|78|79)/.test(text)) return "gpc";
  // Fall back to CAMT only when it clearly looks like XML; else assume GPC.
  return head.includes("<Document") || head.includes("BkToCstmrStmt")
    ? "camt"
    : "gpc";
}

// ---------------------------------------------------------------------------
// GPC / ABO (fixed width)
// ---------------------------------------------------------------------------

/**
 * Decode raw bytes for a GPC file. KB exports GPC as Windows-1250; we try that
 * first and fall back to UTF-8. Only display fields (names) are affected — the
 * matched fields are ASCII.
 */
function decodeGpc(buf: Buffer): string {
  try {
    return new TextDecoder("windows-1250").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function parseGpc(buf: Buffer): ParsedStatement {
  const text = decodeGpc(buf);
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const transactions: BankTransaction[] = [];
  let account: string | null = null;
  let statementDate: string | null = null;

  for (const line of lines) {
    const type = line.slice(0, 3);
    if (type === "074") {
      // Header: account number at [3,19); statement date at [108,114) (DDMMYY).
      account = account ?? (line.slice(3, 19).trim().replace(/^0+/, "") || null);
      const d = gpcDateToIso(line.slice(108, 114));
      if (d) statementDate = d;
      continue;
    }
    if (type !== "075") continue;

    // Fixed-width 075 transaction row (ABO):
    //   [3,19)   own account (16)
    //   [19,35)  counter account (16)
    //   [35,48)  document number (13)
    //   [48,60)  amount in haléře (12)
    //   [60,61)  posting code: 1 debit, 2 credit, 4 storno-debit, 5 storno-credit
    //   [61,71)  variable symbol (10)
    //   [71,81)  constant symbol (10)
    //   [81,91)  specific symbol (10)
    //   [91,97)  value date DDMMYY (6)
    //   [97,117) counterparty name (20)
    const counterAccount = line.slice(19, 35).trim().replace(/^0+/, "");
    const amountRaw = line.slice(48, 60).trim();
    const code = line.slice(60, 61);
    const vs = line.slice(61, 71);
    const ks = line.slice(71, 81);
    const ss = line.slice(81, 91);
    const valueDate = gpcDateToIso(line.slice(91, 97));
    const name = line.slice(97, 117).trim();

    const haler = Number(amountRaw.replace(/\D/g, ""));
    if (!Number.isFinite(haler)) continue;
    const amount = haler / 100;
    // Money in = credit (2) or storno of an outgoing (4); else debit.
    const direction: TransactionDirection =
      code === "2" || code === "4" ? "credit" : "debit";

    transactions.push({
      amount,
      currency: "CZK",
      direction,
      variableSymbol: normalizeSymbol(vs),
      constantSymbol: normalizeSymbol(ks),
      specificSymbol: normalizeSymbol(ss),
      counterparty: name || null,
      counterpartyAccount: counterAccount || null,
      message: null,
      date: valueDate,
    });
  }

  if (transactions.length === 0) {
    throw new StatementParseError(
      "Ve výpisu GPC nebyly nalezeny žádné transakce (řádky typu 075).",
    );
  }
  return { format: "gpc", account, statementDate, transactions };
}

// ---------------------------------------------------------------------------
// CAMT.053 (XML)
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** First non-empty string found under a (possibly nested) value. */
function textOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const t = (v as XmlNode)["#text"];
    if (t != null) return String(t).trim() || null;
  }
  return null;
}

/**
 * Collect every { tp, ref } pair anywhere under a node. Handles both
 * `Refs.Prtry` ({ Tp: "VS", Ref }) and `CdtrRefInf` ({ Tp.CdOrPrtry.Prtry:
 * "VS", Ref }) shapes used by Czech banks.
 */
function collectRefs(node: unknown, out: { tp: string; ref: string }[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  const obj = node as XmlNode;
  if ("Ref" in obj) {
    const ref = textOf(obj.Ref);
    if (ref) {
      // Tp may be a plain string, or nested Tp.CdOrPrtry.Prtry / .Cd.
      let tp = textOf(obj.Tp);
      if (!tp && obj.Tp && typeof obj.Tp === "object") {
        const tpObj = obj.Tp as XmlNode;
        const cd = tpObj.CdOrPrtry as XmlNode | undefined;
        tp =
          textOf(cd?.Prtry) ??
          textOf(cd?.Cd) ??
          textOf(tpObj.Prtry) ??
          textOf(tpObj.Cd);
      }
      out.push({ tp: (tp ?? "").toUpperCase(), ref });
    }
  }
  for (const key of Object.keys(obj)) collectRefs(obj[key], out);
}

function pickSymbol(
  refs: { tp: string; ref: string }[],
  needle: string,
): string | null {
  const hit = refs.find((r) => r.tp.includes(needle));
  return hit ? normalizeSymbol(hit.ref) : null;
}

function camtDateToIso(node: unknown): string | null {
  // BookgDt/ValDt is { Dt: "YYYY-MM-DD" } or { DtTm: "YYYY-MM-DDThh:mm:ss" }.
  if (node == null || typeof node !== "object") return null;
  const obj = node as XmlNode;
  const dt = textOf(obj.Dt) ?? textOf(obj.DtTm);
  if (!dt) return null;
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function accountIdOf(acct: unknown): string | null {
  if (acct == null || typeof acct !== "object") return null;
  const id = (acct as XmlNode).Id as XmlNode | undefined;
  if (!id) return null;
  const iban = textOf(id.IBAN);
  if (iban) return iban;
  const othr = id.Othr as XmlNode | undefined;
  return textOf(othr?.Id);
}

function parseCamt(text: string): ParsedStatement {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    trimValues: true,
  });
  let doc: XmlNode;
  try {
    doc = parser.parse(text) as XmlNode;
  } catch {
    throw new StatementParseError("Soubor CAMT.053 se nepodařilo načíst (neplatné XML).");
  }

  const root =
    (doc.Document as XmlNode | undefined) ?? (doc as XmlNode);
  const bkToCstmr = (root.BkToCstmrStmt ?? root.BkToCstmrAcctRpt) as
    | XmlNode
    | undefined;
  if (!bkToCstmr) {
    throw new StatementParseError(
      "Soubor nevypadá jako CAMT.053 výpis (chybí BkToCstmrStmt).",
    );
  }
  const statements = asArray<XmlNode>(
    (bkToCstmr.Stmt ?? bkToCstmr.Rpt) as XmlNode | XmlNode[] | undefined,
  );

  const transactions: BankTransaction[] = [];
  let account: string | null = null;
  let statementDate: string | null = null;

  for (const stmt of statements) {
    account = account ?? accountIdOf(stmt.Acct);
    statementDate =
      statementDate ??
      camtDateToIso(stmt.CreDtTm ? { DtTm: stmt.CreDtTm } : undefined) ??
      camtDateToIso(stmt.FrToDt ? (stmt.FrToDt as XmlNode).ToDtTm : undefined);

    for (const ntry of asArray<XmlNode>(stmt.Ntry as XmlNode | XmlNode[] | undefined)) {
      const amtNode = ntry.Amt as XmlNode | string | undefined;
      const amount = Number(textOf(amtNode));
      if (!Number.isFinite(amount)) continue;
      const currency =
        (amtNode && typeof amtNode === "object"
          ? (amtNode as XmlNode)["@_Ccy"]
          : undefined) as string | undefined;
      const ind = textOf(ntry.CdtDbtInd);
      const direction: TransactionDirection = ind === "DBIT" ? "debit" : "credit";
      const date =
        camtDateToIso(ntry.BookgDt) ?? camtDateToIso(ntry.ValDt) ?? statementDate;

      // TxDtls carries symbols, counterparty and message. Use the first one.
      const dtls = asArray<XmlNode>(
        (ntry.NtryDtls as XmlNode | undefined)?.TxDtls as
          | XmlNode
          | XmlNode[]
          | undefined,
      );
      const tx = dtls[0];

      const refs: { tp: string; ref: string }[] = [];
      collectRefs(tx ?? ntry, refs);
      const variableSymbol = pickSymbol(refs, "VS");
      const constantSymbol = pickSymbol(refs, "KS");
      const specificSymbol = pickSymbol(refs, "SS");

      let counterparty: string | null = null;
      let counterpartyAccount: string | null = null;
      let message: string | null = null;
      if (tx) {
        const rltd = tx.RltdPties as XmlNode | undefined;
        if (rltd) {
          // For an incoming payment the counterparty is the debtor (payer).
          const party = (direction === "credit" ? rltd.Dbtr : rltd.Cdtr) as
            | XmlNode
            | undefined;
          counterparty =
            textOf(party?.Nm) ??
            textOf((rltd.Dbtr as XmlNode | undefined)?.Nm) ??
            textOf((rltd.Cdtr as XmlNode | undefined)?.Nm);
          counterpartyAccount =
            accountIdOf(
              direction === "credit" ? rltd.DbtrAcct : rltd.CdtrAcct,
            ) ?? accountIdOf(rltd.DbtrAcct) ?? accountIdOf(rltd.CdtrAcct);
        }
        const rmt = tx.RmtInf as XmlNode | undefined;
        if (rmt) {
          const ustrd = asArray<unknown>(rmt.Ustrd as unknown)
            .map((u) => textOf(u))
            .filter((s): s is string => !!s);
          if (ustrd.length) message = ustrd.join(" ");
        }
      }

      transactions.push({
        amount: Math.abs(amount),
        currency: currency ?? "CZK",
        direction,
        variableSymbol,
        constantSymbol,
        specificSymbol,
        counterparty,
        counterpartyAccount,
        message,
        date,
      });
    }
  }

  if (transactions.length === 0) {
    throw new StatementParseError(
      "Ve výpisu CAMT.053 nebyly nalezeny žádné transakce.",
    );
  }
  return { format: "camt", account, statementDate, transactions };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Parse raw statement bytes (GPC/ABO text or CAMT.053 XML). */
export function parseBankStatement(buf: Buffer): ParsedStatement {
  if (!buf || buf.length === 0) {
    throw new StatementParseError("Soubor výpisu je prázdný.");
  }
  // Detect on a UTF-8 view (XML angle brackets / GPC digits are ASCII either way).
  const probe = buf.subarray(0, 4096).toString("utf8");
  const format = detectFormat(probe);
  return format === "camt" ? parseCamt(buf.toString("utf8")) : parseGpc(buf);
}
