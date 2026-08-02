import { jsPDF } from "jspdf";
import type { JobDocumentSnapshot } from "@workspace/db";
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf";
import robotoBold from "../assets/fonts/Roboto-Bold.ttf";

const PDF_FONT = "Roboto";
export const JOB_HANDOVER_RENDERER_VERSION = "job-handover-pdf-v1";

function registerFonts(doc: jsPDF): void {
  doc.addFileToVFS("Roboto-Regular.ttf", robotoRegular);
  doc.addFont("Roboto-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", robotoBold);
  doc.addFont("Roboto-Bold.ttf", PDF_FONT, "bold");
  doc.setFont(PDF_FONT, "normal");
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/Prague",
  }).format(value);
}

export interface JobHandoverPdfData {
  snapshot: JobDocumentSnapshot;
  version: number;
  snapshotSha256: string;
  signatoryName: string;
  signedAt: Date;
  signatureDataUrl: string;
  signatureSha256: string;
}

export function generateJobHandoverPdf(data: JobHandoverPdfData): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  registerFonts(doc);
  const left = 18;
  const right = 192;
  const width = right - left;
  let y = 20;

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(18);
  doc.text("Předávací protokol zakázky", left, y);
  doc.setFontSize(9);
  doc.setFont(PDF_FONT, "normal");
  doc.text(`Zakázka #${data.snapshot.job.id} · verze ${data.version}`, left, y + 7);
  y += 18;

  const row = (label: string, value: string | null): void => {
    doc.setFont(PDF_FONT, "bold");
    doc.setFontSize(9);
    doc.text(label, left, y);
    doc.setFont(PDF_FONT, "normal");
    const lines = doc.splitTextToSize(value?.trim() || "—", width - 48) as string[];
    doc.text(lines, left + 48, y);
    y += Math.max(7, lines.length * 4.5 + 2);
  };

  row("Název", data.snapshot.job.title);
  row("Zákazník", data.snapshot.job.customerCompanyName);
  row("Datum zakázky", data.snapshot.job.date);
  row("Popis", data.snapshot.job.notes);

  y += 3;
  doc.setDrawColor(190);
  doc.line(left, y, right, y);
  y += 8;
  doc.setFont(PDF_FONT, "bold");
  doc.text("Potvrzení zákazníka", left, y);
  y += 6;
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  const confirmation = doc.splitTextToSize(data.snapshot.confirmationText, width) as string[];
  doc.text(confirmation, left, y);
  y += confirmation.length * 4.5 + 8;

  row("Podepisující", data.signatoryName);
  row("Čas podpisu", formatDateTime(data.signedAt));
  row("Úroveň identity", "Jméno uvedené podepisující osobou; přístup přes jednorázový odkaz");

  doc.setFont(PDF_FONT, "bold");
  doc.text("Podpis", left, y);
  y += 4;
  doc.setDrawColor(150);
  doc.rect(left, y, 78, 32);
  doc.addImage(data.signatureDataUrl, "PNG", left + 2, y + 2, 74, 28);
  y += 40;

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(7);
  doc.text(`SHA-256 snapshotu: ${data.snapshotSha256}`, left, y, { maxWidth: width });
  y += 5;
  doc.text(`SHA-256 podpisu: ${data.signatureSha256}`, left, y, { maxWidth: width });
  y += 5;
  doc.text(`Renderer: ${JOB_HANDOVER_RENDERER_VERSION}`, left, y);

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(210);
    doc.line(left, 282, right, 282);
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(7);
    doc.text(`Zakázka #${data.snapshot.job.id} · v${data.version}`, left, 288);
    doc.text(`Strana ${page} / ${pages}`, right, 288, { align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}
