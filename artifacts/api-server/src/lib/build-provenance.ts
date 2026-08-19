declare const __SITE_LOGBOOK_BUILD_SHA__: string;

const SHA = /^[0-9a-f]{40}$/;

export function isImmutableBuildSha(value: string): boolean {
  return SHA.test(value.toLowerCase()) && !/^0{40}$/.test(value);
}

/** Build-time source identity injected by esbuild; it cannot be changed by runtime env. */
export const EMBEDDED_BUILD_SHA =
  typeof __SITE_LOGBOOK_BUILD_SHA__ === "string"
    ? __SITE_LOGBOOK_BUILD_SHA__.toLowerCase()
    : "dev";

export function requireEmbeddedProductionBuildSha(): string {
  if (!isImmutableBuildSha(EMBEDDED_BUILD_SHA)) {
    throw new Error(
      "PRODUCTION_BUILD_PROVENANCE_INVALID: the API bundle has no immutable 40-character source SHA.",
    );
  }
  return EMBEDDED_BUILD_SHA;
}

/**
 * An exact-SHA bundle is a release artifact regardless of mutable runtime env.
 * NODE_ENV may never downgrade its startup guard. A dev bundle may run only in
 * non-production mode.
 */
export function requiresReleaseStartupGuard(
  embeddedBuildSha: string = EMBEDDED_BUILD_SHA,
  runtimeNodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (isImmutableBuildSha(embeddedBuildSha)) return true;
  if (runtimeNodeEnv === "production") {
    throw new Error(
      "PRODUCTION_BUILD_PROVENANCE_INVALID: production mode requires an immutable exact-SHA API bundle.",
    );
  }
  return false;
}

export function resolveApiBuildVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.NODE_ENV === "production") {
    return requireEmbeddedProductionBuildSha();
  }
  return (
    env.BUILD_SHA ??
    env.COMMIT_SHA ??
    env.GIT_COMMIT ??
    env.REPLIT_DEPLOYMENT_ID ??
    EMBEDDED_BUILD_SHA
  );
}
