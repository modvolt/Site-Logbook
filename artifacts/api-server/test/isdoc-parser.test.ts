import { describe, it, expect } from "vitest";
import {
  parseIsdocBuffer,
  isParsableIsdoc,
  IsdocParseError,
} from "../src/lib/isdoc-parser";

/**
 * Tests for the machine-side ISDOC/XML parser.
 *
 * Two things matter here: it reads only values that are explicitly present
 * (no guessing) and it is hardened against XXE — any DOCTYPE/ENTITY input is
 * rejected before parsing.
 */

const HAPPY_ISDOC = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.1">
  <ID>2024-000123</ID>
  <IssueDate>2024-05-01</IssueDate>
  <TaxPointDate>2024-05-01</TaxPointDate>
  <VATApplicableDate>2024-05-01</VATApplicableDate>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <PaymentMeans>
    <Payment>
      <Details>
        <VariableSymbol>2024000123</VariableSymbol>
      </Details>
    </Payment>
  </PaymentMeans>
  <DueDate>2024-05-15</DueDate>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification><ID>12345678</ID></PartyIdentification>
      <PartyName><Name>Stavebniny Dodavatel s.r.o.</Name></PartyName>
      <PostalAddress>
        <StreetName>Dlouha</StreetName>
        <BuildingNumber>5</BuildingNumber>
        <CityName>Praha</CityName>
        <PostalZone>11000</PostalZone>
      </PostalAddress>
      <PartyTaxScheme><CompanyID>CZ12345678</CompanyID></PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <InvoiceLines>
    <InvoiceLine>
      <ID>1</ID>
      <InvoicedQuantity unitCode="ks">10</InvoicedQuantity>
      <LineExtensionAmount>1000</LineExtensionAmount>
      <LineExtensionAmountTaxInclusive>1210</LineExtensionAmountTaxInclusive>
      <UnitPrice>100</UnitPrice>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item><Description>Cement 25kg</Description></Item>
    </InvoiceLine>
    <InvoiceLine>
      <ID>2</ID>
      <InvoicedQuantity unitCode="m">5</InvoicedQuantity>
      <LineExtensionAmount>500</LineExtensionAmount>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item><Description>Trubka</Description></Item>
    </InvoiceLine>
  </InvoiceLines>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>1500</TaxExclusiveAmount>
    <TaxInclusiveAmount>1815</TaxInclusiveAmount>
  </LegalMonetaryTotal>
  <TaxTotal><TaxAmount>315</TaxAmount></TaxTotal>
</Invoice>`;

describe("parseIsdocBuffer — happy path", () => {
  const doc = parseIsdocBuffer(Buffer.from(HAPPY_ISDOC, "utf8"), "faktura.isdoc");

  it("reads the document header", () => {
    expect(doc.documentNumber).toBe("2024-000123");
    expect(doc.supplierName).toBe("Stavebniny Dodavatel s.r.o.");
    expect(doc.supplierIc).toBe("12345678");
    expect(doc.supplierDic).toBe("CZ12345678");
    expect(doc.supplierAddress).toBe("Dlouha 5 Praha 11000");
    expect(doc.variableSymbol).toBe("2024000123");
    expect(doc.issueDate).toBe("2024-05-01");
    expect(doc.taxableSupplyDate).toBe("2024-05-01");
    expect(doc.dueDate).toBe("2024-05-15");
    expect(doc.currency).toBe("CZK");
  });

  it("reads the monetary totals", () => {
    expect(doc.subtotalWithoutVat).toBe(1500);
    expect(doc.totalWithVat).toBe(1815);
    expect(doc.totalVat).toBe(315);
  });

  it("reads each line item", () => {
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toMatchObject({
      description: "Cement 25kg",
      quantity: 10,
      unit: "ks",
      unitPriceWithoutVat: 100,
      vatRate: 21,
      totalWithoutVat: 1000,
      totalWithVat: 1210,
    });
    expect(doc.lines[1]).toMatchObject({
      description: "Trubka",
      quantity: 5,
      unit: "m",
      totalWithoutVat: 500,
    });
  });

  it("derives unit price from total / quantity when not explicit", () => {
    // Line 2 has no <UnitPrice>; 500 / 5 = 100.
    expect(doc.lines[1].unitPriceWithoutVat).toBe(100);
  });

  it("derives total VAT from subtotal/total when no TaxTotal is present", () => {
    const noTax = HAPPY_ISDOC.replace(
      "<TaxTotal><TaxAmount>315</TaxAmount></TaxTotal>",
      "",
    );
    const parsed = parseIsdocBuffer(Buffer.from(noTax, "utf8"));
    expect(parsed.totalVat).toBe(315);
  });
});

describe("parseIsdocBuffer — XXE / unsafe input is rejected", () => {
  it("rejects a document declaring a DOCTYPE", () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<Invoice><ID>&xxe;</ID></Invoice>`;
    expect(() => parseIsdocBuffer(Buffer.from(xxe, "utf8"))).toThrow(
      IsdocParseError,
    );
  });

  it("rejects a document declaring an internal ENTITY (billion laughs)", () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE lolz [ <!ENTITY lol "lol"> ]>
<Invoice><ID>&lol;</ID></Invoice>`;
    expect(() => parseIsdocBuffer(Buffer.from(lol, "utf8"))).toThrow(
      /DOCTYPE\/ENTITY|bezpečnostních/,
    );
  });

  it("rejects a bare ENTITY declaration even without DOCTYPE", () => {
    const ent = `<!ENTITY x "y"><Invoice><ID>1</ID></Invoice>`;
    expect(() => parseIsdocBuffer(Buffer.from(ent, "utf8"))).toThrow(
      IsdocParseError,
    );
  });
});

describe("isParsableIsdoc", () => {
  it("accepts XML/ISDOC content types and extensions", () => {
    expect(isParsableIsdoc("application/xml", "x.bin")).toBe(true);
    expect(isParsableIsdoc("", "faktura.isdoc")).toBe(true);
    expect(isParsableIsdoc("", "faktura.isdocx")).toBe(true);
    expect(isParsableIsdoc("", "faktura.xml")).toBe(true);
  });

  it("rejects unrelated content types and extensions", () => {
    expect(isParsableIsdoc("application/pdf", "faktura.pdf")).toBe(false);
    expect(isParsableIsdoc("image/jpeg", "uctenka.jpg")).toBe(false);
  });
});
