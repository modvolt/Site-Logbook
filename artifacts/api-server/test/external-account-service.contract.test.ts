import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const service = readFileSync(
  resolve(
    root,
    "artifacts/api-server/src/lib/external-account-service.ts",
  ),
  "utf8",
);

function mutation(name: string, nextName?: string): string {
  const start = service.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = nextName
    ? service.indexOf(`export async function ${nextName}`, start + 1)
    : service.length;
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
}

describe("external account management service contract", () => {
  it("keeps the rollout dark and creates only inactive draft identities", () => {
    const create = mutation(
      "createExternalAccountDraft",
      "activateExternalAccount",
    );
    const activate = mutation(
      "activateExternalAccount",
      "updateExternalAccountExpiry",
    );

    expect(create).toContain('accountType: "external"');
    expect(create).toContain('role: "guest"');
    expect(create).toContain("personId: null");
    expect(create).toContain("isActive: false");
    expect(create).toContain('status: "draft"');
    expect(activate).toContain("externalAccountsEnabled()");
    expect(activate).toContain('"external_accounts_disabled"');
    expect(activate).toContain('account.status !== "draft"');
    expect(activate).toContain('status: "active"');
    expect(activate).toContain("isNull(externalAccountScopesTable.revokedAt)");
    expect(activate).toContain("gt(externalAccountScopesTable.expiresAt, now)");
  });

  it("serializes every lifecycle mutation with manager and issuance locks", () => {
    const names = [
      ["createExternalAccountDraft", "activateExternalAccount"],
      ["activateExternalAccount", "updateExternalAccountExpiry"],
      ["updateExternalAccountExpiry", "replaceExternalAccountScopes"],
      ["replaceExternalAccountScopes", "transferExternalAccountCustodian"],
      ["transferExternalAccountCustodian", "revokeExternalAccount"],
      ["revokeExternalAccount", undefined],
    ] as const;

    for (const [name, nextName] of names) {
      const block = mutation(name, nextName);
      expect(block).toContain("db.transaction");
      expect(block).toContain("lockAndAuthorizeUserManager");
      expect(block).toContain("lockSessionIssuance");
    }
    expect(service).toContain("SESSION_ISSUANCE_LOCK_NAMESPACE");
    expect(service).toMatch(/for update of e, u/i);
  });

  it("uses optimistic versions and cuts off sessions after entitlement changes", () => {
    const names = [
      ["activateExternalAccount", "updateExternalAccountExpiry"],
      ["updateExternalAccountExpiry", "replaceExternalAccountScopes"],
      ["replaceExternalAccountScopes", "transferExternalAccountCustodian"],
      ["transferExternalAccountCustodian", "revokeExternalAccount"],
      ["revokeExternalAccount", undefined],
    ] as const;

    for (const [name, nextName] of names) {
      const block = mutation(name, nextName);
      expect(block).toContain("expectedVersion");
      expect(block).toContain("assertVersion");
      expect(block).toContain("invalidateExternalSessions");
      expect(block).toContain("externalAccountsTable.version");
    }
    expect(service).toContain("sessionGeneration: sql`${usersTable.sessionGeneration} + 1`");
    expect(service).toContain("delete(userSessionsTable)");
    expect(service).toContain("userSessionsTable.sess}->>'userId'");
  });

  it("accepts only exact direct read scopes for the three approved resources", () => {
    const replace = mutation(
      "replaceExternalAccountScopes",
      "transferExternalAccountCustodian",
    );

    expect(service).toContain('resourceType: "job"');
    expect(service).toContain('resourceType: "quote"');
    expect(service).toContain('resourceType: "switchboard"');
    expect(service).toContain('capability: "read"');
    expect(service).toContain("duplicate_external_account_scope");
    expect(service).toContain("assertResourcesExist");
    expect(service).toContain("jobsTable.id");
    expect(service).toContain("quotesTable.id");
    expect(service).toContain("switchboardsTable.id");
    expect(replace).toContain('eventType: "scope_revoked"');
    expect(replace).toContain('eventType: "scope_granted"');
    expect(replace).toContain('revocationReason: "scope_replaced"');
  });

  it("requires finite review windows, an active internal custodian and terminal revocation", () => {
    expect(service).toContain("maximum.setUTCFullYear(maximum.getUTCFullYear() + 1)");
    expect(service).toContain('custodian.accountType !== "internal"');
    expect(service).toContain("!custodian?.isActive");

    const expiry = mutation(
      "updateExternalAccountExpiry",
      "replaceExternalAccountScopes",
    );
    const transfer = mutation(
      "transferExternalAccountCustodian",
      "revokeExternalAccount",
    );
    const revoke = mutation("revokeExternalAccount");
    expect(expiry).toContain('eventType: "account_access_reviewed"');
    expect(transfer).toContain('eventType: "custodian_transferred"');
    expect(revoke).toContain('status: "revoked"');
    expect(revoke).toMatch(
      /invalidateExternalSessions\([\s\S]*account\.userId,\s*false/,
    );
    expect(revoke).toContain('eventType: "account_revoked"');
    expect(service).toContain('account.status === "revoked"');
  });

  it("does not expose secrets in list or detail projections and never hard-deletes accounts", () => {
    const list = mutation(
      "listExternalAccounts",
      "getExternalAccountDetail",
    );
    const detail = mutation(
      "getExternalAccountDetail",
      "createExternalAccountDraft",
    );

    expect(list).not.toContain("passwordHash");
    expect(detail).not.toContain("passwordHash");
    expect(service).not.toMatch(/delete\(externalAccountsTable\)/);
    expect(service).not.toMatch(/delete\(usersTable\)/);
    expect(service).not.toMatch(/delete\(externalAccountScopesTable\)/);
  });
});
