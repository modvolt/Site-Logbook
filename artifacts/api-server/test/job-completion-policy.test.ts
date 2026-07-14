import { describe, expect, it } from "vitest";
import { evaluateJobCompletion, type CompletionPolicyInput } from "../src/lib/job-completion-policy";

const readyJob: CompletionPolicyInput = {
  customerId: 12,
  activeSessionCount: 0,
  unfinishedTaskCount: 0,
  plannedMaterialCount: 0,
  hoursSpent: 3.5,
  pricingMode: "hourly",
};

describe("job completion policy", () => {
  it("blocks completion without a customer or while any worker timer is active", () => {
    const result = evaluateJobCompletion({
      ...readyJob,
      customerId: null,
      activeSessionCount: 2,
    });

    expect(result.blockers.map((issue) => issue.code)).toEqual([
      "missing_customer",
      "active_work_sessions",
    ]);
    expect(result.blockers[1].count).toBe(2);
  });

  it("reports unfinished work as explicit warnings", () => {
    const result = evaluateJobCompletion({
      ...readyJob,
      unfinishedTaskCount: 3,
      plannedMaterialCount: 4,
      hoursSpent: 0,
    });

    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual([
      "unfinished_tasks",
      "planned_materials",
      "missing_work_time",
    ]);
  });

  it("does not require measured time for a fixed-price job", () => {
    const result = evaluateJobCompletion({
      ...readyJob,
      pricingMode: "fixed_price",
      hoursSpent: 0,
    });

    expect(result.warnings).toEqual([]);
  });

  it("allows a complete and internally consistent job", () => {
    expect(evaluateJobCompletion(readyJob)).toEqual({ blockers: [], warnings: [] });
  });
});
