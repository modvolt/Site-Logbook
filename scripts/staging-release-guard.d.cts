export interface StagingReleaseEnvironment {
  readonly environmentId: string;
  readonly baseURL: string;
  readonly expectedBuildSha: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
}

export class StagingReleaseGuardError extends Error {
  readonly code: string;
}

export function readStagingReleaseEnvironment(
  env?: NodeJS.ProcessEnv,
): StagingReleaseEnvironment;

export function safeStagingReleaseSummary(
  config: StagingReleaseEnvironment,
): Record<string, string | number | boolean>;
