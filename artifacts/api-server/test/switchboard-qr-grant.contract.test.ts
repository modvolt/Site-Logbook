import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const schema = readFileSync(resolve(root, "lib/db/src/schema/switchboards.ts"), "utf8");
const service = readFileSync(resolve(process.cwd(), "src/lib/switchboard-qr-grant.ts"), "utf8");
const route = readFileSync(resolve(process.cwd(), "src/routes/switchboard-qr.ts"), "utf8");
const label = readFileSync(resolve(process.cwd(), "src/lib/switchboard-label-version.ts"), "utf8");

describe("R16-B switchboard QR grant contract", () => {
  it("stores only a normalized user-agent hash in the QR access audit", () => {
    expect(route).toContain("normalizedUserAgentSha256");
    expect(route).toContain('userAgent: normalizedUserAgentSha256(req.get("user-agent"))');
    expect(route).not.toContain('req.headers["user-agent"].slice');
  });

  it("uses a nullable expand-only owner tuple with resource and user invariants", () => {
    for (const column of [
      'text("qr_owner_kind")',
      'integer("qr_owner_user_id")',
      'timestamp("qr_owner_assigned_at")',
      'text("qr_owner_assignment_source")',
    ]) {
      expect(schema).toContain(column);
    }
    expect(schema).toContain('"switchboards_qr_owner_assignment_chk"');
    expect(schema).toMatch(/qrOwnerKind\}\s+is null[\s\S]+qrOwnerUserId\}\s+is null[\s\S]+qrOwnerAssignedAt\}\s+is null[\s\S]+qrOwnerAssignmentSource\}\s+is null/);
    expect(schema).toContain("qrOwnerKind} = 'resource'");
    expect(schema).toContain("qrOwnerUserId} is null");
    expect(schema).toContain("qrOwnerKind} = 'user'");
    expect(schema).toContain("qrOwnerUserId} is not null");
    expect(schema).toContain('{ onDelete: "restrict" }');
  });

  it("revalidates the active actor and effective permission at the offboarding cutoff", () => {
    expect(service).toContain("SESSION_ISSUANCE_LOCK_NAMESPACE");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("actor?.isActive");
    expect(service).toContain("resolvePermissions");
    expect(service).toContain('includes("switchboards.qr.manage")');
    expect(service).toContain('.for("update")');
    expect(route).toContain("rotateSwitchboardQrGrant");
    expect(route).toContain("deactivateSwitchboardQrGrant");
    expect(route).not.toContain("db.update(switchboardsTable).set({ qrTokenHash");
  });

  it("serializes every QR mutation on one historical per-board lock", () => {
    expect(service).toContain("lockSwitchboardQrGrant(tx, input.switchboardId)");
    expect(service).toContain("SWITCHBOARD_QR_LOCK_KEY");
    expect(service).toContain("pg_advisory_xact_lock(${switchboardId}, ${SWITCHBOARD_QR_LOCK_KEY})");
    expect(label).toContain("lockSwitchboardQrGrant(tx, board.id)");
    expect(label).toContain("!currentBoard.qrEnabled");
    expect(label).toContain("currentBoard.qrExpiresAt <= new Date()");
    expect(label).not.toContain("pg_advisory_xact_lock(${board.id}, 8403)");
  });

  it("makes every new manual or automatic QR finite and resource-owned", () => {
    expect(service).toContain("resolveSwitchboardQrExpiry(input.requestedExpiresAt, now)");
    expect(service).toContain('qrOwnerKind: "resource"');
    expect(service).toContain('qrOwnerAssignmentSource: "switchboard_resource"');
    expect(label).toContain("qrExpiresAt: resolveSwitchboardQrExpiry(undefined, now)");
    expect(label).toContain('qrOwnerKind: "resource"');
    expect(label).toContain('qrOwnerUserId: null');
    expect(label).not.toContain("qrExpiresAt: null");
  });

  it("persists rotate/deactivate provenance in the same transaction as state", () => {
    expect(service).toContain('eventType: "qr_token_rotated"');
    expect(service).toContain('eventType: "qr_token_deactivated"');
    expect(service).toContain("actorUserId: actor.id");
    expect(service).toContain("actorName: actor.name");
    expect(service).toContain("return db.transaction(async (tx) =>");
  });
});
