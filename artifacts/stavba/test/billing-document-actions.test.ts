import { describe, expect, it } from "vitest";
import { markCurrentDocumentAsDuplicate } from "../src/lib/billing-document-actions";

describe("billing document duplicate actions", () => {
  it("keeps the selected candidate primary and marks the current document duplicate", () => {
    expect(markCurrentDocumentAsDuplicate(179, 134)).toEqual({
      id: 179,
      data: { primaryDocumentId: 134 },
    });
  });
});
