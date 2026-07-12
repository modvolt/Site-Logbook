import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  userPermissionOverridesTable,
  resolvePermissions,
  type Permission,
  type PermissionEffect,
  type UserRole,
} from "@workspace/db";

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
  return {
    user,
    overrides: validOverrides,
    permissions: resolvePermissions(user.role as UserRole, validOverrides),
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
