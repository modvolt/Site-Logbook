/**
 * One-time data cleanup for job materials affected by the pre-fix pricing bug:
 * editing an approved invoice line, running "Aktualizovat ceny", or
 * bulk-confirming review lines used to skip re-running price propagation. On
 * data created before that fix, this can leave job materials with a stale
 * price/quantity, or — once a line becomes price-eligible again — a duplicate
 * material representing the same cost-document line.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run cleanup-materials            (report only, no writes)
 *   pnpm --filter @workspace/api-server run cleanup-materials -- --apply (also fix stale prices)
 *
 * Detection:
 *   - "stale sync" materials: rows created by `syncJobMaterialsForDocument`
 *     (sourceType='billing_document_line') whose stored price/quantity/unit no
 *     longer matches what that function would compute today for the current
 *     state of their source line, or whose source line is no longer eligible
 *     at all (should have been reconciled away already).
 *   - "stale propagation" materials: rows filled by
 *     `propagateInvoicePricesToJobMaterials` (priceSource='invoice', filled
 *     onto a DIFFERENT document's material) whose stored price no longer
 *     matches the source invoice line, or whose source line/document is no
 *     longer an eligible approved invoice.
 *   - "duplicate" groups: two or more materials that reference the very same
 *     billing_document_line (via sourceId or priceSourceLineId) — the bug's
 *     failure mode once a stale line becomes price-eligible again and a fresh
 *     sync creates a second row instead of reusing the first.
 *
 * `--apply` only re-runs the already-fixed pipeline — exactly the sequence
 * every mutation path now uses — for every APPROVED document that has a
 * flagged stale material:
 *   revertInvoicePricePropagation -> propagateInvoicePricesToJobMaterials
 *     -> syncJobMaterialsForDocument
 * That sequence is idempotent and safe to re-run; it is the real fix, just
 * applied retroactively. It deliberately does NOT delete anything — duplicate
 * groups are reported only. Picking which of two duplicate materials to keep
 * (e.g. one may already be invoiced to the customer) needs human judgement;
 * remove the wrong one via the existing UI, or:
 *   DELETE /api/jobs/:jobId/materials/:materialId
 */
