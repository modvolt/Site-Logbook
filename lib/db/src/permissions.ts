import type { UserRole } from "./schema/users";

export const PERMISSIONS = [
  "jobs.view",
  "jobs.work",
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
  "switchboards.view",
  "switchboards.create",
  "switchboards.update",
  "switchboards.archive",
  "switchboards.documents.upload",
  "switchboards.documents.view",
  "switchboards.checklist.fill",
  "switchboards.checklist.edit_own",
  "switchboards.checklist.edit_all",
  "switchboards.measurements.create",
  "switchboards.photos.create",
  "switchboards.defects.create",
  "switchboards.defects.close",
  "switchboards.extraction.review",
  "switchboards.extraction.correct",
  "switchboards.labels.approve",
  "switchboards.labels.generate",
  "switchboards.phases.complete",
  "switchboards.protocol.complete",
  "switchboards.protocol.override",
  "switchboards.templates.manage",
  "switchboards.parser.manage",
  "switchboards.qr.manage",
  "switchboards.documents.publish",
  "switchboards.audit.view",
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
    "switchboards.view",
  ],
  master: [
    "jobs.view", "jobs.work", "jobs.manage",
    "activities.view", "activities.manage",
    "customers.view", "customers.manage",
    "people.view", "people.manage",
    "warehouse.view", "warehouse.manage",
    "machines.view", "machines.manage",
    "time.manage",
    "credentials.view", "credentials.manage",
    "settings.view",
    "diagnostics.view", "diagnostics.manage",
    "switchboards.view", "switchboards.create", "switchboards.update",
    "switchboards.documents.upload", "switchboards.documents.view",
    "switchboards.checklist.fill", "switchboards.checklist.edit_own",
    "switchboards.measurements.create", "switchboards.photos.create",
    "switchboards.defects.create", "switchboards.defects.close",
    "switchboards.extraction.review", "switchboards.labels.generate",
    "switchboards.phases.complete", "switchboards.protocol.complete",
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
