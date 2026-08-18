import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("public access token lifecycle hardening", () => {
  it("revalidates the active issuer and effective permission under the offboarding lock", () => {
    const service = read(
      "artifacts/api-server/src/lib/public-access-token.ts",
    );

    expect(service).toContain("SESSION_ISSUANCE_LOCK_NAMESPACE");
    expect(service).toContain("lockAndAssertActiveOwner");
    expect(service).toContain("usersTable.isActive");
    expect(service).toContain("userPermissionOverridesTable");
    expect(service).toContain("resolveAccountPermissions");
    expect(service).toContain("owner.accountType");
    expect(service).toContain("ISSUANCE_PERMISSION[purpose]");
    expect(service).toContain('"issuer_permission_revoked"');
    const guard = service.slice(
      service.indexOf("async function lockAndAssertActiveOwner"),
      service.indexOf("function validateArtifactBinding"),
    );
    expect(guard).toContain('.for("update")');
  });

  it("locks resource before actor, family and token state across every lifecycle", () => {
    const service = read(
      "artifacts/api-server/src/lib/public-access-token.ts",
    );

    expect(service).toContain('family = purpose === "ppe_signature" || purpose === "ppe_confirmation"');
    const issue = service.slice(
      service.indexOf("async function issueWithTransaction"),
      service.indexOf("export async function issuePublicAccessToken"),
    );
    expect(issue.indexOf("lockGrantResource")).toBeLessThan(
      issue.indexOf("lockAndAssertActiveOwner"),
    );
    expect(issue.indexOf("lockAndAssertActiveOwner")).toBeLessThan(
      issue.indexOf("lockGrantFamily"),
    );

    const load = service.slice(
      service.indexOf("async function loadTokenForUpdate"),
      service.indexOf("export async function resolvePublicAccessToken"),
    );
    expect(load.indexOf("lockGrantResource")).toBeLessThan(
      load.indexOf("lockGrantFamily"),
    );
    expect(load.indexOf("lockGrantFamily")).toBeLessThan(
      load.indexOf("findRecordForUpdate"),
    );

    const revoke = service.slice(
      service.indexOf("async function revokeWithTransaction"),
      service.indexOf("export async function revokePublicAccessTokens"),
    );
    expect(revoke.indexOf("lockGrantResource")).toBeLessThan(
      revoke.indexOf("lockGrantFamily"),
    );

    const legacyRead = service.slice(
      service.indexOf("async function readLegacyToken"),
      service.indexOf("async function clearImportedLegacyToken"),
    );
    expect(legacyRead.match(/\.for\("update"\)/g)).toHaveLength(4);
    const legacyImport = service.slice(
      service.indexOf("async function importLegacyToken"),
      service.indexOf("async function loadTokenForUpdate"),
    );
    expect(legacyImport.indexOf("readLegacyToken")).toBeLessThan(
      legacyImport.indexOf("lockGrantFamily"),
    );
  });

  it("fails closed when an explicitly configured expiry is invalid", () => {
    const service = read(
      "artifacts/api-server/src/lib/public-access-token.ts",
    );

    expect(service).toContain("const raw = process.env[envName]");
    expect(service).toContain("raw === undefined ? defaultDays : Number(raw)");
    expect(service).toContain("!Number.isInteger(days)");
    expect(service).toContain("expected an integer number of days from 1 to 365");
  });

  it("bounds new expiry and makes PPE completion invalidate the sibling mode", () => {
    const service = read(
      "artifacts/api-server/src/lib/public-access-token.ts",
    );

    expect(service).toContain("MAX_TOKEN_LIFETIME_MS = 365 * DAY_MS");
    expect(service).toContain("Public token expiry must be in the future");
    expect(service).toContain("Public token expiry exceeds the 365-day hard limit");
    expect(service).toContain('revokeReason: "superseded_by_completion"');
    expect(service).toContain(
      'ppe_signature: ["ppe_signature", "ppe_confirmation"]',
    );
  });

  it("revokes job signing in the archive transaction and rechecks archive state on consume", () => {
    const jobs = read("artifacts/api-server/src/routes/jobs.ts");
    const documents = read(
      "artifacts/api-server/src/lib/job-document-service.ts",
    );

    expect(jobs).toMatch(
      /archivedAt:[\s\S]*revokePublicAccessTokens[\s\S]*reason: "job_archived"/,
    );
    expect(documents).toContain('JobDocumentStateError("job_archived")');
    expect(documents).toContain("archivedAt: jobsTable.archivedAt");
  });
});
