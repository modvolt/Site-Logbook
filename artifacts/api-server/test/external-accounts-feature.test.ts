import { describe, expect, it } from "vitest";
import { externalAccountsEnabled } from "../src/lib/external-accounts-feature";

describe("external account dark rollout flag", () => {
  it("is fail-closed unless the exact lowercase value is true", () => {
    expect(externalAccountsEnabled({})).toBe(false);
    expect(externalAccountsEnabled({ EXTERNAL_ACCOUNTS_ENABLED: "false" })).toBe(false);
    expect(externalAccountsEnabled({ EXTERNAL_ACCOUNTS_ENABLED: "TRUE" })).toBe(false);
    expect(externalAccountsEnabled({ EXTERNAL_ACCOUNTS_ENABLED: "1" })).toBe(false);
    expect(externalAccountsEnabled({ EXTERNAL_ACCOUNTS_ENABLED: "true " })).toBe(false);
    expect(externalAccountsEnabled({ EXTERNAL_ACCOUNTS_ENABLED: "true" })).toBe(true);
  });
});
