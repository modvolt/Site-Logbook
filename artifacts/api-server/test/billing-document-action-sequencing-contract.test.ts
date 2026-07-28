import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(
  resolve(root, "artifacts/stavba/src/pages/billing-document-detail.tsx"),
  "utf8",
);

describe("billing document action sequencing contract", () => {
  it("awaits line saves sequentially instead of racing document reconciliation", () => {
    const start = source.indexOf("const saveAllLines = async");
    const end = source.indexOf("const runDocumentAction", start);
    const saveAllLines = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(saveAllLines).toContain(
      "for (const cardRef of lineCardsRef.current.values())",
    );
    expect(saveAllLines).toContain(
      "await cardRef.save(overrides, { silent: true })",
    );
    expect(source).not.toContain("lineCardsRef.current.forEach");
    expect(source).toContain("await updateLine.mutateAsync");
    expect(source).toMatch(
      /export interface LineCardRef \{[\s\S]*\) => Promise<void>;/,
    );
  });

  it("saves current line forms before review and final approval", () => {
    const statusStart = source.indexOf("const handleStatus =");
    const statusEnd = source.indexOf("const handleApprove =", statusStart);
    const approveEnd = source.indexOf(
      "const handleMarkDuplicate =",
      statusEnd,
    );
    const statusHandler = source.slice(statusStart, statusEnd);
    const approveHandler = source.slice(statusEnd, approveEnd);

    expect(statusHandler).toMatch(
      /status === "reviewed"[\s\S]*await saveAllLines\(\)[\s\S]*await setStatus\.mutateAsync/,
    );
    expect(approveHandler).toMatch(
      /await saveAllLines\(\)[\s\S]*await approveDoc\.mutateAsync/,
    );
    expect(source).toContain(
      "const [isDocumentActionPending, setIsDocumentActionPending]",
    );
    expect(source).toContain("if (documentActionLockRef.current)");
  });
});
