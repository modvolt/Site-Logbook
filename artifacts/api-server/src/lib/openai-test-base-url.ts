/**
 * R14's hermetic full-stack gate exercises the real OpenAI client against an
 * in-network deterministic fake. A custom endpoint is intentionally accepted
 * only in NODE_ENV=test: production keeps using the SDK default and fails
 * closed if this test-only variable is ever injected by mistake.
 */
export function resolveOpenAiTestBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.OPENAI_TEST_BASE_URL?.trim();
  if (!raw) return undefined;
  if (env.NODE_ENV !== "test") {
    throw new Error(
      "OPENAI_TEST_BASE_URL is permitted only when NODE_ENV=test.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OPENAI_TEST_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("OPENAI_TEST_BASE_URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "OPENAI_TEST_BASE_URL must not contain credentials, a query, or a fragment.",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}
