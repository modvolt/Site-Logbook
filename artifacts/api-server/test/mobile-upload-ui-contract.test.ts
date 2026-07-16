import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("mobile upload and overlay UI contract", () => {
  it("restores scroll and focus after the native file picker returns", () => {
    const source = read("artifacts/stavba/src/lib/file-picker.ts");

    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('input.addEventListener("cancel"');
    expect(source).toContain("window.scrollTo(left, top)");
    expect(source).toContain("focus({ preventScroll: true })");
  });

  it("uses the stable picker on every button-driven upload surface", () => {
    const files = [
      "artifacts/stavba/src/components/file-drop-zone.tsx",
      "artifacts/stavba/src/components/customer-csv-import.tsx",
      "artifacts/stavba/src/components/warehouse-csv-import.tsx",
      "artifacts/stavba/src/components/switchboard-documents.tsx",
      "artifacts/stavba/src/pages/activity-detail.tsx",
      "artifacts/stavba/src/pages/billing-bank-import.tsx",
      "artifacts/stavba/src/pages/billing-documents.tsx",
      "artifacts/stavba/src/pages/job-detail.tsx",
      "artifacts/stavba/src/pages/settings.tsx",
      "artifacts/stavba/src/pages/site-detail.tsx",
    ];

    for (const file of files) {
      const source = read(file);
      expect(source, file).toContain("openFilePicker(");
      expect(source, file).not.toMatch(/\.current\?\.click\(\)/);
    }
  });

  it("keeps dialogs and drawers inside the dynamic mobile viewport", () => {
    const dialog = read("artifacts/stavba/src/components/ui/dialog.tsx");
    const alertDialog = read("artifacts/stavba/src/components/ui/alert-dialog.tsx");
    const drawer = read("artifacts/stavba/src/components/ui/drawer.tsx");

    for (const source of [dialog, alertDialog]) {
      expect(source).toContain("max-h-[calc(100dvh-1.5rem)]");
      expect(source).toContain("w-[calc(100%-1.5rem)]");
      expect(source).toContain("overflow-y-auto");
      expect(source).toContain("overscroll-contain");
    }
    expect(dialog).toContain("h-11 w-11");
    expect(drawer).toContain("max-h-[calc(100dvh-1rem)]");
    expect(drawer).toContain("safe-area-inset-bottom");
  });

  it("stacks long billing document actions within the mobile width", () => {
    const source = read("artifacts/stavba/src/pages/billing-documents.tsx");

    expect(source).toContain("grid w-full grid-cols-1 gap-2");
    expect(source).toContain("w-full whitespace-normal sm:w-auto");
    expect(source).toContain("min-w-0 flex-1");
  });
});
