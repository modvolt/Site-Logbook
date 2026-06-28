import type { QueryClient } from "@tanstack/react-query";

/**
 * Jediné dokumentované místo pro automatickou obnovu (invalidaci) dat napříč
 * obrazovkami. Cílem je, aby se změna provedená na jedné obrazovce sama
 * promítla na všech ostatních – uživatel nikdy nemusí ručně obnovovat.
 *
 * Proč predikát nad cestou a ne konkrétní klíče:
 * Generované React Query klíče jsou postavené na cestě API, např.
 * `["/api/jobs"]`, `["/api/jobs/5"]`, `["/api/jobs/5/materials"]`. React Query
 * porovnává klíče po prvcích, takže invalidace `["/api/jobs"]` NEzasáhne
 * `["/api/jobs/5/materials"]`. Proto invalidujeme podle začátku URL cesty – jeden
 * „doménový" zásah tak obnoví seznam, detail i všechny pod-seznamy najednou.
 *
 * Pozn.: `invalidateQueries` jen označí data jako neaktuální a znovu načte
 * pouze aktivní (zobrazené) dotazy. Nejde o polling – jde o jednorázovou obnovu
 * po mutaci, takže je to šetrné i na mobilních datech.
 *
 * Použití:
 *   import { invalidateData } from "@/lib/query-invalidation";
 *   invalidateData(queryClient, "jobs");               // po změně zakázky
 *   invalidateData(queryClient, "jobs", "warehouse");  // materiál mění i sklad
 *
 * Při přidání nové mutace zvolte dotčené domény z `InvalidationDomain`. Pokud
 * žádná nesedí, přidejte novou doménu zde (a její URL prefix) – ať tohle
 * zůstává jediné místo, kde jsou vazby mezi dotazy popsané.
 */
export type InvalidationDomain =
  | "jobs"
  | "activities"
  | "warehouse"
  | "customers"
  | "people"
  | "machines"
  | "leaves"
  | "billingInvoices"
  | "billingDocuments"
  | "bankImport"
  | "emailImport"
  | "reviewQueue";

/**
 * URL prefixy, které daná doména „vlastní". Invaliduje se každý dotaz, jehož
 * první prvek klíče je roven prefixu nebo začíná `prefix + "/"` (tedy i detaily
 * a pod-seznamy jako `/materials` nebo `/time-entries`).
 */
const DOMAIN_PREFIXES: Record<InvalidationDomain, readonly string[]> = {
  // Zakázky táhnou i dashboard a statistiky (počty, odpracované hodiny).
  jobs: [
    "/api/jobs",
    "/api/dashboard",
    "/api/me/stats",
    "/api/me/jobs",
    "/api/me/visits",
    "/api/stats/overview",
  ],
  // Činnosti se promítají do statistik.
  activities: ["/api/activities", "/api/me/stats", "/api/me/visits", "/api/stats/overview"],
  // Skladové položky i kniha pohybů (vč. pohybů jedné položky).
  warehouse: ["/api/warehouse-items", "/api/warehouse-movements"],
  // Zákazníci, jejich místa, kontakty, přístupové údaje + detail místa.
  customers: ["/api/customers", "/api/customer-sites"],
  people: ["/api/people"],
  machines: ["/api/machines"],
  leaves: ["/api/leaves"],
  // Faktury: seznam, detail, souhrn fakturace i nevyfakturovaní zákazníci.
  billingInvoices: [
    "/api/billing/invoices",
    "/api/billing/summary",
    "/api/billing/unbilled",
  ],
  // Přijaté doklady, schválené řádky a souhrn fakturace.
  billingDocuments: [
    "/api/billing/documents",
    "/api/billing/approved-lines",
    "/api/billing/summary",
  ],
  // Bankovní import jen páruje platby k fakturám (viz kaskáda níže).
  bankImport: [],
  // Import z e-mailu: stav připojení, zprávy a log.
  emailImport: ["/api/billing/email-import", "/api/email-import-log"],
  // Fronta K vyřízení — řádky dokladů čekající na ruční kontrolu.
  reviewQueue: ["/api/billing/review-queue"],
};

/**
 * Doménové kaskády: změna v jedné doméně musí obnovit i navázané domény.
 * (Vlastní prefixy domény se přidávají vždy; tady jsou jen mezidoménové vazby.)
 */
const DOMAIN_RELATED: Partial<
  Record<InvalidationDomain, readonly InvalidationDomain[]>
> = {
  bankImport: ["billingInvoices"],
  emailImport: ["billingDocuments"],
  reviewQueue: ["billingDocuments"],
};

function collectPrefixes(domains: readonly InvalidationDomain[]): string[] {
  const prefixes = new Set<string>();
  const visit = (domain: InvalidationDomain) => {
    for (const prefix of DOMAIN_PREFIXES[domain]) prefixes.add(prefix);
    for (const related of DOMAIN_RELATED[domain] ?? []) visit(related);
  };
  for (const domain of domains) visit(domain);
  return [...prefixes];
}

/**
 * Označí jako neaktuální (a u zobrazených dotazů znovu načte) všechna data
 * navázaná na zadané domény. Bezpečné volat i s více doménami – prefixy se
 * sloučí a odduplikují.
 */
export function invalidateData(
  queryClient: QueryClient,
  ...domains: InvalidationDomain[]
): void {
  const prefixes = collectPrefixes(domains);
  if (prefixes.length === 0) return;
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0];
      if (typeof head !== "string") return false;
      return prefixes.some(
        (prefix) => head === prefix || head.startsWith(`${prefix}/`),
      );
    },
  });
}
