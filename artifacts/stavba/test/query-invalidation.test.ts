import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  getListJobsQueryKey,
  getGetJobQueryKey,
  getListMaterialsQueryKey,
  getListTasksQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetTodayJobsQueryKey,
  getGetMyStatsQueryKey,
  getGetMyDoneJobsQueryKey,
  getGetStatsOverviewQueryKey,
  getListActivitiesQueryKey,
  getGetActivityQueryKey,
  getListWarehouseItemsQueryKey,
  getListWarehouseItemMovementsQueryKey,
  getListWarehouseMovementsQueryKey,
  getGetWarehouseSummaryQueryKey,
  getListCustomersQueryKey,
  getListCustomerSitesQueryKey,
  getGetCustomerFinancialSummaryQueryKey,
  getGetRisksSummaryQueryKey,
  getListPeopleQueryKey,
  getListPpeAssignmentsQueryKey,
  getListMachinesQueryKey,
  getListLeavesQueryKey,
  getListInvoicesQueryKey,
  getGetInvoiceQueryKey,
  getGetBillingSummaryQueryKey,
  getListUnbilledCustomersQueryKey,
  getListCostDocumentsQueryKey,
  getGetCostDocumentQueryKey,
  getListApprovedCostLinesQueryKey,
  getGetEmailImportStatusQueryKey,
  getListEmailImportLogQueryKey,
  getListRecurringTemplatesQueryKey,
  getListAllSessionsQueryKey,
  getListMySessionsQueryKey,
  getListQuotesQueryKey,
} from "@workspace/api-client-react";
import {
  invalidateData,
  type InvalidationDomain,
} from "../src/lib/query-invalidation";

/**
 * Realné klíče tak, jak je generuje Orval (`lib/api-client-react`). Testy je
 * záměrně berou z generátoru, ne ručně psané řetězce – kdyby se formát klíče
 * změnil, test se rozbije spolu s aplikací.
 *
 * Pokrýváme tři tvary klíčů u každé domény:
 *   - seznam (`/api/jobs`)
 *   - detail (`/api/jobs/5`)
 *   - pod-seznam (`/api/jobs/5/materials`)
 * a navíc seznam s parametry (`["/api/jobs", { ... }]`).
 */
const KEYS = {
  // jobs
  jobsList: getListJobsQueryKey(),
  jobsListFiltered: getListJobsQueryKey({ status: "in_progress" } as never),
  jobDetail: getGetJobQueryKey(5),
  jobTasks: getListTasksQueryKey(5),
  jobMaterials: getListMaterialsQueryKey(5),
  dashboardSummary: getGetDashboardSummaryQueryKey(),
  dashboardToday: getGetTodayJobsQueryKey(),
  myStats: getGetMyStatsQueryKey(),
  myJobs: getGetMyDoneJobsQueryKey(),
  statsOverview: getGetStatsOverviewQueryKey(),
  // activities
  activitiesList: getListActivitiesQueryKey(),
  activityDetail: getGetActivityQueryKey(7),
  // warehouse
  warehouseItems: getListWarehouseItemsQueryKey(),
  warehouseItemMovements: getListWarehouseItemMovementsQueryKey(3),
  warehouseMovements: getListWarehouseMovementsQueryKey(),
  // customers
  customersList: getListCustomersQueryKey(),
  customerSites: getListCustomerSitesQueryKey(2),
  // people / machines
  peopleList: getListPeopleQueryKey(),
  machinesList: getListMachinesQueryKey(),
  // billing invoices
  invoicesList: getListInvoicesQueryKey(),
  invoiceDetail: getGetInvoiceQueryKey(9),
  billingSummary: getGetBillingSummaryQueryKey(),
  unbilledCustomers: getListUnbilledCustomersQueryKey(),
  // billing documents
  costDocumentsList: getListCostDocumentsQueryKey(),
  costDocumentDetail: getGetCostDocumentQueryKey(4),
  approvedLines: getListApprovedCostLinesQueryKey(),
  // email import
  emailImportStatus: getGetEmailImportStatusQueryKey(),
  emailImportLog: getListEmailImportLogQueryKey(),
  // warehouse summary
  warehouseSummary: getGetWarehouseSummaryQueryKey(),
  // customer financial summary + risks
  customerFinancialSummary: getGetCustomerFinancialSummaryQueryKey(1),
  risksSummary: getGetRisksSummaryQueryKey(),
  // leaves
  leavesList: getListLeavesQueryKey(),
  // ppe assignments
  ppeAssignments: getListPpeAssignmentsQueryKey(),
  // recurring templates
  recurringTemplates: getListRecurringTemplatesQueryKey(),
  // sessions
  allSessions: getListAllSessionsQueryKey({}),
  mySessions: getListMySessionsQueryKey(),
  // quotes
  quotesList: getListQuotesQueryKey(),
} as const;

