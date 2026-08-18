import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(
  resolve(root, "artifacts/stavba/src/pages/billing-document-detail.tsx"),
  "utf8",
);

describe("billing document action sequencing contract", () => {
  it("awaits all line saves instead of racing document status changes", () => {
    const start = source.indexOf("const saveAllLines = async");
    const end = source.indexOf("const runDocumentAction", start);
    const saveAllLines = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(saveAllLines).toContain("await Promise.all(");
    expect(saveAllLines).toContain("cardRef.save({ silent: true })");
    expect(source).not.toContain("lineCardsRef.current.forEach");
    expect(source).toContain("await updateLine.mutateAsync");
    expect(source).toMatch(
      /export interface LineCardRef \{[\s\S]*\) => Promise<void>;/,
    );
  });

  it("does not send unchanged lines again for review and approval", () => {
    expect(source).toContain("const lastSavedFormRef = useRef(form)");
    expect(source).toContain("if (isUnchanged) return");
    expect(source).toContain("lastSavedFormRef.current = f");
  });

  it("keeps line review focused on corrections and one final document approval", () => {
    const lineCardStart = source.indexOf("const LineCard =");
    const lineCardEnd = source.indexOf("interface SplitPart", lineCardStart);
    const lineCard = source.slice(lineCardStart, lineCardEnd);

    expect(source).not.toContain("handleApproveAll");
    expect(source).not.toContain("Schválit vše");
    expect(lineCard).not.toContain("Přiřazení ke zakázce je správně");
    expect(lineCard).not.toContain("Nastavení položky je správně");
    expect(lineCard).not.toContain("matchConfirmed:");
    expect(lineCard).not.toContain("checked={form.approved}");
    expect(lineCard).not.toContain("approved: f.approved");
    expect(lineCard).toContain("documentActionPending || updateLine.isPending");
  });

  it("saves current line forms only as part of final approval", () => {
    const statusStart = source.indexOf("const handleStatus =");
    const statusEnd = source.indexOf("const handleApprove =", statusStart);
    const approveEnd = source.indexOf("const handleMarkDuplicate =", statusEnd);
    const statusHandler = source.slice(statusStart, statusEnd);
    const approveHandler = source.slice(statusEnd, approveEnd);

    expect(statusHandler).not.toContain('status === "reviewed"');
    expect(statusHandler).not.toContain("await saveAllLines()");
    expect(approveHandler).toMatch(
      /await saveAllLines\(\)[\s\S]*await approveDoc\.mutateAsync/,
    );
    expect(source).not.toContain("> Zkontrolováno");
    expect(source).toContain(
      "const [isDocumentActionPending, setIsDocumentActionPending]",
    );
    expect(source).toContain("if (documentActionLockRef.current)");
  });

  it("separates reopening an approved document from ignoring it", () => {
    expect(source).toContain("const handleReturnToReview =");
    expect(source).toContain("const submitReturnToReview =");
    expect(source).toMatch(
      /submitReturnToReview[\s\S]*buildReturnCostDocumentToReviewInput\(returnToReviewReason\)[\s\S]*setStatus\.mutateAsync\(\{ id, data \}\)/,
    );
    expect(source).toContain(
      "<DialogTitle>Vrátit doklad ke kontrole</DialogTitle>",
    );
    expect(source).toContain(">Důvod opravy</Label>");
    expect(source).toContain("minLength={3}");
    expect(source).toContain(
      "maxLength={COST_DOCUMENT_CORRECTION_REASON_MAX_LENGTH}",
    );
    expect(source).toContain('{doc.status === "approved" && (');
    expect(source).toContain("Vrátit ke kontrole");
    expect(source).toContain(
      '{doc.status !== "ignored" && doc.status !== "approved" && (',
    );
  });
});
