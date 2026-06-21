import { describe, it, expect } from "vitest";
import {
  resolveJobMaterialPrice,
  MATERIAL_PRICE_SOURCES,
  type JobMaterialPriceCandidates,
} from "../src/lib/job-material-pricing";

/**
 * Tests for resolveJobMaterialPrice — the fixed priority rule that picks a job
 * material's unit price among the available signals:
 *   invoice → stock history (code) → stock history (name) → manual →
 *   delivery note → awaiting invoice.
 */

describe("resolveJobMaterialPrice", () => {
  it("prefers the confirmed invoice price over everything else", () => {
    const c: JobMaterialPriceCandidates = {
      invoice: { price: 123.456 },
      stockHistoryByCode: { price: 100 },
      manual: { price: 50 },
    };
    const r = resolveJobMaterialPrice(c);
    expect(r.source).toBe("invoice");
    expect(r.pricePerUnit).toBe(123.46);
    expect(r.confidence).toBe(1);
  });

  it("passes through an explicit invoice confidence", () => {
    const r = resolveJobMaterialPrice({ invoice: { price: 10, confidence: 0.82 } });
    expect(r.confidence).toBe(0.82);
  });

  it("uses stock history by code (0.9) when there is no invoice", () => {
    const r = resolveJobMaterialPrice({
      stockHistoryByCode: { price: 80 },
      stockHistoryByName: { price: 70 },
      manual: { price: 60 },
    });
    expect(r.source).toBe("stock_history");
    expect(r.pricePerUnit).toBe(80);
    expect(r.confidence).toBe(0.9);
  });

  it("falls back to stock history by name (0.6) when no code match", () => {
    const r = resolveJobMaterialPrice({
      stockHistoryByName: { price: 70 },
      manual: { price: 60 },
    });
    expect(r.source).toBe("stock_history");
    expect(r.pricePerUnit).toBe(70);
    expect(r.confidence).toBe(0.6);
  });

  it("uses the manual price (1.0) over a delivery-note price", () => {
    const r = resolveJobMaterialPrice({
      manual: { price: 60 },
      deliveryNote: { price: 65 },
    });
    expect(r.source).toBe("manual");
    expect(r.pricePerUnit).toBe(60);
    expect(r.confidence).toBe(1);
  });

  it("uses a delivery-note price (0.5) when nothing better exists", () => {
    const r = resolveJobMaterialPrice({ deliveryNote: { price: 65.005 } });
    expect(r.source).toBe("delivery_note");
    expect(r.pricePerUnit).toBe(65.01);
    expect(r.confidence).toBe(0.5);
  });

  it("returns awaiting_invoice with null price when no signal is usable", () => {
    const r = resolveJobMaterialPrice({});
    expect(r.source).toBe("awaiting_invoice");
    expect(r.pricePerUnit).toBeNull();
    expect(r.confidence).toBeNull();
  });

  it("skips candidates whose price is null/invalid and falls through", () => {
    const r = resolveJobMaterialPrice({
      invoice: { price: null },
      stockHistoryByCode: { price: null },
      manual: { price: 42 },
    });
    expect(r.source).toBe("manual");
    expect(r.pricePerUnit).toBe(42);
  });

  it("treats negative prices as invalid", () => {
    const r = resolveJobMaterialPrice({ invoice: { price: -5 }, manual: { price: 10 } });
    expect(r.source).toBe("manual");
  });

  it("exposes a stable source enum", () => {
    expect(MATERIAL_PRICE_SOURCES).toContain("invoice");
    expect(MATERIAL_PRICE_SOURCES).toContain("awaiting_invoice");
  });
});
