import { describe, expect, it } from "vitest";
import {
  DOCUMENT_LINKING_DEFAULTS,
  resolveDocumentLinkingConfigFromEnv,
} from "../src/lib/document-linking-config";

describe("document-linking defaults", () => {
  it("auto-confirms matches at the non-alarm boundary by default", () => {
    expect(DOCUMENT_LINKING_DEFAULTS.autoLinkEnabled).toBe(true);
    expect(DOCUMENT_LINKING_DEFAULTS.autoConfirmEnabled).toBe(true);
    expect(DOCUMENT_LINKING_DEFAULTS.autoConfirmMinScore).toBe(0.8);
  });

  it("still allows an operator to disable auto-confirm explicitly", () => {
    const config = resolveDocumentLinkingConfigFromEnv({
      DOCUMENT_AUTO_CONFIRM_ENABLED: "false",
    });
    expect(config.autoConfirmEnabled).toBe(false);
  });
});
