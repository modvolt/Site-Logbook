import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("public Bearer OpenAPI and generated-client contract", () => {
  const spec = source("../../../lib/api-spec/openapi.yaml");
  const reactClient = source("../../../lib/api-client-react/src/generated/api.ts");
  const zodClient = source("../../../lib/api-zod/src/generated/api.ts");

  it("documents the canonical Bearer surface and deprecates legacy adapters", () => {
    expect(spec).toContain("publicBearer:");
    expect(spec).toContain("bearerFormat: opaque-public-grant");
    for (const operationId of [
      "getPublicJobDocumentForSignature",
      "signPublicJobDocument",
      "getPublicPpeSignature",
      "signPublicPpeSignature",
      "getPpeConfirmDetails",
      "confirmPpeAssignment",
      "getPublicQuote",
      "acceptPublicQuote",
      "rejectPublicQuote",
      "getPublicSwitchboard",
      "getPublicSwitchboardDocument",
    ]) {
      expect(spec).toMatch(new RegExp(
        `operationId: ${operationId}\\n[\\s\\S]{0,260}publicBearer: \\[\\]`,
      ));
    }
    for (const operationId of [
      "getPublicJobDocumentForSignatureLegacy",
      "signPublicJobDocumentLegacy",
      "getPublicPpeSignatureLegacy",
      "signPublicPpeSignatureLegacy",
      "getPublicQuoteLegacy",
      "acceptPublicQuoteLegacy",
      "rejectPublicQuoteLegacy",
      "getPublicSwitchboardLegacy",
      "getPublicSwitchboardDocumentLegacy",
    ]) {
      expect(spec).toMatch(new RegExp(
        `operationId: ${operationId}\\n\\s+deprecated: true`,
      ));
    }
  });

  it("keeps public credentials out of generated React Query keys and URLs", () => {
    expect(reactClient).not.toContain("getPublicQuote");
    expect(reactClient).not.toContain("signPublicJobDocument");
    expect(reactClient).not.toContain("getPpeConfirmDetails");
    expect(reactClient).not.toContain("getPublicSwitchboard");
    expect(reactClient).not.toMatch(/\/sign\/\$\{|\/quotes\/public\/\$\{|token=.*ppe\/confirm/);
  });

  it("still generates validation schemas with an optional deprecated PPE token", () => {
    expect(zodClient).toContain("export const GetPublicSwitchboardResponse");
    expect(zodClient).toContain("export const GetPublicPpeSignatureResponse");
    expect(zodClient).toMatch(
      /ConfirmPpeAssignmentBody = zod\.object\(\{[\s\S]{0,160}"token": zod\.string\(\)\.optional\(\)/,
    );
  });
});
