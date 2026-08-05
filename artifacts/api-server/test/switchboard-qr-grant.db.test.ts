import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  pool,
  switchboardEventsTable,
  switchboardsTable,
  usersTable,
} from "@workspace/db";
import {
  deactivateSwitchboardQrGrant,
  rotateSwitchboardQrGrant,
} from "../src/lib/switchboard-qr-grant";
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "../src/lib/auth-session";

if (process.env.AUTH_DB_TEST_ENABLED !== "true") {
  throw new Error("Refusing to run switchboard QR grant DB tests outside the isolated DB runner.");
}

const TAG = `r16b-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let jobId: number;
let boardId: number;
let activeActorId: number;
let inactiveActorId: number;
let guestActorId: number;
let raceActorId: number;

beforeAll(async () => {
  process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID = "r16b-qr-test";
  process.env.SECRET_ENCRYPTION_KEYRING = JSON.stringify({
    "r16b-qr-test": Buffer.alloc(32, 0x62).toString("base64"),
  });
  process.env.PUBLIC_APP_URL = "https://qr.example.test";

  const actors = await db.insert(usersTable).values([
    { username: `${TAG}-active`, passwordHash: "not-used", name: "QR active actor", role: "admin", isActive: true },
    { username: `${TAG}-inactive`, passwordHash: "not-used", name: "QR inactive actor", role: "admin", isActive: false },
    { username: `${TAG}-guest`, passwordHash: "not-used", name: "QR guest actor", role: "guest", isActive: true },
    { username: `${TAG}-race`, passwordHash: "not-used", name: "QR race actor", role: "admin", isActive: true },
  ]).returning({ id: usersTable.id, username: usersTable.username });
  activeActorId = actors.find((actor) => actor.username.endsWith("-active"))!.id;
  inactiveActorId = actors.find((actor) => actor.username.endsWith("-inactive"))!.id;
  guestActorId = actors.find((actor) => actor.username.endsWith("-guest"))!.id;
  raceActorId = actors.find((actor) => actor.username.endsWith("-race"))!.id;

  const [job] = await db.insert(jobsTable).values({
    title: `${TAG} job`,
    date: "2026-08-05",
    status: "planned",
  }).returning({ id: jobsTable.id });
  jobId = job.id;
  const [board] = await db.insert(switchboardsTable).values({
    jobId,
    internalName: `${TAG} board`,
    designation: TAG,
  }).returning({ id: switchboardsTable.id });
  boardId = board.id;
});

afterAll(async () => {
  if (boardId) {
    await db.delete(switchboardEventsTable).where(eq(switchboardEventsTable.switchboardId, boardId));
    await db.delete(switchboardsTable).where(eq(switchboardsTable.id, boardId));
  }
  if (jobId) await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  const actorIds = [activeActorId, inactiveActorId, guestActorId, raceActorId].filter(Boolean);
  if (actorIds.length) await db.delete(usersTable).where(inArray(usersTable.id, actorIds));
  await pool.end();
});

describe("isolated switchboard QR grant lifecycle", () => {
  it("rotates to a finite resource-owned grant and deactivates without erasing custody", async () => {
    const before = Date.now();
    const rotated = await rotateSwitchboardQrGrant({
      switchboardId: boardId,
      actorUserId: activeActorId,
    });
    expect(rotated.publicUrl).toMatch(/^https:\/\/qr\.example\.test\/q\/board\/[A-Za-z0-9_-]{43}$/);
    expect(rotated.board).toMatchObject({
      qrEnabled: true,
      qrOwnerKind: "resource",
      qrOwnerUserId: null,
      qrOwnerAssignmentSource: "switchboard_resource",
    });
    expect(rotated.board.qrOwnerAssignedAt).toBeInstanceOf(Date);
    expect(rotated.board.qrExpiresAt).toBeInstanceOf(Date);
    expect(rotated.board.qrExpiresAt!.getTime()).toBeGreaterThan(before + 4 * 365 * 24 * 60 * 60_000);
    expect(rotated.board.qrExpiresAt!.getTime()).toBeLessThanOrEqual(before + 5 * 366 * 24 * 60 * 60_000);
    expect(rotated.board.qrTokenHash).toMatch(/^[a-f0-9]{64}$/);
    const rawToken = rotated.publicUrl.split("/").at(-1)!;
    expect(rotated.board.qrTokenCiphertext).not.toContain(rawToken);

    const ownerAssignedAt = rotated.board.qrOwnerAssignedAt;
    const deactivated = await deactivateSwitchboardQrGrant({
      switchboardId: boardId,
      actorUserId: activeActorId,
    });
    expect(deactivated.qrEnabled).toBe(false);
    expect(deactivated.qrOwnerKind).toBe("resource");
    expect(deactivated.qrOwnerAssignedAt).toEqual(ownerAssignedAt);

    const events = await db.select({ eventType: switchboardEventsTable.eventType, actorUserId: switchboardEventsTable.actorUserId })
      .from(switchboardEventsTable)
      .where(eq(switchboardEventsTable.switchboardId, boardId));
    expect(events).toEqual(expect.arrayContaining([
      { eventType: "qr_token_rotated", actorUserId: activeActorId },
      { eventType: "qr_token_deactivated", actorUserId: activeActorId },
    ]));
  });

  it("rejects inactive actors and active users without effective QR permission", async () => {
    const [before] = await db.select({ tokenHash: switchboardsTable.qrTokenHash })
      .from(switchboardsTable).where(eq(switchboardsTable.id, boardId));
    await expect(rotateSwitchboardQrGrant({ switchboardId: boardId, actorUserId: inactiveActorId }))
      .rejects.toMatchObject({ statusCode: 403, code: "actor_access_revoked" });
    await expect(rotateSwitchboardQrGrant({ switchboardId: boardId, actorUserId: guestActorId }))
      .rejects.toMatchObject({ statusCode: 403, code: "actor_access_revoked" });
    const [after] = await db.select({ tokenHash: switchboardsTable.qrTokenHash })
      .from(switchboardsTable).where(eq(switchboardsTable.id, boardId));
    expect(after.tokenHash).toBe(before.tokenHash);
  });

  it("observes offboarding that wins the shared actor cutoff lock", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1, $2)", [
        SESSION_ISSUANCE_LOCK_NAMESPACE,
        raceActorId,
      ]);
      await client.query("update users set is_active = false where id = $1", [raceActorId]);
      const pendingRotate = rotateSwitchboardQrGrant({ switchboardId: boardId, actorUserId: raceActorId });
      await client.query("commit");
      await expect(pendingRotate).rejects.toMatchObject({
        statusCode: 403,
        code: "actor_access_revoked",
      });
    } finally {
      client.release();
    }
  });
});
