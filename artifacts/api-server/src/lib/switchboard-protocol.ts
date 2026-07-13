import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";
import modvoltLogo from "../../../../attached_assets/Color_logo_-_no_background_1780171783567.png";

export const SWITCHBOARD_PROTOCOL_GENERATOR_VERSION = "1.0.0";
const PDF_FONT = "Roboto";
const PHASE_LABELS: Record<string, string> = { assembly: "Sestavení a zapojení", inspection: "Kontrola před zapnutím", measurement: "Měření a dokončení" };
const STATUS_LABELS: Record<string, string> = { not_started: "Nezahájeno", in_progress: "Rozpracováno", completed: "Dokončeno", open: "Otevřená", in_repair: "Probíhá oprava", closed: "Uzavřená" };
const MEASUREMENT_LABELS: Record<string, string> = { protective_continuity: "Spojitost ochranného obvodu", insulation_resistance: "Izolační odpor", rcd_trip_time: "Vypínací čas proudového chrániče", rcd_trip_current: "Vybavovací proud chrániče", phase_sequence: "Sled fází", loop_impedance: "Impedance smyčky", voltage: "Napětí", other: "Jiné měření" };
const PHOTO_LABELS: Record<string, string> = { open_board: "Otevřený rozvaděč", completed_board: "Dokončený rozvaděč", type_label: "Typový štítek", qr_code: "QR kód", defect_detail: "Detail závady", repair_state: "Stav po opravě", measurement: "Měření", other: "Ostatní" };
const SEVERITY_LABELS: Record<string, string> = { low: "Nízká", medium: "Střední", high: "Vysoká", critical: "Kritická" };
const BOARD_STATUS_LABELS: Record<string, string> = { created: "Založen", documentation_uploaded: "Dokumentace nahrána", assembly: "Probíhá sestavení", wiring: "Probíhá zapojení", awaiting_inspection: "Čeká na kontrolu", inspection: "Probíhá kontrola", awaiting_measurement: "Čeká na měření", measurement: "Probíhá měření", defects_found: "Zjištěny závady", defects_resolved: "Závady odstraněny", protocol_completed: "Protokol dokončen", ready_for_handover: "Připraven k předání", handed_over: "Předán", service: "Servisní režim", archived: "Archivován" };

export type ProtocolBlocker = {
  code: string;
  message: string;
  phaseKey?: string;
  itemKey?: string;
};

export type ProtocolReadinessInput = {
  hasChecklist: boolean;
  phaseStatuses: Record<string, string>;
  items: Array<{
    phaseKey: string;
    itemKey: string;
    title: string;
    required: boolean;
    critical: boolean;
    kind: "check" | "measurement" | "photo";
    result: string | null;
    hasLinkedPhoto: boolean;
    hasPassingMeasurement: boolean;
  }>;
  openCriticalDefects: Array<{ id: number; title: string }>;
  labelApproved: boolean;
  qrEnabled: boolean;
  missingBoardFields: string[];
};

export function evaluateProtocolReadiness(input: ProtocolReadinessInput): ProtocolBlocker[] {
  const blockers: ProtocolBlocker[] = [];
  if (!input.hasChecklist) blockers.push({ code: "checklist_missing", message: "Rozvaděč nemá založený průběžný protokol." });
  for (const [phaseKey, status] of Object.entries(input.phaseStatuses)) {
    if (status !== "completed") blockers.push({ code: "phase_incomplete", phaseKey, message: `Pracovní fáze „${PHASE_LABELS[phaseKey] ?? phaseKey}“ není dokončena.` });
  }
  for (const item of input.items) {
    if (item.required && !item.result) blockers.push({ code: "required_item_missing", phaseKey: item.phaseKey, itemKey: item.itemKey, message: `Chybí povinná položka: ${item.title}` });
    if (item.critical && item.result === "defect") blockers.push({ code: "critical_checklist_defect", phaseKey: item.phaseKey, itemKey: item.itemKey, message: `Kritická položka je vedena jako závada: ${item.title}` });
    if (item.required && item.kind === "photo" && (item.result !== "done" || !item.hasLinkedPhoto)) blockers.push({ code: "required_photo_missing", phaseKey: item.phaseKey, itemKey: item.itemKey, message: `Chybí povinná fotografie: ${item.title}` });
    if (item.required && item.kind === "measurement" && (item.result !== "done" || !item.hasPassingMeasurement)) blockers.push({ code: "required_measurement_missing", phaseKey: item.phaseKey, itemKey: item.itemKey, message: `Chybí vyhovující povinné měření: ${item.title}` });
  }
  for (const defect of input.openCriticalDefects) blockers.push({ code: "open_critical_defect", message: `Otevřená kritická závada: ${defect.title}` });
  if (!input.labelApproved) blockers.push({ code: "label_not_approved", message: "Aktuální typový štítek není schválen." });
  if (!input.qrEnabled) blockers.push({ code: "qr_not_active", message: "QR přístup rozvaděče není aktivní." });
  for (const field of input.missingBoardFields) blockers.push({ code: "board_field_missing", message: `Chybí identifikační údaj rozvaděče: ${field}` });
  const unique = new Map<string, ProtocolBlocker>();
  for (const blocker of blockers) unique.set(`${blocker.code}\u0000${blocker.phaseKey ?? ""}\u0000${blocker.itemKey ?? ""}\u0000${blocker.message}`, blocker);
  return [...unique.values()];
}

