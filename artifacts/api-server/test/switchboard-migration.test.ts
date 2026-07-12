import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0080_third_rumiko_fujikawa.sql"), "utf8");

describe("switchboard migration safety", () => {
  it("creates the complete append-only domain without altering existing domain tables", () => {
    expect(sql).toContain('CREATE TABLE "switchboards"');
    expect(sql).toContain('CREATE TABLE "switchboard_documents"');
    expect(sql).toContain('CREATE TABLE "switchboard_protocol_versions"');
    expect(sql).not.toMatch(/ALTER TABLE "(?:jobs|billing_|invoices|materials|attachments)/);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it("seeds the central named-field registry idempotently", () => {
    expect(sql).toContain("'serialNumber', 'Výrobní číslo'");
    expect(sql).toContain("'boardDesignation', 'Označení rozvaděče'");
    expect(sql).toContain('ON CONFLICT ("field_key") DO NOTHING');
  });
});
