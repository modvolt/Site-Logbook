import { describe, it, expect } from "vitest";
import {
  INVOICE_CONSTANT_SYMBOL,
  invoiceVariableSymbol,
  czAccountToIban,
  resolveIban,
  buildSpayd,
} from "../src/lib/invoice-qr";

describe("invoice payment symbols", () => {
  it("uses the fixed Czech services constant symbol", () => {
    expect(INVOICE_CONSTANT_SYMBOL).toBe("0308");
  });

  it("derives the variable symbol from invoice-number digits", () => {
    expect(invoiceVariableSymbol("FV20260001")).toBe("20260001");
    expect(invoiceVariableSymbol("FV-2026/0042")).toBe("20260042");
  });

  it("limits the variable symbol to the banking maximum of ten digits", () => {
    expect(invoiceVariableSymbol("FV123456789012")).toBe("1234567890");
  });
});

/** ISO 13616 IBAN validity (move first 4 chars to end, letters→digits, mod 97 == 1). */
function isValidIban(iban: string): boolean {
  const s = iban.toUpperCase();
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return Number(BigInt(numeric) % 97n) === 1;
}

describe("czAccountToIban", () => {
  it("derives a Czech IBAN from a prefixed domestic account", () => {
    const iban = czAccountToIban("19-2000145399/0800");
    expect(iban).toBe("CZ6508000000192000145399");
    expect(isValidIban(iban!)).toBe(true);
  });

  it("derives a valid Czech IBAN from an account without a prefix", () => {
    const iban = czAccountToIban("2000145399/0800");
    expect(iban).toMatch(/^CZ\d{22}$/);
    expect(isValidIban(iban!)).toBe(true);
  });

  it("passes through a value that is already a Czech IBAN (with spaces)", () => {
    expect(czAccountToIban("CZ65 0800 0000 1920 0014 5399")).toBe(
      "CZ6508000000192000145399",
    );
  });

  it("returns null for unparseable input", () => {
    expect(czAccountToIban("not-an-account")).toBeNull();
    expect(czAccountToIban("")).toBeNull();
    expect(czAccountToIban(null)).toBeNull();
  });
});

describe("resolveIban", () => {
  it("prefers an explicit IBAN over the domestic account", () => {
    expect(resolveIban("CZ6508000000192000145399", "123456/0100")).toBe(
      "CZ6508000000192000145399",
    );
  });

  it("falls back to deriving from the domestic account", () => {
    expect(resolveIban(null, "19-2000145399/0800")).toBe("CZ6508000000192000145399");
  });

  it("returns null when neither is usable", () => {
    expect(resolveIban("", "")).toBeNull();
  });
});

describe("buildSpayd", () => {
  it("builds a canonical SPAYD string with amount, VS, due date and message", () => {
    const s = buildSpayd({
      iban: "CZ6508000000192000145399",
      amount: 6210,
      currency: "CZK",
      variableSymbol: "20260001",
      message: "Faktura FV20260001",
      dueDateIso: "2026-07-04",
    });
    expect(s).toBe(
      "SPD*1.0*ACC:CZ6508000000192000145399*AM:6210.00*CC:CZK*X-VS:20260001*DT:20260704*MSG:Faktura FV20260001",
    );
  });

  it("appends BIC to the account when valid", () => {
    const s = buildSpayd({
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
      amount: 100,
      currency: "CZK",
    });
    expect(s).toContain("ACC:CZ6508000000192000145399+GIBACZPX");
  });

  it("strips non-digits from the variable symbol and formats amount to 2 decimals", () => {
    const s = buildSpayd({
      iban: "CZ6508000000192000145399",
      amount: 1234.5,
      currency: "CZK",
      variableSymbol: "FV-2026/0001",
    });
    expect(s).toContain("AM:1234.50");
    expect(s).toContain("X-VS:20260001");
  });
});