export type SwitchboardProtocolSnapshot = {
  schemaVersion: 1;
  protocol: { number: string; version: number; generatorVersion: string; sourceFingerprint: string; generatedAt: string; generatedBy: string; overrideReason: string | null; overriddenBlockers: ProtocolBlocker[] };
  company: { name: string; ic: string | null; dic: string | null; address: string | null; email: string | null; phone: string | null };
  job: { id: number; number: number | null; title: string; address: string | null; customerName: string | null; customerAddress: string | null };
  board: { id: number; designation: string; internalName: string; status: string; installationLocation: string | null; serialNumber: string | null; productionDate: string | null; typeDesignation: string | null; manufacturer: string; networkSystem: string | null; ratedVoltage: string | null; ratedFrequency: string | null; ratedCurrent: string | null; ipRating: string | null; ikRating: string | null; dimensions: string | null; weight: string | null; standards: string[]; notes: string | null; qrReference: string | null };
  checklist: { instanceId: number | null; templateName: string | null; templateVersion: number | null; startedAt: string | null; phases: Array<{ key: string; title: string; status: string; items: Array<{ key: string; title: string; required: boolean; critical: boolean; kind: string; result: string | null; value: string | null; unit: string | null; passed: boolean | null; note: string | null; justification: string | null; performedBy: string | null; performedAt: string | null }> }> };
  measurements: Array<{ id: number; phaseKey: string | null; type: string; subject: string | null; value: string | null; unit: string; result: string; instrument: string | null; note: string | null; measuredBy: string | null; measuredAt: string }>;
  defects: Array<{ id: number; phaseKey: string | null; title: string; description: string | null; severity: string; critical: boolean; status: string; responsiblePerson: string | null; dueDate: string | null; foundBy: string | null; foundAt: string; repairDescription: string | null; closedBy: string | null; closedAt: string | null }>;
  photos: Array<{ id: number; category: string; relation: string | null; description: string | null; fileName: string; sha256: string; author: string | null; takenAt: string | null; createdAt: string }>;
  approvedLabel: { id: number; version: number; approvedAt: string | null; approvedBy: string | null } | null;
  assignees: Array<{ name: string; responsible: boolean }>;
};

function registerFonts(doc: jsPDF) {
  doc.addFileToVFS("Roboto-Regular.ttf", robotoRegular); doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", robotoBold); doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
  doc.setFont(PDF_FONT, "normal");
}

const display = (value: string | number | null | undefined) => value == null || String(value).trim() === "" ? "—" : String(value);
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("cs-CZ") : "—";
const resultLabel = (value: string | null) => value === "done" ? "Hotovo" : value === "defect" ? "Závada" : value === "not_applicable" ? "Netýká se" : "Nevyplněno";
const measurementResult = (value: string) => value === "pass" ? "Vyhovuje" : "Nevyhovuje";

