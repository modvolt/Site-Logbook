import { describe, expect, it } from "vitest";
import { createOfflineIdentityScope } from "../src/lib/offline-identity";

const base = {
  userId: 7,
  sessionGeneration: 3,
  role: "guest" as const,
  permissions: ["jobs.view", "jobs.work"] as const,
};

describe("offline identity scope", () => {
  it("is stable across permission ordering and has no embedded identifiers", () => {
    const first = createOfflineIdentityScope(base);
    const reordered = createOfflineIdentityScope({
      ...base,
      permissions: ["jobs.work", "jobs.view"],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    expect(first).not.toBe(String(base.userId));
  });

  it.each([
    ["user", { ...base, userId: 8 }],
    ["session generation", { ...base, sessionGeneration: 4 }],
    ["role", { ...base, role: "admin" as const }],
    ["permissions", { ...base, permissions: ["jobs.view"] as const }],
  ])("rotates after a %s boundary change", (_boundary, changed) => {
    expect(createOfflineIdentityScope(changed)).not.toBe(
      createOfflineIdentityScope(base),
    );
  });
});
