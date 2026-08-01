export const DB_BACKED_PRIVATE_OBJECT_PREFIXES = [
  "cost-documents",
  "customer-documents",
  "job-sheets",
  "job-signatures",
  "ppe-signatures",
  "quotes",
  "uploads",
] as const;

export const TYPED_ONLY_PRIVATE_OBJECT_PREFIXES = [
  "backups",
  "invoices",
  "ppe-handovers",
  "switchboards",
] as const;

export type DbBackedPrivateObjectPrefix =
  (typeof DB_BACKED_PRIVATE_OBJECT_PREFIXES)[number];

export type PrivateObjectPathClassification =
  | { kind: "db-backed"; prefix: DbBackedPrivateObjectPrefix }
  | { kind: "typed-only" }
  | { kind: "unknown" };

const dbBackedPrefixes = new Set<string>(DB_BACKED_PRIVATE_OBJECT_PREFIXES);
const typedOnlyPrefixes = new Set<string>(TYPED_ONLY_PRIVATE_OBJECT_PREFIXES);

/**
 * Classifies an exact private object path. Invalid, traversal-like, empty and
 * unrecognised paths are deliberately indistinguishable from unknown objects.
 */
export function classifyPrivateObjectPath(
  objectPath: string,
): PrivateObjectPathClassification {
  if (!objectPath.startsWith("/objects/")) return { kind: "unknown" };

  const relativePath = objectPath.slice("/objects/".length);
  const segments = relativePath.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    relativePath.includes("\\")
  ) {
    return { kind: "unknown" };
  }

  const prefix = segments[0];
  if (dbBackedPrefixes.has(prefix)) {
    return { kind: "db-backed", prefix: prefix as DbBackedPrivateObjectPrefix };
  }
  if (typedOnlyPrefixes.has(prefix)) return { kind: "typed-only" };
  return { kind: "unknown" };
}
