import QRCode from "qrcode";

export const INVOICE_CONSTANT_SYMBOL = "0308";

/** Czech variable symbols may contain at most 10 digits. */
export function invoiceVariableSymbol(invoiceNumber: string): string {
  return invoiceNumber.replace(/\D/g, "").slice(0, 10);
}

/**
 * Czech "QR Platba" (SPAYD — Short Payment Descriptor) generation for invoices.
 *
 * Czech banking apps scan a QR code encoding a single-line SPAYD string
 * (`SPD*1.0*ACC:<IBAN>*AM:<amount>*CC:CZK*X-VS:<vs>*...`). The account must be an
 * IBAN; we accept the supplier's IBAN directly, or derive it from a domestic
 * account number (`[prefix-]number/bankcode`) using the standard ISO 13616
 * mod-97 check, so the QR works even when only the domestic account is on file.
 */

/** Normalize an IBAN: strip whitespace, uppercase. */
function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * Derive a Czech IBAN from a domestic account number, or pass through a value
 * that already is a Czech IBAN. Returns null if the input can't be interpreted.
 *
 * Domestic format: `[prefix-]number/bankcode` where prefix ≤ 6 digits,
 * number ≤ 10 digits, bankcode = 4 digits. BBAN = bankcode(4) + prefix(6,
 * left-padded) + number(10, left-padded); check digits per ISO 13616.
 */
export function czAccountToIban(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.replace(/\s+/g, "");
  if (/^CZ\d{22}$/i.test(s)) return s.toUpperCase();

  const m = /^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const prefix = (m[1] ?? "").padStart(6, "0");
  const number = m[2].padStart(10, "0");
  const bank = m[3];
  const bban = bank + prefix + number; // 20 digits
  // Rearrange (BBAN + "CZ" + "00") with C=12, Z=35 → BBAN + "123500", mod 97.
  const remainder = Number(BigInt(bban + "123500") % 97n);
  const check = 98 - remainder;
  return `CZ${String(check).padStart(2, "0")}${bban}`;
}

/** Resolve the best IBAN for payment: explicit IBAN, else derived from the
 * domestic account number. Returns null when neither yields a usable IBAN. */
export function resolveIban(
  iban: string | null | undefined,
  bankAccount: string | null | undefined,
): string | null {
  if (iban && iban.trim()) {
    const normalized = normalizeIban(iban);
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalized)) return normalized;
  }
  return czAccountToIban(bankAccount);
}

/** Strip characters that would break the `*`-delimited SPAYD grammar. */
function spaydField(value: string): string {
  return value.replace(/\*/g, " ").trim();
}

export interface SpaydOptions {
  iban: string;
  bic?: string | null;
  amount: number;
  currency: string;
  variableSymbol?: string | null;
  message?: string | null;
  dueDateIso?: string | null;
}

/** Build a SPAYD (`SPD*1.0*...`) payment string. */
export function buildSpayd(opts: SpaydOptions): string {
  const bic = opts.bic && /^[A-Z0-9]{8,11}$/i.test(opts.bic.replace(/\s+/g, ""))
    ? opts.bic.replace(/\s+/g, "").toUpperCase()
    : null;
  const acc = bic ? `${opts.iban}+${bic}` : opts.iban;

  const parts = [
    "SPD",
    "1.0",
    `ACC:${acc}`,
    `AM:${opts.amount.toFixed(2)}`,
    `CC:${spaydField(opts.currency)}`,
  ];
  if (opts.variableSymbol) {
    const vs = invoiceVariableSymbol(opts.variableSymbol);
    if (vs) parts.push(`X-VS:${vs}`);
  }
  if (opts.dueDateIso) {
    const dt = opts.dueDateIso.replace(/-/g, "").slice(0, 8);
    if (/^\d{8}$/.test(dt)) parts.push(`DT:${dt}`);
  }
  if (opts.message) parts.push(`MSG:${spaydField(opts.message).slice(0, 60)}`);
  return parts.join("*");
}

/** Render a SPAYD payload to a PNG data URL suitable for jsPDF `addImage`. */
export async function generatePaymentQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
}
