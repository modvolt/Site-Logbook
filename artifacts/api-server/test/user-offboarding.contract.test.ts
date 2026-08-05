import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("user offboarding security contract", () => {
  it("keeps access revocation, generation rotation and the audit row atomic", () => {
    const service = read(
      "artifacts/api-server/src/lib/user-offboarding-service.ts",
    );

    expect(service).toContain("db.transaction");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toMatch(/for update/i);
    expect(service).toContain("sessionGeneration");
    expect(service).toContain("userSessionsTable");
    expect(service).toContain("webauthnCredentialsTable");
    expect(service).toContain("userPermissionOverridesTable");
    expect(service).toContain("securityQuestionsTable");
    expect(service).toContain('action: "user.access.offboarded"');
    expect(service).toMatch(/tx\s*\.\s*insert\(auditLogTable\)/);
  });

  it("revalidates the actor and serializes the global manager cutoff", () => {
    const service = read(
      "artifacts/api-server/src/lib/user-offboarding-service.ts",
    );

    expect(service).toContain("actorUserId");
    expect(service).toContain("targetUserId");
    expect(service).toContain("users.manage");
    expect(service).toContain("resolvePermissions");
    expect(service).toMatch(/self[_ -]offboard/i);
    expect(service).toMatch(/expectedSessionGeneration/);
    expect(service).toMatch(/expectedUsername/);
  });

  it("does not delete the user, person or historical assignment records", () => {
    const service = read(
      "artifacts/api-server/src/lib/user-offboarding-service.ts",
    );

    expect(service).not.toMatch(/delete\(usersTable\)/);
    expect(service).not.toMatch(/delete\(peopleTable\)/);
    expect(service).not.toMatch(/delete\(jobsTable\)/);
    expect(service).not.toMatch(/delete\(jobAssigneesTable\)/);
    expect(service).not.toMatch(/delete\(jobVisitsTable\)/);
    expect(service).not.toMatch(/delete\(activityVisitsTable\)/);
    expect(service).not.toMatch(/delete\(machinesTable\)/);
    expect(service).not.toMatch(/delete\(ppeAssignmentsTable\)/);
    expect(service).not.toMatch(/delete\(switchboardAssigneesTable\)/);
    expect(service).not.toMatch(/delete\(switchboardDefectsTable\)/);
    expect(service).not.toMatch(/delete\(workSessionsTable\)/);
    expect(service).not.toMatch(/(?:delete|update)\(publicAccessTokensTable\)/);
  });

  it("prevents stale permission and WebAuthn writes from recreating access", () => {
    const users = read("artifacts/api-server/src/routes/users.ts");
    const webauthn = read("artifacts/api-server/src/routes/webauthn.ts");
    const auth = read("artifacts/api-server/src/routes/auth.ts");
    const sessions = read("artifacts/api-server/src/lib/auth-session.ts");
    const offboarding = read(
      "artifacts/api-server/src/lib/user-offboarding-service.ts",
    );

    expect(users).toContain("lockAndAuthorizeUserManager");
    expect(users).toMatch(/select id from users where id = \$\{userId\} for update/i);
    expect(users).toContain("user_inactive");
    expect(webauthn).toMatch(/select id from users where id = \$\{req\.auth!\.userId\} for update/i);
    expect(webauthn).toContain("req.session.sessionGeneration !== lockedUser.sessionGeneration");
    expect(webauthn).toContain("access_revoked");
    expect(auth).toContain("establishAuthenticatedSessionIfCurrent");
    expect(webauthn).toContain("establishAuthenticatedSessionIfCurrent");
    expect(sessions).toContain("SESSION_ISSUANCE_LOCK_NAMESPACE = 8457");
    expect(sessions).toContain("pg_advisory_xact_lock($1, $2)");
    const cutoff = offboarding.slice(
      offboarding.indexOf("export async function offboardUserAccess"),
    );
    expect(cutoff).toContain("SESSION_ISSUANCE_LOCK_NAMESPACE");
    expect(cutoff).toMatch(/lockAndAuthorizeUserManager[\s\S]*SESSION_ISSUANCE_LOCK_NAMESPACE[\s\S]*lockedUser/);
    expect(users).toMatch(/post\("\/users"[\s\S]*lockAndAuthorizeUserManager/);
    expect(webauthn).toContain('req.auth.permissions.includes("users.manage")');
  });

  it("exposes a step-up protected, exact-body API and skips duplicate generic audit", () => {
    const users = read("artifacts/api-server/src/routes/users.ts");
    const audit = read("artifacts/api-server/src/middlewares/audit.ts");
    const app = read("artifacts/api-server/src/app.ts");
    const spec = read("lib/api-spec/openapi.yaml");

    expect(users).toContain('"/users/:id/offboarding-preview"');
    expect(users).toContain('"/users/:id/offboard"');
    expect(users).toContain("requireVaultStepUp");
    expect(users).toContain("getUserOffboardingPreview");
    expect(users).toContain("offboardUserAccess");
    expect(audit).toMatch(/\^\\\/users\\\/\\d\+\\\/offboard\$/);

    const idempotency = app.indexOf(
      'app.use("/api", enforceOfflineIdempotency)',
    );
    const routers = app.indexOf('app.use("/api", router)');
    expect(idempotency).toBeGreaterThan(-1);
    expect(routers).toBeGreaterThan(idempotency);

    const input = spec.slice(
      spec.indexOf("UserOffboardingInput:"),
      spec.indexOf("UserOffboardingResult:"),
    );
    expect(input).toContain("additionalProperties: false");
    expect(input).toContain("expectedUsername");
    expect(input).toContain("expectedSessionGeneration");
    expect(input).toContain("confirmation");
  });
});