import { db, materialsTable, billingDocumentLinesTable, billingDocumentsTable, jobsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { num, round2 } from "../lib/invoice-calc";
import {
  revertInvoicePricePropagation,
  propagateInvoicePricesToJobMaterials,
  syncJobMaterialsForDocument,
} from "../lib/cost-document-service";

const SYSTEM_ACTOR = { userId: null as number | null, name: "Systém (čištění dat)" };

type Doc = typeof billingDocumentsTable.$inferSelect;
type Line = typeof billingDocumentLinesTable.$inferSelect;
type Material = typeof materialsTable.$inferSelect;

interface StaleFinding {
  materialId: number;
  jobId: number;
  jobTitle: string | null;
  materialName: string;
  kind: "stale_sync" | "orphaned_sync" | "stale_propagation_price" | "stale_propagation_should_revert";
  documentId: number;
  documentNumber: string | null;
  storedPrice: number | null;
  expectedPrice: number | null;
  storedQuantity: number | null;
  expectedQuantity: number | null;
}

interface DuplicateGroup {
  billingDocumentLineId: number;
  documentId: number;
  documentNumber: string | null;
  lineDescription: string;
  materialIds: number[];
}

function lineIsMaterialEligible(line: Line): boolean {
  return !line.feeType && line.lineType === "material" && line.allocationType !== "stock";
}

async function main() {
  const apply = process.argv.includes("--apply");

  const allMaterials = await db.select().from(materialsTable);

  // Only rows with provenance are in scope; manually-added materials have
  // sourceType/priceSourceLineId both null and are never touched.
  const syncOwned = allMaterials.filter((m) => m.sourceType === "billing_document_line" && m.sourceId != null);
  const propagateFilled = allMaterials.filter(
    (m) => m.priceSource === "invoice" && m.priceSourceLineId != null,
  );

  const lineIds = new Set<number>();
  for (const m of syncOwned) lineIds.add(m.sourceId!);
  for (const m of propagateFilled) lineIds.add(m.priceSourceLineId!);

  const lines = lineIds.size
    ? await db.select().from(billingDocumentLinesTable).where(inArray(billingDocumentLinesTable.id, Array.from(lineIds)))
    : [];
  const lineById = new Map<number, Line>(lines.map((l) => [l.id, l]));

  const docIds = new Set<number>(lines.map((l) => l.documentId));
  const docs = docIds.size
    ? await db.select().from(billingDocumentsTable).where(inArray(billingDocumentsTable.id, Array.from(docIds)))
    : [];
  const docById = new Map<number, Doc>(docs.map((d) => [d.id, d]));

  const jobIds = new Set<number>(allMaterials.map((m) => m.jobId));
  const jobs = jobIds.size
    ? await db.select({ id: jobsTable.id, title: jobsTable.title }).from(jobsTable).where(inArray(jobsTable.id, Array.from(jobIds)))
    : [];
  const jobTitleById = new Map(jobs.map((j) => [j.id, j.title]));

  const findings: StaleFinding[] = [];
  const affectedDocumentIds = new Set<number>();

  // --- Stale sync-owned materials --------------------------------------
  for (const m of syncOwned) {
    const line = lineById.get(m.sourceId!);
    const doc = line ? docById.get(line.documentId) : undefined;
    if (!line || !doc) continue; // source line gone entirely: not this script's concern (FK would prevent it anyway)

    const isInvoiceDoc = doc.docType === "invoice" || doc.docType === "credit_note";
    const stillEligible = doc.status === "approved" && lineIsMaterialEligible(line) && line.activityId == null;

    if (!stillEligible) {
      findings.push({
        materialId: m.id,
        jobId: m.jobId,
        jobTitle: jobTitleById.get(m.jobId) ?? null,
        materialName: m.name,
        kind: "orphaned_sync",
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        storedPrice: m.pricePerUnit != null ? num(m.pricePerUnit) : null,
        expectedPrice: null,
        storedQuantity: m.quantity != null ? num(m.quantity) : null,
        expectedQuantity: null,
      });
      affectedDocumentIds.add(doc.id);
      continue;
    }

    const priceNum = line.unitPriceWithoutVat == null ? 0 : num(line.unitPriceWithoutVat);
    const hasPrice = priceNum > 0;
    const expectedPrice = isInvoiceDoc || hasPrice ? round2(priceNum) : null;
    const expectedQuantity = line.quantity == null ? null : round2(num(line.quantity));
    const storedPrice = m.pricePerUnit != null ? num(m.pricePerUnit) : null;
    const storedQuantity = m.quantity != null ? num(m.quantity) : null;

    if (storedPrice !== expectedPrice || storedQuantity !== expectedQuantity) {
      findings.push({
        materialId: m.id,
        jobId: m.jobId,
        jobTitle: jobTitleById.get(m.jobId) ?? null,
        materialName: m.name,
        kind: "stale_sync",
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        storedPrice,
        expectedPrice,
        storedQuantity,
        expectedQuantity,
      });
      affectedDocumentIds.add(doc.id);
    }
  }

  // --- Stale propagation-filled materials ------------------------------
  for (const m of propagateFilled) {
    const line = lineById.get(m.priceSourceLineId!);
    const doc = line ? docById.get(line.documentId) : undefined;
    if (!line || !doc) continue;
    // Skip rows this document created directly via sync (already checked above).
    if (m.sourceType === "billing_document_line" && m.sourceId === line.id) continue;

    const isInvoiceDoc = doc.docType === "invoice" || doc.docType === "credit_note";
    const eligible =
      doc.status === "approved" &&
      isInvoiceDoc &&
      lineIsMaterialEligible(line) &&
      line.unitPriceWithoutVat != null &&
      num(line.unitPriceWithoutVat) > 0;

    if (!eligible) {
      findings.push({
        materialId: m.id,
        jobId: m.jobId,
        jobTitle: jobTitleById.get(m.jobId) ?? null,
        materialName: m.name,
        kind: "stale_propagation_should_revert",
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        storedPrice: m.pricePerUnit != null ? num(m.pricePerUnit) : null,
        expectedPrice: null,
        storedQuantity: m.quantity != null ? num(m.quantity) : null,
        expectedQuantity: null,
      });
      affectedDocumentIds.add(doc.id);
      continue;
    }

    const expectedPrice = round2(num(line.unitPriceWithoutVat));
    const storedPrice = m.pricePerUnit != null ? num(m.pricePerUnit) : null;
    if (storedPrice !== expectedPrice) {
      findings.push({
        materialId: m.id,
        jobId: m.jobId,
        jobTitle: jobTitleById.get(m.jobId) ?? null,
        materialName: m.name,
        kind: "stale_propagation_price",
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        storedPrice,
        expectedPrice,
        storedQuantity: null,
        expectedQuantity: null,
      });
      affectedDocumentIds.add(doc.id);
    }
  }

  // --- Duplicate groups: same billing_document_line claimed by >1 material --
  const materialIdsByLineId = new Map<number, Set<number>>();
  for (const m of syncOwned) {
    const set = materialIdsByLineId.get(m.sourceId!) ?? new Set<number>();
    set.add(m.id);
    materialIdsByLineId.set(m.sourceId!, set);
  }
  for (const m of propagateFilled) {
    const set = materialIdsByLineId.get(m.priceSourceLineId!) ?? new Set<number>();
    set.add(m.id);
    materialIdsByLineId.set(m.priceSourceLineId!, set);
  }
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [lineId, materialIds] of materialIdsByLineId) {
    if (materialIds.size < 2) continue;
    const line = lineById.get(lineId);
    if (!line) continue;
    duplicateGroups.push({
      billingDocumentLineId: lineId,
      documentId: line.documentId,
      documentNumber: docById.get(line.documentId)?.documentNumber ?? null,
      lineDescription: line.description,
      materialIds: Array.from(materialIds),
    });
  }

  // --- Report -----------------------------------------------------------
  console.log(`Scanned ${allMaterials.length} materials (${syncOwned.length} sync-owned, ${propagateFilled.length} invoice-filled).`);
  console.log(`Found ${findings.length} stale material(s) and ${duplicateGroups.length} duplicate group(s).\n`);

  if (findings.length > 0) {
    console.log("=== Stale materials ===");
    for (const f of findings) {
      console.log(
        `material #${f.materialId} "${f.materialName}" (job #${f.jobId}${f.jobTitle ? ` ${f.jobTitle}` : ""}) ` +
          `[${f.kind}] doc #${f.documentId}${f.documentNumber ? ` (${f.documentNumber})` : ""} ` +
          `price: ${f.storedPrice ?? "-"} -> ${f.expectedPrice ?? "-"} ` +
          `qty: ${f.storedQuantity ?? "-"} -> ${f.expectedQuantity ?? "-"}`,
      );
    }
    console.log();
  }

  if (duplicateGroups.length > 0) {
    console.log("=== Duplicate groups (same cost-document line claimed by multiple materials) ===");
    for (const g of duplicateGroups) {
      console.log(
        `billing_document_line #${g.billingDocumentLineId} "${g.lineDescription}" doc #${g.documentId}` +
          `${g.documentNumber ? ` (${g.documentNumber})` : ""} -> materials [${g.materialIds.join(", ")}]. ` +
          `Review and delete the wrong one manually (DELETE /api/jobs/:jobId/materials/:materialId).`,
      );
    }
    console.log();
  }

  if (findings.length === 0 && duplicateGroups.length === 0) {
    console.log("No stale or duplicate materials found. Nothing to do.");
    process.exit(0);
  }

  if (!apply) {
    console.log("Dry run only (no changes made). Re-run with --apply to re-sync affected documents' pricing.");
    process.exit(0);
  }

  console.log(`--apply: re-syncing ${affectedDocumentIds.size} affected document(s)...`);
  let fixedDocs = 0;
  for (const documentId of affectedDocumentIds) {
    const doc = docById.get(documentId);
    if (!doc || doc.status !== "approved") continue; // only approved docs propagate/sync
    await db.transaction(async (tx) => {
      await revertInvoicePricePropagation(tx, documentId, SYSTEM_ACTOR);
      const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(tx, documentId, SYSTEM_ACTOR);
      await syncJobMaterialsForDocument(tx, documentId, SYSTEM_ACTOR, { excludeSourceLineIds: consumedLineIds });
    });
    fixedDocs++;
    console.log(`  re-synced document #${documentId}${doc.documentNumber ? ` (${doc.documentNumber})` : ""}`);
  }
  console.log(`Done. Re-synced ${fixedDocs} document(s). Duplicate groups (if any) still require manual review above.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Cleanup script failed:", err);
  process.exit(1);
});