export async function generateSwitchboardProtocolPdf(snapshot: SwitchboardProtocolSnapshot, qrUrl: string | null): Promise<Buffer> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);
  const margin = 14; const width = 182; let y = 13;
  const heading = (title: string) => {
    if (y > 265) { doc.addPage(); y = 15; }
    doc.setFont(PDF_FONT, "bold"); doc.setFontSize(12); doc.setTextColor(15, 98, 113); doc.text(title, margin, y); doc.setTextColor(0, 0, 0); y += 4;
  };
  const table = (rows: Array<Array<string>>, headers?: string[]) => {
    autoTable(doc, { startY: y, margin: { left: margin, right: margin }, head: headers ? [headers] : [], body: rows, theme: "grid", styles: { font: PDF_FONT, fontSize: 7.5, cellPadding: 1.5, overflow: "linebreak" }, headStyles: { font: PDF_FONT, fontStyle: "bold", fillColor: [15, 98, 113], textColor: 255 }, columnStyles: headers ? {} : { 0: { fontStyle: "bold", cellWidth: 48 } } });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  };

  try {
    const sourceLogo = await loadImage(modvoltLogo); const logoWidth = 520; const logoHeight = Math.max(1, Math.round(logoWidth * sourceLogo.height / sourceLogo.width));
    const logoCanvas = createCanvas(logoWidth, logoHeight); logoCanvas.getContext("2d").drawImage(sourceLogo, 0, 0, logoWidth, logoHeight);
    doc.addImage(`data:image/png;base64,${logoCanvas.toBuffer("image/png").toString("base64")}`, "PNG", margin, y, 45, 14);
  } catch { doc.setFont(PDF_FONT, "bold"); doc.setFontSize(18); doc.text("MODVOLT", margin, y + 8); }
  doc.setFont(PDF_FONT, "bold"); doc.setFontSize(18); doc.text("Výrobní protokol rozvaděče", 65, y + 7);
  doc.setFont(PDF_FONT, "normal"); doc.setFontSize(8); doc.text(`${snapshot.protocol.number} · verze ${snapshot.protocol.version}`, 65, y + 13);
  doc.setFontSize(7); doc.text([snapshot.company.name, snapshot.company.ic ? `IČ ${snapshot.company.ic}` : null, snapshot.company.dic ? `DIČ ${snapshot.company.dic}` : null].filter(Boolean).join(" · "), 65, y + 18, { maxWidth: 100 });
  doc.text([snapshot.company.address, snapshot.company.email, snapshot.company.phone].filter(Boolean).join(" · "), 65, y + 22, { maxWidth: 100 });
  if (qrUrl) { try { const qr = await QRCode.toDataURL(qrUrl, { width: 240, margin: 1, errorCorrectionLevel: "M" }); doc.addImage(qr, "PNG", 174, y, 22, 22); } catch { /* PDF remains usable and the snapshot records the QR reference. */ } }
  y += 27;

  heading("Identifikace zakázky a rozvaděče");
  table([
    ["Zakázka", `#${display(snapshot.job.number ?? snapshot.job.id)} · ${snapshot.job.title}`], ["Zákazník", display(snapshot.job.customerName)], ["Adresa zakázky", display(snapshot.job.address)],
    ["Označení / interní název", `${snapshot.board.designation} / ${snapshot.board.internalName}`], ["Stav při vytvoření", BOARD_STATUS_LABELS[snapshot.board.status] ?? display(snapshot.board.status)], ["Místo instalace", display(snapshot.board.installationLocation)], ["Výrobní číslo", display(snapshot.board.serialNumber)], ["Datum výroby", display(snapshot.board.productionDate)],
    ["Checklistová šablona", `${display(snapshot.checklist.templateName)} · verze ${display(snapshot.checklist.templateVersion)}`], ["Schválený typový štítek", snapshot.approvedLabel ? `Verze ${snapshot.approvedLabel.version} · ${dateTime(snapshot.approvedLabel.approvedAt)}` : "—"], ["Odpovědní pracovníci", snapshot.assignees.filter((item) => item.responsible).map((item) => item.name).join(", ") || "—"],
  ]);
  heading("Typové a elektrické údaje");
  table([
    ["Typ / výrobce", `${display(snapshot.board.typeDesignation)} / ${snapshot.board.manufacturer}`], ["Soustava", display(snapshot.board.networkSystem)], ["Napětí / frekvence", `${display(snapshot.board.ratedVoltage)} / ${display(snapshot.board.ratedFrequency)}`], ["Jmenovitý proud", display(snapshot.board.ratedCurrent)], ["Krytí", `${display(snapshot.board.ipRating)} / ${display(snapshot.board.ikRating)}`], ["Rozměry / hmotnost", `${display(snapshot.board.dimensions)} / ${display(snapshot.board.weight)}`], ["Normy", snapshot.board.standards.length ? snapshot.board.standards.join(", ") : "—"], ["QR dokumentace", display(snapshot.board.qrReference)],
  ]);

  for (const phase of snapshot.checklist.phases) {
    heading(`${phase.title} · ${STATUS_LABELS[phase.status] ?? phase.status}`);
    table(phase.items.map((item) => [resultLabel(item.result), item.title, [item.value, item.unit].filter(Boolean).join(" ") || "—", item.performedBy ?? "—", dateTime(item.performedAt), item.note ?? item.justification ?? ""]), ["Výsledek", "Kontrolní bod", "Hodnota", "Pracovník", "Čas", "Poznámka"]);
  }

  heading("Naměřené hodnoty");
  table(snapshot.measurements.length ? snapshot.measurements.map((item) => [MEASUREMENT_LABELS[item.type] ?? item.type, item.subject ?? "—", `${display(item.value)} ${item.unit}`, measurementResult(item.result), display(item.instrument), item.measuredBy ?? "—", dateTime(item.measuredAt)]) : [["—", "—", "—", "Bez záznamu", "—", "—", "—"]], ["Typ", "Okruh / přístroj", "Hodnota", "Výsledek", "Měřicí přístroj", "Pracovník", "Čas"]);

  heading("Závady a opravy");
  table(snapshot.defects.length ? snapshot.defects.map((item) => [item.critical ? "Kritická" : SEVERITY_LABELS[item.severity] ?? item.severity, item.title, STATUS_LABELS[item.status] ?? item.status, item.repairDescription ?? "—", item.foundBy ?? "—", dateTime(item.foundAt), item.closedBy ?? "—", dateTime(item.closedAt)]) : [["—", "Bez evidovaných závad", "—", "—", "—", "—", "—", "—"]], ["Závažnost", "Závada", "Stav", "Způsob opravy", "Zjistil", "Zjištěno", "Uzavřel", "Uzavřeno"]);

  heading("Fotodokumentace");
  table(snapshot.photos.length ? snapshot.photos.map((item) => [PHOTO_LABELS[item.category] ?? item.category, item.description ?? item.fileName, item.author ?? "—", dateTime(item.takenAt ?? item.createdAt), item.sha256.slice(0, 16)]) : [["—", "Bez fotografie", "—", "—", "—"]], ["Kategorie", "Popis", "Autor", "Čas", "SHA-256"]);

  if (snapshot.protocol.overrideReason) {
    heading("Administrátorská výjimka");
    table([["Zdůvodnění", snapshot.protocol.overrideReason], ["Obejité blokace", snapshot.protocol.overriddenBlockers.map((item) => item.message).join("; ")]]);
  }

  if (y > 225) { doc.addPage(); y = 15; }
  heading("Finální schválení a podpisová pole");
  doc.setFont(PDF_FONT, "normal"); doc.setFontSize(8);
  doc.text(`Elektronicky dokončil: ${snapshot.protocol.generatedBy}`, margin, y + 2); doc.text(`Datum a čas: ${dateTime(snapshot.protocol.generatedAt)}`, 110, y + 2); y += 12;
  const boxes = ["Zhotovil", "Zkontroloval", "Převzal / zákazník"];
  for (let i = 0; i < boxes.length; i++) { const x = margin + i * 61; doc.setDrawColor(150); doc.rect(x, y, 56, 28); doc.setFont(PDF_FONT, "bold"); doc.text(boxes[i], x + 2, y + 5); doc.setFont(PDF_FONT, "normal"); doc.setFontSize(7); doc.text("Jméno, datum, podpis", x + 2, y + 25); }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) { doc.setPage(page); doc.setDrawColor(195, 195, 195); doc.line(margin, 286, 196, 286); doc.setFont(PDF_FONT, "normal"); doc.setFontSize(7); doc.setTextColor(75, 75, 75); doc.text(`${snapshot.company.name} · ${snapshot.protocol.number} · v${snapshot.protocol.version}`, margin, 291); doc.text(`Strana ${page} / ${pages}`, 196, 291, { align: "right" }); doc.setTextColor(0, 0, 0); }
  return Buffer.from(doc.output("arraybuffer"));
}