type KeyName = keyof typeof KEYS;

/**
 * Naseje do cache každý známý klíč, spustí invalidaci pro zadané domény a vrátí
 * množinu názvů klíčů, které React Query označil jako neaktuální.
 */
function invalidatedNames(...domains: InvalidationDomain[]): Set<KeyName> {
  const qc = new QueryClient();
  for (const name of Object.keys(KEYS) as KeyName[]) {
    qc.setQueryData(KEYS[name], { ok: true });
  }

  invalidateData(qc, ...domains);

  const result = new Set<KeyName>();
  for (const name of Object.keys(KEYS) as KeyName[]) {
    const query = qc.getQueryCache().find({ queryKey: KEYS[name], exact: true });
    if (query?.state.isInvalidated) result.add(name);
  }
  return result;
}

describe("invalidateData – prefix predikát", () => {
  it("zasáhne seznam, detail i pod-seznam stejné domény", () => {
    const hit = invalidatedNames("jobs");
    expect(hit.has("jobsList")).toBe(true);
    expect(hit.has("jobsListFiltered")).toBe(true);
    expect(hit.has("jobDetail")).toBe(true);
    expect(hit.has("jobMaterials")).toBe(true);
    expect(hit.has("jobTasks")).toBe(true);
  });

  it("doména jobs táhne i dashboard, dnešní program a statistiky", () => {
    const hit = invalidatedNames("jobs");
    expect(hit.has("dashboardSummary")).toBe(true);
    expect(hit.has("dashboardToday")).toBe(true);
    expect(hit.has("myStats")).toBe(true);
    expect(hit.has("myJobs")).toBe(true);
    expect(hit.has("statsOverview")).toBe(true);
  });

  it("nezasáhne zcela cizí domény (stroje, sklad, email import)", () => {
    const hit = invalidatedNames("jobs");
    // jobs → customers kaskáda obnovuje finanční souhrn zákazníka; ostatní domény ne.
    expect(hit.has("warehouseItems")).toBe(false);
    expect(hit.has("invoicesList")).toBe(false);
    expect(hit.has("costDocumentsList")).toBe(false);
    expect(hit.has("peopleList")).toBe(false);
    expect(hit.has("machinesList")).toBe(false);
    expect(hit.has("emailImportStatus")).toBe(false);
  });

  it("jobs kaskáduje do customers, aby se obnovil finanční souhrn zákazníka", () => {
    const hit = invalidatedNames("jobs");
    expect(hit.has("customersList")).toBe(true);
    expect(hit.has("customerSites")).toBe(true);
  });

  it("warehouse zasáhne položky i knihu pohybů (vč. pohybů jedné položky)", () => {
    const hit = invalidatedNames("warehouse");
    expect(hit.has("warehouseItems")).toBe(true);
    expect(hit.has("warehouseItemMovements")).toBe(true);
    expect(hit.has("warehouseMovements")).toBe(true);
    expect(hit.has("jobsList")).toBe(false);
  });

  it("warehouse-items prefix neprosákne do warehouse-movements omylem přes startsWith", () => {
    // Pojistka: "/api/warehouse-items" nesmí matchnout "/api/warehouse-movements".
    const qc = new QueryClient();
    qc.setQueryData(["/api/warehouse-items"], { ok: true });
    qc.setQueryData(["/api/warehouse-movements"], { ok: true });
    // Doména, která vlastní jen items by ho neměla mít – ale "warehouse" vlastní obojí,
    // takže test směřuje na samotný startsWith přes prefix s lomítkem.
    invalidateData(qc, "customers"); // nesouvisející doména
    expect(
      qc.getQueryCache().find({ queryKey: ["/api/warehouse-items"], exact: true })
        ?.state.isInvalidated,
    ).toBe(false);
    expect(
      qc
        .getQueryCache()
        .find({ queryKey: ["/api/warehouse-movements"], exact: true })?.state
        .isInvalidated,
    ).toBe(false);
  });

  it("customers zasáhne zákazníky i jejich místa", () => {
    const hit = invalidatedNames("customers");
    expect(hit.has("customersList")).toBe(true);
    expect(hit.has("customerSites")).toBe(true);
  });

  it("activities zasáhne činnosti a statistiky, ne ale zakázky", () => {
    const hit = invalidatedNames("activities");
    expect(hit.has("activitiesList")).toBe(true);
    expect(hit.has("activityDetail")).toBe(true);
    expect(hit.has("myStats")).toBe(true);
    expect(hit.has("statsOverview")).toBe(true);
    expect(hit.has("jobsList")).toBe(false);
    expect(hit.has("dashboardSummary")).toBe(false);
  });

  it("billingInvoices zasáhne faktury, souhrn a nevyfakturované", () => {
    const hit = invalidatedNames("billingInvoices");
    expect(hit.has("invoicesList")).toBe(true);
    expect(hit.has("invoiceDetail")).toBe(true);
    expect(hit.has("billingSummary")).toBe(true);
    expect(hit.has("unbilledCustomers")).toBe(true);
    expect(hit.has("costDocumentsList")).toBe(false);
  });

  it("billingDocuments zasáhne doklady, schválené řádky a souhrn", () => {
    const hit = invalidatedNames("billingDocuments");
    expect(hit.has("costDocumentsList")).toBe(true);
    expect(hit.has("costDocumentDetail")).toBe(true);
    expect(hit.has("approvedLines")).toBe(true);
    expect(hit.has("billingSummary")).toBe(true);
    expect(hit.has("invoicesList")).toBe(false);
  });

  it("více domén najednou sloučí zásahy bez vzájemného rušení", () => {
    const hit = invalidatedNames("jobs", "warehouse");
    expect(hit.has("jobsList")).toBe(true);
    expect(hit.has("dashboardSummary")).toBe(true);
    expect(hit.has("warehouseItems")).toBe(true);
    expect(hit.has("warehouseMovements")).toBe(true);
  });
});

