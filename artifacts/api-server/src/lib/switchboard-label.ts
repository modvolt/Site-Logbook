import { createCanvas, loadImage } from "@napi-rs/canvas";
import jsPDF from "jspdf";
import QRCode from "qrcode";
import modvoltLogo from "../../../../attached_assets/Color_logo_-_no_background_1780171783567.png";

export const SWITCHBOARD_LABEL_GENERATOR_VERSION = "1.0.0";
export const LABEL_WIDTH_MM = 100; export const LABEL_HEIGHT_MM = 60;
const WIDTH = 1181; const HEIGHT = 709;

export type SwitchboardLabelSnapshot = {
  designation: string; serialNumber: string; productionDate: string; typeDesignation: string;
  manufacturer: string; standards: string[]; networkSystem: string; ratedVoltage: string;
  ratedFrequency: string; ratedCurrent: string; dimensions?: string | null; weight?: string | null;
  ipRating: string; ikRating?: string | null; companyAddress?: string | null; companyPhone?: string | null;
};

export const REQUIRED_LABEL_FIELDS: Array<keyof SwitchboardLabelSnapshot> = ["designation", "serialNumber", "productionDate", "typeDesignation", "manufacturer", "standards", "networkSystem", "ratedVoltage", "ratedFrequency", "ratedCurrent", "ipRating"];
export function validateLabelSnapshot(snapshot: Partial<SwitchboardLabelSnapshot>): string[] {
  return REQUIRED_LABEL_FIELDS.filter((key) => { const value = snapshot[key]; return Array.isArray(value) ? value.length === 0 : !String(value ?? "").trim(); }).map(String);
}

export async function generateSwitchboardLabel(snapshot: SwitchboardLabelSnapshot, qrUrl: string): Promise<{ png: Buffer; pdf: Buffer }> {
  const missing = validateLabelSnapshot(snapshot); if (missing.length) throw Object.assign(new Error(`Chybí povinná pole štítku: ${missing.join(", ")}`), { code: "label_fields_missing" });
  const canvas = createCanvas(WIDTH, HEIGHT); const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, WIDTH, HEIGHT); ctx.strokeStyle = "#111827"; ctx.lineWidth = 5; ctx.strokeRect(3, 3, WIDTH - 6, HEIGHT - 6);
  const logo = await loadImage(modvoltLogo); const logoW = 300; const logoH = logoW * logo.height / logo.width; ctx.drawImage(logo, 36, 25, logoW, logoH);
  ctx.fillStyle = "#111827"; ctx.textBaseline = "top"; ctx.font = "bold 52px Arial"; ctx.fillText(snapshot.designation, 380, 30, 500); ctx.font = "bold 44px Arial"; ctx.fillText("CE", 1030, 30);
  const rows: Array<[string, string]> = [["Výrobní číslo", snapshot.serialNumber], ["Datum výroby", snapshot.productionDate], ["Typ", snapshot.typeDesignation], ["Soustava", snapshot.networkSystem], ["Napětí / frekvence", `${snapshot.ratedVoltage} / ${snapshot.ratedFrequency}`], ["InA", snapshot.ratedCurrent], ["Krytí", [snapshot.ipRating, snapshot.ikRating].filter(Boolean).join(" / ")], ["Rozměry / hmotnost", [snapshot.dimensions, snapshot.weight].filter(Boolean).join(" / ")], ["Normy", snapshot.standards.join(", ")]];
  let y = 145; for (const [label, value] of rows) { if (!value) continue; ctx.font = "26px Arial"; ctx.fillStyle = "#4b5563"; ctx.fillText(label, 38, y); ctx.font = "bold 29px Arial"; ctx.fillStyle = "#111827"; ctx.fillText(value, 300, y, 565); y += 48; }
  const qrData = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, errorCorrectionLevel: "M" }); const qr = await loadImage(qrData); ctx.drawImage(qr, 875, 180, 270, 270);
  ctx.font = "bold 24px Arial"; ctx.textAlign = "center"; ctx.fillText("Dokumentace a protokol", 1010, 465, 300); ctx.textAlign = "left";
  ctx.font = "22px Arial"; ctx.fillText(snapshot.manufacturer, 38, 640); const contact = [snapshot.companyAddress, snapshot.companyPhone].filter(Boolean).join(" · "); if (contact) { ctx.font = "18px Arial"; ctx.fillText(contact, 300, 644, 550); }
  const png = canvas.toBuffer("image/png"); const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [LABEL_WIDTH_MM, LABEL_HEIGHT_MM] }); doc.addImage(`data:image/png;base64,${png.toString("base64")}`, "PNG", 0, 0, LABEL_WIDTH_MM, LABEL_HEIGHT_MM); return { png, pdf: Buffer.from(doc.output("arraybuffer")) };
}
