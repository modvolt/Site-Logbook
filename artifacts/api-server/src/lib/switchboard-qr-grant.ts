import { eq, sql } from "drizzle-orm";
import {
  db,
  resolveAccountPermissions,
  switchboardEventsTable,
  switchboardsTable,
  userPermissionOverridesTable,
  usersTable,
  USER_ROLES,
  type PermissionEffect,
  type UserRole,
  type UserAccountType,
} from "@workspace/db";
import { SESSION_ISSUANCE_LOCK_NAMESPACE } from "./auth-session";
import {
  createQrToken,
  encryptQrToken,
  hashQrToken,
  publicQrUrl,
  resolveSwitchboardQrExpiry,
  SWITCHBOARD_QR_LOCK_KEY,
} from "./switchboard-qr";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SwitchboardQrGrantError extends Error {
  constructor(
    readonly statusCode: 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SwitchboardQrGrantError";
  }
}

async function lockAndAuthorizeQrActor(
  tx: Transaction,
  actorUserId: number,
): Promise<{ id: number; name: string }> {
  // The same per-user lock is held by offboarding. Whichever transaction wins
  // defines the cutoff; an issuance that starts later observes the inactive
  // user and cannot create a fresh external grant from a stale session.
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SESSION_ISSUANCE_LOCK_NAMESPACE}, ${actorUserId})`,
  );
  const [actor] = await tx
    .select({
      id: usersTable.id,
      name: usersTable.name,
      role: usersTable.role,
      accountType: usersTable.accountType,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(eq(usersTable.id, actorUserId))
    .for("update");
  if (!actor?.isActive) {
    throw new SwitchboardQrGrantError(
      403,
      "actor_access_revoked",
      "Správa QR přístupu již není povolena.",
    );
  }
  if (!(USER_ROLES as readonly string[]).includes(actor.role)) {
    throw new SwitchboardQrGrantError(403, "actor_access_revoked", "Správa QR přístupu již není povolena.");
  }
  const rows = await tx
    .select({
      permission: userPermissionOverridesTable.permission,
      effect: userPermissionOverridesTable.effect,
    })
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.userId, actorUserId));
  const overrides = rows.flatMap((row) =>
    row.effect === "allow" || row.effect === "deny"
      ? [{ permission: row.permission, effect: row.effect as PermissionEffect }]
      : [],
  );
  if (!resolveAccountPermissions(
    actor.accountType as UserAccountType,
    actor.role as UserRole,
    overrides,
  ).includes("switchboards.qr.manage")) {
    throw new SwitchboardQrGrantError(
      403,
      "actor_access_revoked",
      "Správa QR přístupu již není povolena.",
    );
  }
  return { id: actor.id, name: actor.name };
}

export async function lockSwitchboardQrGrant(
  tx: Transaction,
  switchboardId: number,
) {
  // Preserve the existing (board id, lock key) ordering used by the label
  // workflow; rotate, deactivate and automatic creation now share it.
  await tx.execute(
    sql`select pg_advisory_xact_lock(${switchboardId}, ${SWITCHBOARD_QR_LOCK_KEY})`,
  );
  const [board] = await tx
    .select()
    .from(switchboardsTable)
    .where(eq(switchboardsTable.id, switchboardId))
    .for("update");
  return board ?? null;
}

export async function rotateSwitchboardQrGrant(input: {
  switchboardId: number;
  actorUserId: number;
  requestedExpiresAt?: Date | null;
}) {
  if (
    !Number.isSafeInteger(input.switchboardId) ||
    input.switchboardId <= 0 ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    throw new SwitchboardQrGrantError(409, "invalid_qr_grant_input", "Neplatný QR grant.");
  }
  const now = new Date();
  const expiresAt = resolveSwitchboardQrExpiry(input.requestedExpiresAt, now);
  const token = createQrToken();
  const encrypted = encryptQrToken(token, input.switchboardId);
  const url = publicQrUrl(token);

  const board = await db.transaction(async (tx) => {
    const actor = await lockAndAuthorizeQrActor(tx, input.actorUserId);
    const current = await lockSwitchboardQrGrant(tx, input.switchboardId);
    if (!current) {
      throw new SwitchboardQrGrantError(404, "switchboard_not_found", "Rozvaděč nebyl nalezen.");
    }
    if (current.archivedAt) {
      throw new SwitchboardQrGrantError(409, "switchboard_archived", "Archivovaný rozvaděč nemůže vydat nový QR přístup.");
    }
    const [updated] = await tx
      .update(switchboardsTable)
      .set({
        qrTokenHash: hashQrToken(token),
        qrTokenCiphertext: encrypted.ciphertext,
        qrTokenKeyId: encrypted.keyId,
        qrTokenEncryptedAt: now,
        qrTokenPrefix: token.slice(0, 8),
        qrEnabled: true,
        qrExpiresAt: expiresAt,
        qrOwnerKind: "resource",
        qrOwnerUserId: null,
        qrOwnerAssignedAt: now,
        qrOwnerAssignmentSource: "switchboard_resource",
        updatedAt: now,
      })
      .where(eq(switchboardsTable.id, current.id))
      .returning();
    await tx.insert(switchboardEventsTable).values({
      switchboardId: updated.id,
      eventType: "qr_token_rotated",
      entityType: "switchboard",
      entityId: updated.id,
      payload: {
        tokenPrefix: updated.qrTokenPrefix,
        expiresAt: expiresAt.toISOString(),
        ownerKind: "resource",
      },
      actorUserId: actor.id,
      actorName: actor.name,
    });
    return updated;
  });

  return { board, publicUrl: url };
}

export async function deactivateSwitchboardQrGrant(input: {
  switchboardId: number;
  actorUserId: number;
}) {
  if (
    !Number.isSafeInteger(input.switchboardId) ||
    input.switchboardId <= 0 ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    throw new SwitchboardQrGrantError(409, "invalid_qr_grant_input", "Neplatný QR grant.");
  }
  return db.transaction(async (tx) => {
    const actor = await lockAndAuthorizeQrActor(tx, input.actorUserId);
    const current = await lockSwitchboardQrGrant(tx, input.switchboardId);
    if (!current) {
      throw new SwitchboardQrGrantError(404, "switchboard_not_found", "Rozvaděč nebyl nalezen.");
    }
    const now = new Date();
    const [updated] = await tx
      .update(switchboardsTable)
      .set({ qrEnabled: false, updatedAt: now })
      .where(eq(switchboardsTable.id, current.id))
      .returning();
    await tx.insert(switchboardEventsTable).values({
      switchboardId: updated.id,
      eventType: "qr_token_deactivated",
      entityType: "switchboard",
      entityId: updated.id,
      payload: { tokenPrefix: updated.qrTokenPrefix },
      actorUserId: actor.id,
      actorName: actor.name,
    });
    return updated;
  });
}
