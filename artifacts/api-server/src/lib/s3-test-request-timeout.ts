/**
 * The isolated R14 fault gate must not inherit the AWS SDK's long production
 * retry window when its disposable S3 network is deliberately disconnected.
 * This override is test-only and fails closed if it is injected elsewhere.
 */
export function resolveS3TestRequestTimeout(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.S3_TEST_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  if (env.NODE_ENV !== "test") {
    throw new Error(
      "S3_TEST_REQUEST_TIMEOUT_MS is permitted only when NODE_ENV=test.",
    );
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("S3_TEST_REQUEST_TIMEOUT_MS must be an integer.");
  }
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error(
      "S3_TEST_REQUEST_TIMEOUT_MS must be between 100 and 30000 milliseconds.",
    );
  }
  return timeoutMs;
}
