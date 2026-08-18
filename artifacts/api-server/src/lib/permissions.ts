import { eq } from "drizzle-orm";
import {
  db,
  externalAccountsTable,
  usersTable,
  userPermissionOverridesTable,
  resolveAccountPermissions,
  type Permission,
  type PermissionEffect,
  type UserRole,
  type UserAccountType,
} from "@workspace/db";
import { externalAccountsEnabled } from "./external-accounts-feature";

export async function getUserAuthorization(userId: number) {
  const rows = await db
    .select({
      user: usersTable,
      permission: userPermissionOverridesTable.permission,
      effect: userPermissionOverridesTable.effect,
    })
    .from(usersTable)
    .leftJoin(
      userPermissionOverridesTable,
      eq(userPermissionOverridesTable.userId, usersTable.id),
    )
    .where(eq(usersTable.id, userId));

  const user = rows[0]?.user;
  if (!user || !user.isActive) return null;
  const validOverrides = rows.flatMap((row) =>
    row.permission && (row.effect === "allow" || row.effect === "deny")
      ? [{ permission: row.permission, effect: row.effect as PermissionEffect }]
      : [],
  );
  let externalAccount = null;
  if (user.accountType === "external") {
    if (!externalAccountsEnabled()) return null;
    const [profile] = await db
      .select()
      .from(externalAccountsTable)
      .where(eq(externalAccountsTable.userId, user.id));
    if (
      !profile ||
      profile.status !== "active" ||
      profile.revokedAt ||
      profile.accessExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    externalAccount = profile;
  }

  return {
    user,
    externalAccount,
    overrides: validOverrides,
    permissions: resolveAccountPermissions(
      user.accountType as UserAccountType,
      user.role as UserRole,
      validOverrides,
    ),
  };
}

export async function getPermissionOverrides(userId: number) {
  const rows = await db
    .select({
      permission: userPermissionOverridesTable.permission,
      effect: userPermissionOverridesTable.effect,
    })
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.userId, userId));
  return rows.filter(
    (row): row is { permission: string; effect: PermissionEffect } =>
      row.effect === "allow" || row.effect === "deny",
  );
}

export function hasPermission(
  permissions: readonly Permission[],
  permission: Permission,
): boolean {
  return permissions.includes(permission);
}
