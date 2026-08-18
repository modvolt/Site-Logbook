import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("immutable PPE public evidence contract", () => {
  it("binds every new PPE capability to one immutable evidence version", () => {
    const tokenSchema = read("lib/db/src/schema/public-access-tokens.ts");
    const versionSchema = read("lib/db/src/schema/ppe-public-evidence.ts");

    expect(versionSchema).toContain('"ppe_public_evidence_versions"');
    expect(versionSchema).toContain('jsonb("data_snapshot")');
    expect(versionSchema).toContain('text("snapshot_sha256").notNull()');
    expect(versionSchema).toContain('text("confirmation_text").notNull()');
    expect(versionSchema).toContain('{ onDelete: "restrict" }');
    expect(tokenSchema).toContain('integer("ppe_evidence_version_id")');
    expect(tokenSchema).toContain(
      "artifactBindingStatus} = 'bound' and ${table.ppeEvidenceVersionId} is not null",
    );
    expect(tokenSchema).toContain(
      "artifactBindingStatus} = 'not_applicable' and ${table.ppeEvidenceVersionId} is null",
    );
  });

  it("creates and validates the snapshot in the token transaction", () => {
    const service = read("artifacts/api-server/src/lib/ppe-public-evidence.ts");

    expect(service).toContain("export async function issuePpePublicEvidenceToken");
    expect(service).toContain("return db.transaction(async (tx) =>");
    expect(service).toContain('.for("update")');
    expect(service).toContain("dataSnapshot: snapshot");
    expect(service).toContain("snapshotSha256: evidenceSha256(snapshot)");
    expect(service).toContain("ppeEvidenceVersionId: evidenceVersion.id");
    expect(service).toContain("evidenceSha256(version.dataSnapshot) !== version.snapshotSha256");
    expect(service).toContain("resolvePublicAccessToken(purpose, token, tx)");
  });

  it("rechecks live eligibility and appends evidence before token consumption commits", () => {
    const service = read("artifacts/api-server/src/lib/ppe-public-evidence.ts");
    const eventsSchema = read("lib/db/src/schema/ppe-public-evidence-events.ts");
    const route = read("artifacts/api-server/src/routes/ppe.ts");

    expect(service).toContain("await lockEligibleAssignment(");
    expect(service).toContain("return consumePublicAccessToken({");
    expect(service).toContain("tx.insert(ppePublicEvidenceEventsTable).values({");
    expect(eventsSchema).toContain('"ppe_public_evidence_events"');
    expect(eventsSchema).toContain('unique("ppe_public_evidence_events_token_uq")');
    expect(eventsSchema.match(/onDelete: "restrict"/g)).toHaveLength(3);
    expect(route).toContain("resolvePpePublicEvidenceToken(");
    expect(route).toContain("consumePpePublicEvidenceToken({");
    expect(route).not.toContain('resolvePublicAccessToken("ppe_signature"');
    expect(route).not.toContain('resolvePublicAccessToken("ppe_confirmation"');
  });

  it("fails legacy PPE bindings closed and constrains consume actions by purpose", () => {
    const service = read("artifacts/api-server/src/lib/public-access-token.ts");
    const schema = read("lib/db/src/schema/public-access-tokens.ts");

    expect(service).toContain('if (record.artifactBindingStatus !== "bound")');
    expect(service).toContain(
      'throw new Error("PPE public token requires one PPE evidence version.")',
    );
    expect(schema).toContain(
      "purpose} in ('job_signature', 'ppe_signature') and ${table.consumeAction} = 'signed'",
    );
    expect(schema).toContain(
      "purpose} = 'ppe_confirmation' and ${table.consumeAction} = 'confirmed'",
    );
    expect(schema).toContain(
      "purpose} = 'quote_decision' and ${table.consumeAction} in ('accepted', 'rejected')",
    );
  });
});
