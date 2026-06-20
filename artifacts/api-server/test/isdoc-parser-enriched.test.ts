import { describe, it, expect } from "vitest";
import { parseIsdocBuffer } from "../src/lib/isdoc-parser";

/**
 * Tests for the enriched ISDOC fields added for the real supplier samples:
 * bank coordinates (IBAN/BIC/constant symbol/account), document UUID, header
 * order + delivery-note references, and per-line EAN / SKU / line number.
 */

const ENRICHED_ISDOC = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.1">
  <UUID>11111111-2222-3333-4444-555555555555</UUID>
  <ID>FV-2024-777</ID>
  <IssueDate>2024-06-01</IssueDate>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <OrderReference><ID>OBJ-2024/55</ID></OrderReference>
  <DeliveryNoteReference><ID>DL2024001</ID></DeliveryNoteReference>
  <PaymentMeans>
    <Payment>
      <Details>
        <VariableSymbol>2024000777</VariableSymbol>
        <ConstantSymbol>0308</ConstantSymbol>
        <SpecificSymbol>999</SpecificSymbol>
        <BankAccountNumber>123456789</BankAccountNumber>
        <IBAN>CZ6508000000192000145399</IBAN>
        <BIC>GIBACZPX</BIC>
      </Details>
    </Payment>
  </PaymentMeans>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification><ID>27636801</ID></PartyIdentification>
      <PartyName><Name>DEK a.s.</Name></PartyName>
    </Party>
  </AccountingSupplierParty>
  <InvoiceLines>
    <InvoiceLine>
      <ID>10</ID>
      <InvoicedQuantity unitCode="ks">4</InvoicedQuantity>
      <LineExtensionAmount>400</LineExtensionAmount>
      <UnitPrice>100</UnitPrice>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item>
        <Description>Zásuvka 230V</Description>
        <SellersItemIdentification><ID>SKU-ABC-1</ID></SellersItemIdentification>
        <CatalogueItemIdentification><ID>8590000000017</ID></CatalogueItemIdentification>
      </Item>
    </InvoiceLine>
  </InvoiceLines>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>400</TaxExclusiveAmount>
    <TaxInclusiveAmount>484</TaxInclusiveAmount>
  </LegalMonetaryTotal>
  <TaxTotal><TaxAmount>84</TaxAmount></TaxTotal>
</Invoice>`;

describe("parseIsdocBuffer — enriched fields", () => {
  const doc = parseIsdocBuffer(Buffer.from(ENRICHED_ISDOC, "utf8"), "f.isdoc");

  it("reads the stable document UUID", () => {
    expect(doc.isdocUuid).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("reads bank coordinates and payment symbols", () => {
    expect(doc.variableSymbol).toBe("2024000777");
    expect(doc.constantSymbol).toBe("0308");
    expect(doc.specificSymbol).toBe("999");
    expect(doc.bankAccount).toBe("123456789");
    expect(doc.iban).toBe("CZ6508000000192000145399");
    expect(doc.bic).toBe("GIBACZPX");
  });

  it("reads header order and delivery-note references", () => {
    expect(doc.orderNumber).toBe("OBJ-2024/55");
    expect(doc.deliveryNoteNumber).toBe("DL2024001");
  });

  it("reads per-line EAN, SKU and source line number", () => {
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      description: "Zásuvka 230V",
      supplierSku: "SKU-ABC-1",
      ean: "8590000000017",
      sourceLineNumber: "10",
    });
  });

  it("leaves enriched fields null when absent", () => {
    const minimal = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.1">
  <ID>X</ID>
  <InvoiceLines>
    <InvoiceLine>
      <ID>1</ID>
      <InvoicedQuantity unitCode="ks">1</InvoicedQuantity>
      <LineExtensionAmount>10</LineExtensionAmount>
      <Item><Description>Věc</Description></Item>
    </InvoiceLine>
  </InvoiceLines>
</Invoice>`;
    const m = parseIsdocBuffer(Buffer.from(minimal, "utf8"));
    expect(m.isdocUuid).toBeNull();
    expect(m.iban).toBeNull();
    expect(m.deliveryNoteNumber).toBeNull();
    expect(m.lines[0].ean).toBeNull();
    expect(m.lines[0].supplierSku).toBeNull();
  });
});
