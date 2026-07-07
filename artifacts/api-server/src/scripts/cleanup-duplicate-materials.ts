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
import { db, billingDocumentsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { detectStaleAndDuplicateMaterials } from "../lib/material-integrity";
import {
  revertInvoicePricePropagation,
  propagateInvoicePricesToJobMaterials,
  syncJobMaterialsForDocument,
} from "../lib/cost-document-service";

const SYSTEM_ACTOR = { userId: null as number | null, name: "Systém (čištění dat)" };

type Doc = typeof billingDocumentsTable.$inferSelect;

async function main() {
  const apply = process.argv.includes("--apply");

  const { scannedCount, syncOwnedCount, propagateFilledCount, findings, duplicateGroups, affectedDocumentIds } =
    await detectStaleAndDuplicateMaterials();

  // The apply step needs full doc rows (status) for the affected documents;
  // re-fetch them here rather than threading them through the report shape.
  const docById = new Map<number, Doc>();
  if (affectedDocumentIds.size) {
    const docs = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, Array.from(affectedDocumentIds)));
    for (const d of docs) docById.set(d.id, d);
  }

  // --- Report -----------------------------------------------------------
  console.log(`Scanned ${scannedCount} materials (${syncOwnedCount} sync-owned, ${propagateFilledCount} invoice-filled).`);
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
