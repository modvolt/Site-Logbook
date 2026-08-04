import { describe, expect, it } from "vitest";
import { resolveOpenAiTestBaseUrl } from "../src/lib/openai-test-base-url";

describe("R14 OpenAI test endpoint boundary", () => {
  it("keeps the production SDK endpoint when the variable is absent", () => {
    expect(
      resolveOpenAiTestBaseUrl({ NODE_ENV: "production" }),
    ).toBeUndefined();
  });

  it("accepts a credential-free HTTP endpoint only in test mode", () => {
    expect(
      resolveOpenAiTestBaseUrl({
        NODE_ENV: "test",
        OPENAI_TEST_BASE_URL: "http://provider-fakes:4010/v1/",
      }),
    ).toBe("http://provider-fakes:4010/v1");
  });

  it("fails closed outside test mode", () => {
    expect(() =>
      resolveOpenAiTestBaseUrl({
        NODE_ENV: "production",
        OPENAI_TEST_BASE_URL: "http://provider-fakes:4010/v1",
      }),
    ).toThrow(/only when NODE_ENV=test/);
  });

  it.each([
    "ftp://provider-fakes/v1",
    "http://user:secret@provider-fakes/v1",
    "http://provider-fakes/v1?token=secret",
    "http://provider-fakes/v1#fragment",
    "not-a-url",
  ])("rejects unsafe or malformed value %s", (value) => {
    expect(() =>
      resolveOpenAiTestBaseUrl({
        NODE_ENV: "test",
        OPENAI_TEST_BASE_URL: value,
      }),
    ).toThrow();
  });
});
