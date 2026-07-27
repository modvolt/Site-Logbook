import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("ready-to-bill dashboard contract", () => {
  it("uses one canonical calculation in billing, dashboard, stats and risks", () => {
    const invoiceService = read(
      "artifacts/api-server/src/lib/invoice-service.ts",
    );
    const dashboardRoute = read(
      "artifacts/api-server/src/routes/dashboard.ts",
    );
    const statsRoute = read("artifacts/api-server/src/routes/stats.ts");
    const risksRoute = read("artifacts/api-server/src/routes/risks.ts");

    expect(invoiceService).toContain(
      "export function getReadyToBillSummary",
    );
    expect(invoiceService).toContain(
      "totalToInvoiceWithoutVat: readyToBill.totalWithoutVat",
    );
    expect(invoiceService).toContain("readyToBillSummaryInFlight");

    expect(dashboardRoute).toContain(
      "await getReadyToBillSummary()",
    );
    expect(dashboardRoute).toContain(
      "unbilledValue: readyToBill?.totalWithoutVat ?? null",
    );
    expect(statsRoute).toContain(
      "amount: readyToBill.totalWithoutVat",
    );
    expect(risksRoute).toContain(
      "canViewBilling ? readyToBill.totalWithoutVat : null",
    );
  });

  it("does not retain the old price-only dashboard aggregations", () => {
    const dashboardRoute = read(
      "artifacts/api-server/src/routes/dashboard.ts",
    );
    const statsRoute = read("artifacts/api-server/src/routes/stats.ts");
    const risksRoute = read("artifacts/api-server/src/routes/risks.ts");

    expect(dashboardRoute).not.toContain(
      "coalesce(sum(${jobsTable.price}), 0)",
    );
    expect(statsRoute).not.toContain("readyToBillJobsAgg");
    expect(risksRoute).not.toContain("unbilledDoneRows.reduce");
  });
});
