import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("retired security-question recovery", () => {
  it("does not expose security-question or answer-based reset routes", () => {
    const auth = read("artifacts/api-server/src/routes/auth.ts");
    const routes = read("artifacts/api-server/src/routes/index.ts");
    const spec = read("lib/api-spec/openapi.yaml");

    expect(auth).not.toContain("/auth/forgot-password/");
    expect(routes).not.toContain("securityQuestionsRouter");
    expect(spec).not.toContain("/security-questions");
    expect(spec).not.toContain("ResetPasswordWithAnswers");
  });

  it("keeps password recovery server-local and revokes every target session", () => {
    const script = read("artifacts/api-server/src/scripts/reset-admin-password.ts");

    expect(script).toContain("stdin.isTTY");
    expect(script).toContain("db.transaction");
    expect(script).toContain("delete(userSessionsTable)");
    expect(script).toContain('action: "security_admin_password_reset"');
    expect(script).not.toMatch(/process\.argv\[[3-9]\].*password/i);
  });
});
