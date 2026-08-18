import * as path from "path";
import { readStagingReleaseEnvironment } from "../../scripts/staging-release-guard.cjs";

export const stagingEnvironment = readStagingReleaseEnvironment(process.env);
export const stagingAuthFile = path.resolve(
  __dirname,
  "..",
  "test-results",
  "staging-auth",
  "admin.json",
);
export const stagingBootstrapSummaryFile = path.resolve(
  __dirname,
  "..",
  "test-results",
  "staging-bootstrap-summary.json",
);

function requiredEvidenceValue(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new Error(`Staging evidence binding ${name} is missing or invalid.`);
  }
  return value;
}

export const stagingEvidenceBindings = Object.freeze({
  runId: Number(
    requiredEvidenceValue("STAGING_GITHUB_RUN_ID", /^[1-9][0-9]*$/),
  ),
  runAttempt: Number(
    requiredEvidenceValue("STAGING_GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/),
  ),
  imageManifestSha256: requiredEvidenceValue(
    "STAGING_IMAGE_MANIFEST_SHA256",
    /^[0-9a-f]{64}$/,
  ),
  provisioningManifestSha256: requiredEvidenceValue(
    "STAGING_PROVISIONING_MANIFEST_SHA256",
    /^[0-9a-f]{64}$/,
  ),
  deploymentInputsSha256: requiredEvidenceValue(
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    /^[0-9a-f]{64}$/,
  ),
});

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return value as Record<string, unknown>;
}
