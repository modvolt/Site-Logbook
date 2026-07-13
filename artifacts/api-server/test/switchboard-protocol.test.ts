import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateProtocolReadiness, generateSwitchboardProtocolPdf,
  type ProtocolReadinessInput, type SwitchboardProtocolSnapshot,
} from "../src/lib/switchboard-protocol";

const readyInput: ProtocolReadinessInput = {
  hasChecklist: true,
  phaseStatuses: { assembly: "completed", inspection: "completed", measurement: "completed" },
  items: [
    { phaseKey: "assembly", itemKey: "check", title: "Kontrola dotažení", required: true, critical: true, kind: "check", result: "done", hasLinkedPhoto: false, hasPassingMeasurement: false },
    { phaseKey: "inspection", itemKey: "photo", title: "Fotografie otevřeného rozvaděče", required: true, critical: false, kind: "photo", result: "done", hasLinkedPhoto: true, hasPassingMeasurement: false },
    { phaseKey: "measurement", itemKey: "rcd", title: "Měření proudového chrániče", required: true, critical: true, kind: "measurement", result: "done", hasLinkedPhoto: false, hasPassingMeasurement: true },
  ],
  openCriticalDefects: [], labelApproved: true, qrEnabled: true, missingBoardFields: [],
};

function protocolSnapshot(): SwitchboardProtocolSnapshot {
  const items = Array.from({ length: 12 }, (_, index) => ({ key: `item_${index}`, title: `Kontrolní položka číslo ${index + 1} s podrobným technickým popisem`, required: true, critical: index < 2, kind: "check", result: "done", value: null, unit: null, passed: null, note: index % 3 === 0 ? "Ověřeno podle výrobní dokumentace." : null, justification: null, performedBy: "Václav Vichta", performedAt: "2026-07-13T10:00:00.000Z" }));
  return {
    schemaVersion: 1,
    protocol: { number: "RZ-2026-34-RH1-V01", version: 1, generatorVersion: "1.0.0", sourceFingerprint: "a".repeat(64), generatedAt: "2026-07-13T12:00:00.000Z", generatedBy: "Administrátor", overrideReason: null, overriddenBlockers: [] },
    company: { name: "Modvolt s.r.o.", ic: "12345678", dic: "CZ12345678", address: "Praha", email: "info@modvolt.cz", phone: "+420 123 456 789" },
    job: { id: 34, number: 34, title: "Hospoda Štěpán", address: "Soukenická, Praha", customerName: "Zákazník s.r.o.", customerAddress: "Praha" },
    board: { id: 1, designation: "RH1", internalName: "Hlavní rozvaděč", status: "ready_for_handover", installationLocation: "1. NP", serialNumber: "MV-2026-0034", productionDate: "2026-07-13", typeDesignation: "DBO", manufacturer: "Modvolt s.r.o.", networkSystem: "TN-C-S", ratedVoltage: "400 V", ratedFrequency: "50 Hz", ratedCurrent: "63 A", ipRating: "IP40", ikRating: "IK08", dimensions: "600 × 800 × 250 mm", weight: "35 kg", standards: ["ČSN EN 61439-1", "ČSN EN 61439-3"], notes: null, qrReference: "/q/board/AbCd1234…" },
    checklist: { instanceId: 1, templateName: "Výchozí výrobní checklist", templateVersion: 1, startedAt: "2026-07-12T08:00:00.000Z", phases: ["Sestavení a zapojení", "Kontrola před zapnutím", "Měření a dokončení"].map((title, phase) => ({ key: ["assembly", "inspection", "measurement"][phase], title, status: "completed", items })) },
    measurements: [{ id: 1, phaseKey: "measurement", type: "rcd_trip_time", subject: "FI1", value: "21", unit: "ms", result: "pass", instrument: "Metrel MI 3155 / 240601", note: null, measuredBy: "Václav Vichta", measuredAt: "2026-07-13T11:00:00.000Z" }],
    defects: [{ id: 1, phaseKey: "inspection", title: "Chyběla záslepka", description: "Volný otvor", severity: "high", critical: false, status: "closed", responsiblePerson: "Václav Vichta", dueDate: "2026-07-13", foundBy: "Václav Vichta", foundAt: "2026-07-13T09:00:00.000Z", repairDescription: "Záslepka doplněna", closedBy: "Administrátor", closedAt: "2026-07-13T09:30:00.000Z" }],
    photos: [{ id: 1, category: "completed_board", relation: "board", description: "Dokončený rozvaděč", fileName: "rh1.jpg", sha256: "b".repeat(64), author: "Václav Vichta", takenAt: "2026-07-13T11:30:00.000Z", createdAt: "2026-07-13T11:31:00.000Z" }],
    approvedLabel: { id: 1, version: 1, approvedAt: "2026-07-13T11:45:00.000Z", approvedBy: "Administrátor" },
    assignees: [{ name: "Václav Vichta", responsible: true }],
  };
}