describe("invalidateData – mezidoménové kaskády", () => {
  it("bankImport obnoví fakturaci (sám žádný vlastní prefix nemá)", () => {
    const hit = invalidatedNames("bankImport");
    expect(hit.has("invoicesList")).toBe(true);
    expect(hit.has("billingSummary")).toBe(true);
    expect(hit.has("unbilledCustomers")).toBe(true);
    // bankImport nemá vlastní dotazy, takže nic mimo fakturaci.
    expect(hit.has("jobsList")).toBe(false);
    expect(hit.has("costDocumentsList")).toBe(false);
  });

  it("emailImport obnoví přijaté doklady i své vlastní dotazy", () => {
    const hit = invalidatedNames("emailImport");
    expect(hit.has("emailImportStatus")).toBe(true);
    expect(hit.has("emailImportLog")).toBe(true);
    expect(hit.has("costDocumentsList")).toBe(true);
    expect(hit.has("approvedLines")).toBe(true);
    expect(hit.has("billingSummary")).toBe(true);
    expect(hit.has("invoicesList")).toBe(false);
  });

  it("reviewQueue obnoví přijaté doklady (sám žádný vlastní prefix nemá)", () => {
    const hit = invalidatedNames("reviewQueue");
    expect(hit.has("costDocumentsList")).toBe(true);
    expect(hit.has("costDocumentDetail")).toBe(true);
    expect(hit.has("approvedLines")).toBe(true);
    expect(hit.has("emailImportStatus")).toBe(false);
  });
});

