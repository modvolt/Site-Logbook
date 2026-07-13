import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0080_third_rumiko_fujikawa.sql"), "utf8");
const qrSql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0081_silent_marrow.sql"), "utf8");
const operationsSql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0082_tense_rhino.sql"), "utf8");
const extractionCandidatesSql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0083_sturdy_dreaming_celestial.sql"), "utf8");

describe("switchboard migration safety", () => {
  it("creates the complete append-only domain without altering existing domain tables", () => {
    expect(sql).toContain('CREATE TABLE "switchboards"');
    expect(sql).toContain('CREATE TABLE "switchboard_documents"');
    expect(sql).toContain('CREATE TABLE "switchboard_protocol_versions"');
    expect(sql).toContain('CREATE UNIQUE INDEX "switchboard_documents_hash_unique_idx"');
    expect(sql).not.toMatch(/ALTER TABLE "(?:jobs|billing_|invoices|materials|attachments)/);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it("adds QR token protection and access audit without destructive changes", () => {
    expect(qrSql).toContain('CREATE TABLE "switchboard_qr_access_logs"');
    expect(qrSql).toContain('ADD COLUMN "qr_token_ciphertext"');
    expect(qrSql).toContain('CREATE UNIQUE INDEX "switchboards_qr_token_hash_unique_idx"');
    expect(qrSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it("seeds the central named-field registry idempotently", () => {
    expect(sql).toContain("'serialNumber', 'Výrobní číslo'");
    expect(sql).toContain("'boardDesignation', 'Označení rozvaděče'");
    expect(sql).toContain('ON CONFLICT ("field_key") DO NOTHING');
  });

  it("adds operation relations and lookup indexes without destructive changes", () => {
    expect(operationsSql).toContain('ALTER TABLE "switchboard_defects" ADD COLUMN "phase_key" text');
    expect(operationsSql).toContain('ALTER TABLE "switchboard_measurements" ADD COLUMN "phase_key" text');
    expect(operationsSql).toContain('ALTER TABLE "switchboard_photos" ADD COLUMN "checklist_item_key" text');
    expect(operationsSql).toContain('CREATE INDEX "switchboard_defects_board_status_idx"');
    expect(operationsSql).toContain('CREATE INDEX "switchboard_measurements_board_idx"');
    expect(operationsSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/i);
  });

  it("adds reviewable extraction candidates without rewriting historical values", () => {
    expect(extractionCandidatesSql).toContain('ADD COLUMN "value_candidates" jsonb');
    expect(extractionCandidatesSql).toContain("DEFAULT '[]'::jsonb NOT NULL");
    expect(extractionCandidatesSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/i);
    expect(extractionCandidatesSql).not.toMatch(/UPDATE\s+/i);
  });
});
