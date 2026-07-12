import type { UserRole } from "./schema/users";

export const PERMISSIONS = [
  "jobs.view",
  "jobs.manage",
  "activities.view",
  "activities.manage",
  "customers.view",
  "customers.manage",
  "people.view",
  "people.manage",
  "warehouse.view",
  "warehouse.manage",
  "machines.view",
  "machines.manage",
  "time.manage",
  "rates.cost.view",
  "rates.sale.view",
  "rates.manage",
  "credentials.view",
  "credentials.manage",
  "billing.view",
  "billing.manage",
  "billing.approve",
  "billing.settings",
  "statistics.view",
  "quotes.view",
  "quotes.manage",
  "settings.view",
  "settings.manage",
  "diagnostics.view",
  "diagnostics.manage",
  "audit.view",
  "users.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionEffect = "allow" | "deny";

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  guest: [
    "jobs.view",
    "activities.view",
    "customers.view",
    "people.view",
    "warehouse.view",
    "machines.view",
    "settings.view",
  ],
  master: [
    "jobs.view", "jobs.manage",
    "activities.view", "activities.manage",
    "customers.view", "customers.manage",
    "people.view", "people.manage",
    "warehouse.view", "warehouse.manage",
    "machines.view", "machines.manage",
    "time.manage",
    "credentials.view", "credentials.manage",
    "settings.view",
    "diagnostics.view", "diagnostics.manage",
  ],
  admin: PERMISSIONS,
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function resolvePermissions(
  role: UserRole,
  overrides: ReadonlyArray<{ permission: string; effect: PermissionEffect }>,
): Permission[] {
  const resolved = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const override of overrides) {
    if (!isPermission(override.permission)) continue;
    if (override.effect === "allow") resolved.add(override.permission);
    else resolved.delete(override.permission);
  }
  return PERMISSIONS.filter((permission) => resolved.has(permission));
}
