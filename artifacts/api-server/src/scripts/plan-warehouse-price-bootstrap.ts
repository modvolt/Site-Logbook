import { readFile, stat } from "node:fs/promises";
import {
  canonicalAccountingWarehousePriceBootstrapPlanJson,
  createAccountingWarehousePriceBootstrapPlan,
} from "../lib/accounting-warehouse-price-bootstrap-plan";
import { sha256Hex } from "../lib/evidence-hash";
import {
  assertWarehousePriceBootstrapReportFileSize,
  parseWarehousePriceBootstrapPlanOptions,
} from "./warehouse-price-bootstrap-plan-policy";

async function main(): Promise<void> {
  const options = parseWarehousePriceBootstrapPlanOptions(
    process.argv.slice(2),
  );
  const reportStat = await stat(options.parityReportPath);
  if (!reportStat.isFile()) {
    throw new Error(
      "Warehouse-price parity report path must be a regular file.",
    );
  }
  assertWarehousePriceBootstrapReportFileSize(reportStat.size);
  const reportBytes = await readFile(options.parityReportPath);
  const actualFileSha256 = sha256Hex(reportBytes);
  if (actualFileSha256 !== options.expectedReportFileSha256) {
    throw new Error(
      "Warehouse-price parity report file digest does not match the approved value.",
    );
  }
  const plan = createAccountingWarehousePriceBootstrapPlan({
    parityReportBytes: reportBytes,
    maxPlannedItems: options.maxPlannedItems,
  });
  process.stdout.write(
    canonicalAccountingWarehousePriceBootstrapPlanJson(plan),
  );
  if (plan.summary.decision === "REVIEW") process.exitCode = 2;
  if (plan.summary.decision === "BLOCK") process.exitCode = 3;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Warehouse-price bootstrap planning failed."}\n`,
  );
  process.exitCode = 1;
});