describe("switchboard protocol readiness", () => {
  it("allows a complete board without critical blockers", () => {
    expect(evaluateProtocolReadiness(readyInput)).toEqual([]);
  });

  it("reports every safety and completeness blocker", () => {
    const blockers = evaluateProtocolReadiness({
      ...readyInput,
      hasChecklist: false,
      phaseStatuses: { assembly: "in_progress", inspection: "completed", measurement: "completed" },
      items: [
        { ...readyInput.items[0], result: "defect" },
        { ...readyInput.items[1], hasLinkedPhoto: false },
        { ...readyInput.items[2], hasPassingMeasurement: false },
        { phaseKey: "assembly", itemKey: "missing", title: "Povinný bod", required: true, critical: false, kind: "check", result: null, hasLinkedPhoto: false, hasPassingMeasurement: false },
      ],
      openCriticalDefects: [{ id: 7, title: "Odkrytá živá část" }], labelApproved: false, qrEnabled: false, missingBoardFields: ["výrobní číslo"],
    });
    expect(new Set(blockers.map((item) => item.code))).toEqual(new Set(["checklist_missing", "phase_incomplete", "critical_checklist_defect", "required_photo_missing", "required_measurement_missing", "required_item_missing", "open_critical_defect", "label_not_approved", "qr_not_active", "board_field_missing"]));
  });

  it("does not block an explicitly recorded noncritical defect", () => {
    expect(evaluateProtocolReadiness({ ...readyInput, items: [{ ...readyInput.items[0], required: true, critical: false, result: "defect" }] })).toEqual([]);
  });
});

describe("switchboard A4 protocol PDF", () => {
  it("renders a versioned multipage A4 snapshot with Czech text and signature fields", async () => {
    const snapshot = protocolSnapshot(); const before = JSON.stringify(snapshot);
    const output = await generateSwitchboardProtocolPdf(snapshot, "https://modvoltapp.cz/q/board/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789");
    if (process.env.SWITCHBOARD_PROTOCOL_PREVIEW === "1") { const directory = resolve(process.cwd(), "../../tmp/pdfs"); mkdirSync(directory, { recursive: true }); writeFileSync(resolve(directory, "switchboard-protocol-preview.pdf"), output); }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(output.subarray(0, 4).toString()).toBe("%PDF");
    expect(output.length).toBeLessThan(3 * 1024 * 1024);
    const pdf = await getDocument({ data: new Uint8Array(output) }).promise;
    expect(pdf.numPages).toBeGreaterThan(1);
    const first = await pdf.getPage(1); const viewport = first.getViewport({ scale: 1 });
    expect(viewport.width * 25.4 / 72).toBeCloseTo(210, 1); expect(viewport.height * 25.4 / 72).toBeCloseTo(297, 1);
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) { const page = await pdf.getPage(pageNumber); const content = await page.getTextContent(); texts.push(content.items.map((item) => "str" in item ? item.str : "").join(" ")); }
    const text = texts.join(" ");
    expect(text).toContain("Výrobní protokol rozvaděče"); expect(text).toContain("RZ-2026-34-RH1-V01"); expect(text).toContain("Připraven k předání"); expect(text).toContain("Výchozí výrobní checklist"); expect(text).toContain("Schválený typový štítek"); expect(text).toContain("Vypínací čas proudového chrániče"); expect(text).toContain("Zhotovil"); expect(text).toContain("Převzal / zákazník");
  });
});
