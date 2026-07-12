import { describe, expect, it } from "vitest";
import {
  calculateSessionDurationSeconds,
  hoursToSeconds,
  secondsToRoundedHours,
  reviewThresholdSeconds,
} from "../src/lib/work-session-math";

describe("work session time math", () => {
  it("stores exact seconds and subtracts breaks", () => {
    const start = new Date("2042-02-03T08:00:00.000Z");
    const end = new Date("2042-02-03T11:00:00.000Z");
    expect(calculateSessionDurationSeconds(start, end, 30 * 60)).toBe(9_000);
  });

  it("never creates a negative timer duration", () => {
    const start = new Date("2042-02-03T11:00:00.000Z");
    const end = new Date("2042-02-03T10:00:00.000Z");
    expect(calculateSessionDurationSeconds(start, end)).toBe(0);
    expect(calculateSessionDurationSeconds(end, start, 7_200)).toBe(0);
  });

  it("rounds only the compatibility hour projection", () => {
    expect(secondsToRoundedHours(10_799)).toBe(3);
    expect(hoursToSeconds(2.25)).toBe(8_100);
  });

  it("uses a configurable review threshold with a 12-hour default", () => {
    const previous = process.env.WORK_SESSION_REVIEW_HOURS;
    try {
      delete process.env.WORK_SESSION_REVIEW_HOURS;
      expect(reviewThresholdSeconds()).toBe(43_200);
      process.env.WORK_SESSION_REVIEW_HOURS = "1.5";
      expect(reviewThresholdSeconds()).toBe(5_400);
    } finally {
      if (previous === undefined) delete process.env.WORK_SESSION_REVIEW_HOURS;
      else process.env.WORK_SESSION_REVIEW_HOURS = previous;
    }
  });
});
