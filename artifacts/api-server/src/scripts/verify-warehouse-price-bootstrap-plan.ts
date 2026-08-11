import { readFile, stat } from "node:fs/promises";
import {
  verifyAccountingWarehousePriceBootstrapPlanBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes,
} from "../lib/accounting-warehouse-price-bootstrap-plan";
import { canonicalEvidenceJson, sha256Hex } from "../lib/evidence-hash";
import {
  assertWarehousePriceBootstrapReportFileSize,
  parseWarehousePriceBootstrapVerifyOptions,
} from "./warehouse-price-bootstrap-plan-policy";

async function readRegularBoundedFile(path: string, label: string) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`${label} path must be a regular file.`);
  }
  assertWarehousePriceBootstrapReportFileSize(fileStat.size);
  return readFile(path);
}

async function main(): Promise<void> {
  const options = parseWarehousePriceBootstrapVerifyOptions(
    process.argv.slice(2),
  );
  // Keep evidence reads sequential so the verifier does not double its bounded
  // peak memory while both raw artifacts are resident.
  const planBytes = await readRegularBoundedFile(
    options.planPath,
    "Warehouse-price bootstrap plan",
  );
  const reportBytes = await readRegularBoundedFile(
    options.parityReportPath,
    "Warehouse-price parity report",
  );
  const planFileSha256 = sha256Hex(planBytes);
  const reportFileSha256 = sha256Hex(reportBytes);
  if (planFileSha256 !== options.expectedPlanFileSha256) {
    throw new Error(
      "Warehouse-price bootstrap plan file digest does not match the approved value.",
    );
  }
  if (reportFileSha256 !== options.expectedReportFileSha256) {
    throw new Error(
      "Warehouse-price parity report file digest does not match the approved value.",
    );
  }
  const plan =
    verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(planBytes);
  verifyAccountingWarehousePriceBootstrapPlanBinding(plan, reportBytes);
  process.stdout.write(
    canonicalEvidenceJson({
      schemaVersion: "site-logbook.warehouse-price-bootstrap-verification/v1",
      verified: true,
      decision: plan.summary.decision,
      targetFingerprint: plan.sourceReport.targetFingerprint,
      parityReportSha256: plan.sourceReport.reportSha256,
      parityReportFileSha256: reportFileSha256,
      planSha256: plan.integrity.planSha256,
      planFileSha256,
    }),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Warehouse-price bootstrap plan verification failed."}\n`,
  );
  process.exitCode = 1;
});
