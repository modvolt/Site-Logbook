import pg, { type QueryResultRow } from "pg";
import {
  BILLING_DOCUMENT_AUDIT_BEGIN_SQL,
  BILLING_DOCUMENT_AUDIT_CONTEXT_SQL,
  BILLING_DOCUMENT_AUDIT_LINES_SQL,
  BILLING_DOCUMENT_AUDIT_REFERENCES_SQL,
  BILLING_DOCUMENT_AUDIT_SCOPE_SQL,
  classifyBillingDocumentBackfillAudit,
  classifyBillingLineEligibility,
  databaseNameFromPostgresUrl,
  parseBillingDocumentBackfillAuditOptions,
} from "./billing-document-backfill-audit-policy";

const { Client } = pg;

type UnknownRow = QueryResultRow & Record<string, unknown>;

function rowNumber(row: UnknownRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value;
}

function rowNullableNumber(row: UnknownRow, key: string): number | null {
  if (row[key] == null) return null;
  return rowNumber(row, key);
}

function rowString(row: UnknownRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value;
}

function rowNullableString(row: UnknownRow, key: string): string | null {
  if (row[key] == null) return null;
  return rowString(row, key);
}

function rowBoolean(row: UnknownRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value;
}

function rowNumberArray(row: UnknownRow, key: string): number[] {
  const value = row[key];
  if (!Array.isArray(value)) {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value.map((entry) => {
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Audit returned an invalid ${key} entry.`);
    }
    return parsed;
  });
}

function rowStringArray(row: UnknownRow, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value as string[];
}

function rowObjectArray(
  row: UnknownRow,
  key: string,
): Array<Record<string, unknown>> {
  const value = row[key];
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => entry == null || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new Error(`Audit returned an invalid ${key}.`);
  }
  return value as Array<Record<string, unknown>>;
}

function firstRow(rows: UnknownRow[], label: string): UnknownRow {
  if (rows.length !== 1) {
    throw new Error(`Audit ${label} query returned ${rows.length} rows.`);
  }
  return rows[0];
}

function serializeDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new Error("Audit returned an invalid timestamp.");
}

async function main(): Promise<void> {
  const options = parseBillingDocumentBackfillAuditOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  const urlDatabase = databaseNameFromPostgresUrl(connectionString);
  if (urlDatabase !== options.database) {
    throw new Error(
      "--database must exactly match the database named by DATABASE_URL.",
    );
  }

  const client = new Client({
    connectionString,
    application_name: "site-logbook-billing-backfill-read-only-audit",
    connectionTimeoutMillis: 10_000,
    query_timeout: 300_000,
    statement_timeout: 300_000,
  });
  let transactionOpen = false;

  try {
    await client.connect();
    await client.query(BILLING_DOCUMENT_AUDIT_BEGIN_SQL);
    transactionOpen = true;

    const parameters = [options.since];
    const context = firstRow(
      (await client.query<UnknownRow>(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL, parameters))
        .rows,
      "context",
    );
    const actualDatabase = rowString(context, "database");
    if (actualDatabase !== options.database) {
      throw new Error(
        "--database must exactly match PostgreSQL current_database().",
      );
    }
    if (rowString(context, "transaction_read_only") !== "on") {
      throw new Error("PostgreSQL did not enter a READ ONLY transaction.");
    }

    const scopeResult = await client.query<UnknownRow>(
      BILLING_DOCUMENT_AUDIT_SCOPE_SQL,
      parameters,
    );
    const referenceResult = await client.query<UnknownRow>(
      BILLING_DOCUMENT_AUDIT_REFERENCES_SQL,
      parameters,
    );
    const lineResult = await client.query<UnknownRow>(
      BILLING_DOCUMENT_AUDIT_LINES_SQL,
      parameters,
    );

    await client.query("COMMIT");
    transactionOpen = false;

    const documents = scopeResult.rows.map((row) => ({
      id: rowNumber(row, "id"),
      docType: rowString(row, "doc_type"),
      documentNumber: rowNullableString(row, "document_number"),
      supplierName: rowNullableString(row, "supplier_name"),
      supplierIc: rowNullableString(row, "supplier_ic"),
      jobId: rowNullableNumber(row, "job_id"),
      reviewedAt: serializeDate(row.reviewed_at),
      createdAt: serializeDate(row.created_at),
    }));

    const logicalReferences = referenceResult.rows.map((row) => {
      const unresolved = rowBoolean(row, "unresolved");
      const compatibleCandidateCount = rowNumber(
        row,
        "compatible_candidate_count",
      );
      return {
        documentId: rowNumber(row, "document_id"),
        docType: rowString(row, "doc_type"),
        documentNumber: rowNullableString(row, "document_number"),
        logicalKey: rowString(row, "logical_key"),
        referenceIds: rowNumberArray(row, "reference_ids"),
        referenceTypes: rowStringArray(row, "reference_types"),
        referenceNumbers: rowStringArray(row, "reference_numbers"),
        duplicate: rowBoolean(row, "duplicate"),
        conflicting: rowBoolean(row, "conflicting"),
        unresolved,
        rejectedOnly: rowBoolean(row, "rejected_only"),
        confirmedDocumentIds: rowNumberArray(row, "confirmed_document_ids"),
        confirmedJobIds: rowNumberArray(row, "confirmed_job_ids"),
        missingMatchedJobReferenceIds: rowNumberArray(
          row,
          "missing_matched_job_reference_ids",
        ),
        exactCandidate: unresolved && compatibleCandidateCount > 0,
        compatibleCandidateCount,
        exactCandidates: rowObjectArray(row, "exact_candidates"),
      };
    });
    const referenceFindings = logicalReferences.filter(
      (reference) =>
        reference.duplicate ||
        reference.conflicting ||
        reference.unresolved ||
        reference.exactCandidate ||
        reference.missingMatchedJobReferenceIds.length > 0,
    );
    const unsafeRelationshipDocumentIds = new Set(
      logicalReferences
        .filter((reference) => reference.conflicting || reference.unresolved)
        .map((reference) => reference.documentId),
    );

    const lines = lineResult.rows.map((row) => {
      const lineApproved = rowNumber(row, "line_approved");
      return {
        lineId: rowNumber(row, "line_id"),
        documentId: rowNumber(row, "document_id"),
        docType: rowString(row, "doc_type"),
        documentNumber: rowNullableString(row, "document_number"),
        description: rowString(row, "description"),
        lineApproved,
        billingEligibilityState: classifyBillingLineEligibility(lineApproved),
        lineMatchConfirmed: rowNumber(row, "line_match_confirmed"),
        lineInvoicedInvoiceId: rowNullableNumber(
          row,
          "line_invoiced_invoice_id",
        ),
        lineJobId: rowNullableNumber(row, "line_job_id"),
        lineActivityId: rowNullableNumber(row, "line_activity_id"),
        documentJobId: rowNullableNumber(row, "document_job_id"),
        fallbackJobIds: rowNumberArray(row, "fallback_job_ids"),
        fallbackEvidence: rowObjectArray(row, "fallback_evidence"),
        targetState: rowString(row, "target_state"),
        targetSource: rowNullableString(row, "target_source"),
        expectedJobId: rowNullableNumber(row, "expected_job_id"),
        expectedActivityId: rowNullableNumber(row, "expected_activity_id"),
        propagationState: rowString(row, "propagation_state"),
        materialIds: rowNumberArray(row, "material_ids"),
        materialJobIds: rowNumberArray(row, "material_job_ids"),
        materials: rowObjectArray(row, "materials"),
        activityMaterialIds: rowNumberArray(row, "activity_material_ids"),
        activityIds: rowNumberArray(row, "activity_ids"),
        blockerCount: rowNumber(row, "blocker_count"),
        blockers: rowObjectArray(row, "blockers"),
      };
    });
    const lineFindings = lines.filter(
      (line) =>
        line.targetState !== "resolved" ||
        line.propagationState !== "ok" ||
        line.lineApproved !== 1 ||
        line.blockerCount > 0,
    );
    const blockedLines = lines.filter(
      (line) =>
        line.blockerCount > 0 ||
        line.targetState !== "resolved" ||
        unsafeRelationshipDocumentIds.has(line.documentId),
    );
    const repairCandidateLineIds = lines
      .filter(
        (line) =>
          line.targetState === "resolved" &&
          (line.propagationState !== "ok" || line.lineApproved !== 1) &&
          line.blockerCount === 0 &&
          !unsafeRelationshipDocumentIds.has(line.documentId),
      )
      .map((line) => line.lineId);
    const frozenBlockerLines = lines.filter((line) => line.blockerCount > 0);

    const hardBlockers =
      logicalReferences.filter(
        (reference) => reference.conflicting || reference.unresolved,
      ).length +
      lines.filter((line) => line.targetState !== "resolved").length +
      frozenBlockerLines.length;
    const reviewFindings =
      referenceFindings.length +
      lineFindings.filter((line) => line.blockerCount === 0).length;

    const decision = classifyBillingDocumentBackfillAudit({
      hardBlockers,
      reviewFindings,
    });
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "read-only-audit",
          noChangesApplied: true,
          database: actualDatabase,
          transaction: {
            readOnly: true,
            isolation: rowString(context, "transaction_isolation"),
          },
          window: {
            timezone: rowString(context, "timezone"),
            source: options.since
              ? "explicit --since local midnight"
              : "Prague local midnight two calendar months before database now",
            requestedSince: options.since,
            dbNowLocal: rowString(context, "db_now_local"),
            cutoffLocal: rowString(context, "cutoff_local"),
          },
          scope: {
            approvedPrimaryDocuments: documents.length,
            documents,
          },
          logicalDeliveryNoteReferences: {
            scanned: logicalReferences.length,
            duplicate: logicalReferences.filter((item) => item.duplicate).length,
            conflicting: logicalReferences.filter((item) => item.conflicting).length,
            unresolved: logicalReferences.filter((item) => item.unresolved).length,
            exactCandidate: logicalReferences.filter((item) => item.exactCandidate)
              .length,
            missingMatchedJob: logicalReferences.filter(
              (item) => item.missingMatchedJobReferenceIds.length > 0,
            ).length,
            findings: referenceFindings,
          },
          rebillMaterialLines: {
            scanned: lines.length,
            missingTarget: lines.filter((line) => line.targetState === "missing")
              .length,
            ambiguousTarget: lines.filter(
              (line) => line.targetState === "ambiguous",
            ).length,
            missingPropagation: lines.filter(
              (line) => line.propagationState === "missing",
            ).length,
            wrongPropagation: lines.filter(
              (line) => line.propagationState === "wrong",
            ).length,
            billingEligibilityGap: lines.filter(
              (line) => line.lineApproved !== 1,
            ).length,
            findings: lineFindings,
          },
          frozenCustomerInvoiceBlockers: {
            policy:
              "Markers always block; invoice-line provenance and source links block every non-cancelled status, including draft.",
            lines: frozenBlockerLines.length,
            evidence: frozenBlockerLines.reduce(
              (total, line) => total + line.blockerCount,
              0,
            ),
            findings: frozenBlockerLines.map((line) => ({
              documentId: line.documentId,
              lineId: line.lineId,
              blockers: line.blockers,
            })),
          },
          planner: {
            decision,
            repairCandidateLineIds,
            blockedLineIds: blockedLines.map((line) => line.lineId),
            note: "Planner only. No DML or apply/execute path exists.",
          },
        },
        null,
        2,
      ),
    );
    if (decision === "BLOCK") process.exitCode = 2;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original audit failure.
      }
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
