import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("account lifecycle security contracts", () => {
  it("serializes the first-admin count and insert in one transaction", () => {
    const auth = read("artifacts/api-server/src/routes/auth.ts");
    const transaction = auth.slice(auth.indexOf("async function createFirstAdmin"), auth.indexOf('router.get("/auth/me"'));

    expect(transaction).toContain("db.transaction");
    expect(transaction).toContain("pg_advisory_xact_lock");
    expect(transaction).toContain("count(*)::int");
    expect(transaction).toMatch(/tx\s*\.\s*insert\(usersTable\)/);
  });

  it("revokes all target sessions in the same transaction as a password change or deactivation", () => {
    const users = read("artifacts/api-server/src/routes/users.ts");

    expect(users).toContain("const revokeAllSessions = Boolean(password) || updates.isActive === false");
    expect(users).toContain("db.transaction");
    expect(users).toMatch(/tx\s*\.\s*delete\(userSessionsTable\)/);
    expect(users).toContain("userSessionsTable.sess");
    expect(users).toContain("await destroySession(req)");
    expect(users).toContain("updates.sessionGeneration");
  });

  it("stores and checks a credential generation so deleted sessions cannot be resurrected", () => {
    const session = read("artifacts/api-server/src/lib/auth-session.ts");
    const middleware = read("artifacts/api-server/src/middlewares/auth.ts");
    const recovery = read("artifacts/api-server/src/scripts/reset-admin-password.ts");
    const sessions = read("artifacts/api-server/src/routes/sessions.ts");

    expect(session).toContain("req.session.sessionGeneration = user.sessionGeneration");
    expect(middleware).toContain("s.sessionGeneration !== user.sessionGeneration");
    expect(middleware).toContain('res.clearCookie("stavba.sid")');
    expect(recovery).toContain("sessionGeneration: sql");
    expect(sessions).toContain("sessionGeneration: sql");
    expect(sessions).toContain("await saveSession(req)");
  });

  it("requires twelve characters for newly assigned passwords while leaving login compatible", () => {
    const spec = read("lib/api-spec/openapi.yaml");
    const login = spec.slice(spec.indexOf("LoginInput:"), spec.indexOf("MeResponse:"));
    const setup = spec.slice(spec.indexOf("SetupInput:"), spec.indexOf("UserInput:"));

    expect(login).toContain("minLength: 1");
    expect(setup).toContain("minLength: 12");
  });
});
