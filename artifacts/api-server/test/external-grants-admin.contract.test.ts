import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("external grant administration contract", () => {
  it("lists only redacted metadata behind users.manage", () => {
    const route = read("artifacts/api-server/src/routes/external-grants.ts");

    expect(route).toContain('router.get(\n  "/external-grants"');
    expect(route).toContain('requirePermission("users.manage")');
    expect(route).toContain("tokenPrefix: publicAccessTokensTable.tokenPrefix");
    expect(route).not.toContain("tokenHash: publicAccessTokensTable.tokenHash");
    expect(route).not.toContain("token: publicAccessTokensTable");
    expect(route).toContain("limit: z.coerce.number().int().min(1).max(100)");
    expect(route).toContain('"/external-grants/switchboard-qr"');
    expect(route).not.toContain("qrTokenHash: switchboardsTable.qrTokenHash");
    expect(route).not.toContain(
      "qrTokenCiphertext: switchboardsTable.qrTokenCiphertext",
    );
    const qrList = route.slice(
      route.indexOf("const qrListQuery"),
      route.indexOf("const revokeBody"),
    );
    expect(qrList).toContain("beforeId: z.coerce.number().int().positive().optional()");
    expect(qrList).toContain("lt(switchboardsTable.id, query.data.beforeId)");
    expect(qrList).toContain(".orderBy(desc(switchboardsTable.id))");
    expect(qrList).toContain("nextBeforeId:");
    expect(qrList).toContain("isNotNull(switchboardsTable.qrTokenPrefix)");
    expect(qrList).toMatch(
      /status === "expired"[\s\S]*lte\(switchboardsTable\.qrExpiresAt, now\)[\s\S]*isNull\(switchboardsTable\.archivedAt\)/,
    );
  });

  it("step-up protects revocation and revalidates the manager in-transaction", () => {
    const route = read("artifacts/api-server/src/routes/external-grants.ts");
    const service = read(
      "artifacts/api-server/src/lib/public-access-token.ts",
    );

    expect(route).toContain('"/external-grants/public/:id/revoke"');
    expect(route).toContain("requireVaultStepUp");
    expect(route).toContain("lockAndAuthorizeUserManager");
    expect(route).toContain("revokePublicAccessTokenById");
    expect(service).toContain("lockGrantFamily(tx, purpose, candidate.resourceId)");
    expect(service).toContain("isNull(publicAccessTokensTable.revokedAt)");
    expect(service).toContain("isNull(publicAccessTokensTable.consumedAt)");
  });

  it("is classified, registered and represented in OpenAPI", () => {
    const policy = read(
      "artifacts/api-server/src/lib/api-route-access-policy.ts",
    );
    const manifest = read(
      "artifacts/api-server/src/generated/api-route-manifest.ts",
    );
    const spec = read("lib/api-spec/openapi.yaml");
    const client = read("lib/api-client-react/src/generated/api.ts");

    expect(policy).toContain('prefixes: ["/external-grants"]');
    expect(manifest).toContain('template: "/external-grants"');
    expect(manifest).toContain(
      'template: "/external-grants/public/:id/revoke"',
    );
    expect(manifest).toContain(
      'template: "/external-grants/switchboard-qr/:id/deactivate"',
    );
    expect(spec).toContain("operationId: listExternalGrants");
    expect(spec).toMatch(
      /operationId: listSwitchboardQrGrants[\s\S]*- name: beforeId/,
    );
    expect(spec).toMatch(
      /SwitchboardQrGrantList:[\s\S]*required: \[items, nextBeforeId\]/,
    );
    expect(spec).toContain("operationId: revokeExternalGrant");
    expect(client).toContain("export const listExternalGrants");
    expect(client).toContain("export const revokeExternalGrant");
    expect(client).toContain("export const listSwitchboardQrGrants");
    expect(client).toContain(
      "export const deactivateSwitchboardQrExternalGrant",
    );
  });
});