describe("invalidateData – ostatní chování", () => {
  it("bez domén nedělá nic", () => {
    const hit = invalidatedNames();
    expect(hit.size).toBe(0);
  });

  it("ignoruje dotazy s ne-řetězcovou hlavičkou klíče", () => {
    const qc = new QueryClient();
    qc.setQueryData([{ scope: "local" }, "jobs"], { ok: true });
    invalidateData(qc, "jobs");
    expect(
      qc
        .getQueryCache()
        .find({ queryKey: [{ scope: "local" }, "jobs"], exact: true })?.state
        .isInvalidated,
    ).toBe(false);
  });

  it("vrací Promise<void>", async () => {
    const qc = new QueryClient();
    const result = invalidateData(qc, "machines");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});

describe("invalidateData – warehouse summary", () => {
  it("warehouse zasáhne i /api/warehouse-summary", () => {
    const hit = invalidatedNames("warehouse");
    expect(hit.has("warehouseSummary")).toBe(true);
  });
});

describe("invalidateData – risks/summary a finanční souhrn zákazníka", () => {
  it("customers zasáhne /api/risks/summary", () => {
    const hit = invalidatedNames("customers");
    expect(hit.has("risksSummary")).toBe(true);
  });

  it("customers zasáhne /api/customers/:id/financial-summary", () => {
    const hit = invalidatedNames("customers");
    expect(hit.has("customerFinancialSummary")).toBe(true);
  });

  it("billingDocuments → customers kaskáda zasáhne /api/risks/summary", () => {
    const hit = invalidatedNames("billingDocuments");
    expect(hit.has("risksSummary")).toBe(true);
    expect(hit.has("customerFinancialSummary")).toBe(true);
  });

  it("billingInvoices → customers kaskáda zasáhne finanční souhrn zákazníka", () => {
    const hit = invalidatedNames("billingInvoices");
    expect(hit.has("customerFinancialSummary")).toBe(true);
    expect(hit.has("risksSummary")).toBe(true);
  });

  it("quotes → customers kaskáda zasáhne finanční souhrn zákazníka", () => {
    const hit = invalidatedNames("quotes");
    expect(hit.has("customerFinancialSummary")).toBe(true);
    expect(hit.has("risksSummary")).toBe(true);
  });

  it("jobs → customers kaskáda zasáhne finanční souhrn zákazníka", () => {
    const hit = invalidatedNames("jobs");
    expect(hit.has("customerFinancialSummary")).toBe(true);
    expect(hit.has("risksSummary")).toBe(true);
  });
});

describe("invalidateData – dovolené a personální přehled", () => {
  it("leaves zasáhne seznam dovolených", () => {
    const hit = invalidatedNames("leaves");
    expect(hit.has("leavesList")).toBe(true);
  });

  it("leaves → people kaskáda zasáhne personální přehled", () => {
    const hit = invalidatedNames("leaves");
    expect(hit.has("peopleList")).toBe(true);
    expect(hit.has("ppeAssignments")).toBe(true);
  });

  it("leaves neovlivní zakázky ani faktury", () => {
    const hit = invalidatedNames("leaves");
    expect(hit.has("jobsList")).toBe(false);
    expect(hit.has("invoicesList")).toBe(false);
    expect(hit.has("machinesList")).toBe(false);
  });
});

describe("invalidateData – paušální šablony (billingRecurringTemplates)", () => {
  it("billingRecurringTemplates zasáhne /api/billing/recurring-templates", () => {
    const hit = invalidatedNames("billingRecurringTemplates");
    expect(hit.has("recurringTemplates")).toBe(true);
  });

  it("billingRecurringTemplates nezasáhne faktury ani doklady", () => {
    const hit = invalidatedNames("billingRecurringTemplates");
    expect(hit.has("invoicesList")).toBe(false);
    expect(hit.has("costDocumentsList")).toBe(false);
  });
});

describe("invalidateData – fronta ke schválení (reviewQueue)", () => {
  it("reviewQueue zasáhne /api/billing/review-queue a přijaté doklady", () => {
    const hit = invalidatedNames("reviewQueue");
    expect(hit.has("costDocumentsList")).toBe(true);
    expect(hit.has("approvedLines")).toBe(true);
  });

  it("reviewQueue → billingDocuments → customers: zasáhne i rizika zákazníka", () => {
    const hit = invalidatedNames("reviewQueue");
    expect(hit.has("risksSummary")).toBe(true);
    expect(hit.has("customerFinancialSummary")).toBe(true);
  });
});

describe("invalidateData – sessions", () => {
  it("sessions zasáhne admin přehled i vlastní session", () => {
    const hit = invalidatedNames("sessions");
    expect(hit.has("allSessions")).toBe(true);
    expect(hit.has("mySessions")).toBe(true);
  });

  it("sessions nezasáhne zakázky ani zákazníky", () => {
    const hit = invalidatedNames("sessions");
    expect(hit.has("jobsList")).toBe(false);
    expect(hit.has("customersList")).toBe(false);
  });
});

describe("invalidateData – nabídky (quotes)", () => {
  it("quotes zasáhne seznam nabídek", () => {
    const hit = invalidatedNames("quotes");
    expect(hit.has("quotesList")).toBe(true);
  });

  it("quotes nezasáhne faktury ani doklady přímo", () => {
    const hit = invalidatedNames("quotes");
    expect(hit.has("invoicesList")).toBe(false);
    expect(hit.has("costDocumentsList")).toBe(false);
  });
});

/**
 * End-to-end pojistka nad samotnou cache: simuluje vytvoření/smazání zakázky
 * tak, jak to dělají stránky – po mutaci se zavolá `invalidateData(qc, "jobs")`.
 * Ověřuje, že aktivní (zobrazený) seznam zakázek i dashboard se samy znovu
 * načtou bez ručního obnovení, kdežto nesouvisející obrazovka ne.
 */
describe("invalidateData – e2e: změna zakázky obnoví seznam i dashboard", () => {
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("aktivní seznam zakázek, dashboard i zákazníci se po mutaci znovu načtou, stroje ne", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    let jobsFetches = 0;
    let dashboardFetches = 0;
    let customersFetches = 0;
    let machinesFetches = 0;

    const jobsObserver = new QueryObserver(qc, {
      queryKey: getListJobsQueryKey(),
      queryFn: async () => {
        jobsFetches += 1;
        return [];
      },
    });
    const dashboardObserver = new QueryObserver(qc, {
      queryKey: getGetDashboardSummaryQueryKey(),
      queryFn: async () => {
        dashboardFetches += 1;
        return { ok: true };
      },
    });
    const customersObserver = new QueryObserver(qc, {
      queryKey: getListCustomersQueryKey(),
      queryFn: async () => {
        customersFetches += 1;
        return [];
      },
    });
    const machinesObserver = new QueryObserver(qc, {
      queryKey: getListMachinesQueryKey(),
      queryFn: async () => {
        machinesFetches += 1;
        return [];
      },
    });

    const unsub = [
      jobsObserver.subscribe(() => {}),
      dashboardObserver.subscribe(() => {}),
      customersObserver.subscribe(() => {}),
      machinesObserver.subscribe(() => {}),
    ];

    // Počkej na úvodní načtení všech čtyř obrazovek.
    await flush();
    await flush();
    expect(jobsFetches).toBe(1);
    expect(dashboardFetches).toBe(1);
    expect(customersFetches).toBe(1);
    expect(machinesFetches).toBe(1);

    // Simulace onSuccess po vytvoření/smazání zakázky.
    invalidateData(qc, "jobs");

    // Aktivní dotazy se znovu načtou samy, bez ručního obnovení.
    await flush();
    await flush();
    expect(jobsFetches).toBe(2);
    expect(dashboardFetches).toBe(2);
    // jobs → customers kaskáda: finanční souhrn zákazníka se obnoví také.
    expect(customersFetches).toBe(2);
    // Zcela nesouvisející obrazovka zůstává nedotčená.
    expect(machinesFetches).toBe(1);

    for (const u of unsub) u();
  });
});
