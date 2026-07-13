import { describe, expect, it } from "vitest";
import {
  isPlausibleMeasurementTime,
  normalizeOptionalText,
  summarizeLatestMeasurements,
} from "../src/lib/switchboard-operation-rules";

const at = (value: string) => new Date(value);

describe("switchboard operation rules", () => {
  it("uses the latest retest for one measured subject", () => {
    const summary = summarizeLatestMeasurements([
      { id: 1, measurementType: "rcd_trip_time", subjectLabel: "FI1", result: "fail", measuredAt: at("2026-07-13T08:00:00Z") },
      { id: 2, measurementType: "rcd_trip_time", subjectLabel: "FI1", result: "pass", measuredAt: at("2026-07-13T08:10:00Z") },
    ]);
    expect(summary.totalSeries).toBe(1);
    expect(summary.failedSeries).toBe(0);
    expect(summary.passed).toBe(true);
    expect(summary.current[0]?.id).toBe(2);
  });

  it("keeps multiple RCD devices separate and fails if one latest result fails", () => {
    const summary = summarizeLatestMeasurements([
      { id: 1, measurementType: "rcd_trip_time", subjectLabel: "FI1", result: "pass", measuredAt: at("2026-07-13T08:00:00Z") },
      { id: 2, measurementType: "rcd_trip_time", subjectLabel: "fi2", result: "fail", measuredAt: at("2026-07-13T08:01:00Z") },
      { id: 3, measurementType: "rcd_trip_time", subjectLabel: " FI1 ", result: "fail", measuredAt: at("2026-07-13T07:00:00Z") },
    ]);
    expect(summary.totalSeries).toBe(2);
    expect(summary.failedSeries).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it("breaks equal-time retest ties with the append-only row id", () => {
    const timestamp = at("2026-07-13T08:00:00Z");
    const summary = summarizeLatestMeasurements([
      { id: 8, measurementType: "voltage", subjectLabel: null, result: "fail", measuredAt: timestamp },
      { id: 9, measurementType: "voltage", subjectLabel: null, result: "pass", measuredAt: timestamp },
    ]);
    expect(summary.passed).toBe(true);
    expect(summary.current[0]?.id).toBe(9);
  });

  it("rejects invalid, very old, and excessively future timestamps", () => {
    const now = at("2026-07-13T12:00:00Z");
    expect(isPlausibleMeasurementTime(at("2026-07-13T12:04:59Z"), now)).toBe(true);
    expect(isPlausibleMeasurementTime(at("2026-07-13T12:05:01Z"), now)).toBe(false);
    expect(isPlausibleMeasurementTime(at("1999-12-31T23:59:59Z"), now)).toBe(false);
    expect(isPlausibleMeasurementTime(new Date("invalid"), now)).toBe(false);
  });

  it("normalizes optional notes without storing whitespace", () => {
    expect(normalizeOptionalText("  opraveno  ")).toBe("opraveno");
    expect(normalizeOptionalText("   ")).toBeNull();
    expect(normalizeOptionalText(undefined)).toBeNull();
  });
});
