import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const scriptPath =
  "artifacts/api-server/src/scripts/preflight-public-token-consume-actions.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("public token consume-action migration preflight", () => {
  it("is database-enforced read-only and requires the exact database name", () => {
    const script = read(scriptPath);
    const packageJson = JSON.parse(
      read("artifacts/api-server/package.json"),
    ) as { scripts: Record<string, string> };

    expect(script).toContain("set transaction read only");
    expect(script).toContain(
      'argument("database") !== database',
    );
    expect(script).toContain('mode: "read-only"');
    expect(script).not.toMatch(/\b(?:update|insert|delete)\s+public_access_tokens\b/i);
    expect(script).not.toContain(".update(");
    expect(script).not.toContain(".insert(");
    expect(script).not.toContain(".delete(");
    expect(packageJson.scripts["public-tokens:preflight-consume-actions"])
      .toBe("tsx src/scripts/preflight-public-token-consume-actions.ts");
  });

  it("reports every row that would violate the tightened 0104 CHECK", () => {
    const script = read(scriptPath);

    expect(script).toContain(
      "purpose in ('job_signature', 'ppe_signature') and consume_action = 'signed'",
    );
    expect(script).toContain(
      "purpose = 'ppe_confirmation' and consume_action = 'confirmed'",
    );
    expect(script).toContain(
      "purpose = 'quote_decision' and consume_action in ('accepted', 'rejected')",
    );
    expect(script).toContain("group by purpose, consume_action, consumed_at is not null");
    expect(script).toContain('decision: blocked ? "BLOCK" : "PASS"');
    expect(script).toContain("if (blocked) process.exitCode = 2");
  });
});
