import { describe, expect, it } from "vitest";
import { resolveS3TestRequestTimeout } from "../src/lib/s3-test-request-timeout";

describe("R14 S3 request timeout boundary", () => {
  it("keeps production SDK timing when the variable is absent", () => {
    expect(
      resolveS3TestRequestTimeout({ NODE_ENV: "production" }),
    ).toBeUndefined();
  });

  it("accepts a bounded timeout only in test mode", () => {
    expect(
      resolveS3TestRequestTimeout({
        NODE_ENV: "test",
        S3_TEST_REQUEST_TIMEOUT_MS: "5000",
      }),
    ).toBe(5000);
  });

  it("fails closed outside test mode", () => {
    expect(() =>
      resolveS3TestRequestTimeout({
        NODE_ENV: "production",
        S3_TEST_REQUEST_TIMEOUT_MS: "5000",
      }),
    ).toThrow(/only when NODE_ENV=test/);
  });

  it.each(["0", "99", "30001", "1.5", "-1", "text"])(
    "rejects unsafe or malformed value %s",
    (value) => {
      expect(() =>
        resolveS3TestRequestTimeout({
          NODE_ENV: "test",
          S3_TEST_REQUEST_TIMEOUT_MS: value,
        }),
      ).toThrow();
    },
  );
});
