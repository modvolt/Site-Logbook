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

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return value as Record<string, unknown>;
}
