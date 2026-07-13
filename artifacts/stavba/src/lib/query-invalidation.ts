import type { QueryClient } from "@tanstack/react-query";
import type { LiveDomain } from "@workspace/live-events";

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
 *   await invalidateData(queryClient, "jobs");               // po změně zakázky
 *   await invalidateData(queryClient, "jobs", "warehouse");  // materiál mění i sklad
 *   void invalidateData(queryClient, "machines");            // fire-and-forget bez await
 *
 * Při přidání nové mutace zvolte dotčené domény z `InvalidationDomain`. Pokud
 * žádná nesedí, přidejte novou doménu zde (a její URL prefix) – ať tohle
 * zůstává jediné místo, kde jsou vazby mezi dotazy popsané.
 *
 * Domain type comes from @workspace/live-events — the single source of truth
 * shared with the API server. Re-exported here so callers that imported it
 * from this file don't need to change their imports.
 */
export type { LiveDomain as InvalidationDomain } from "@workspace/live-events";

/**
 * URL prefixy, které daná doména „vlastní". Invaliduje se každý dotaz, jehož
 * první prvek klíče je roven prefixu nebo začíná `prefix + "/"` (tedy i detaily
 * a pod-seznamy jako `/materials` nebo `/time-entries`).
 */
const DOMAIN_PREFIXES: Record<LiveDomain, readonly string[]> = {
  // Zakázky táhnou i dashboard a statistiky (počty, odpracované hodiny).
  jobs: [
    "/api/jobs",
    "/api/dashboard",
    "/api/me/stats",
    "/api/me/jobs",
    "/api/me/visits",
    "/api/stats/overview",
  ],
  // Činnosti se promítají do statistik a výjezdového kalendáře.
  activities: ["/api/activities", "/api/me/stats", "/api/me/visits", "/api/stats/overview"],
  // Skladové položky, kniha pohybů i souhrnný přehled skladu.
  warehouse: ["/api/warehouse-items", "/api/warehouse-movements", "/api/warehouse-summary"],
  // Zákazníci, jejich místa, kontakty, přístupové údaje, detailní finanční
  // souhrn i rizika zákazníka.
  customers: ["/api/customers", "/api/customer-sites", "/api/risks/summary"],
  people: ["/api/people", "/api/ppe/assignments"],
  ppe: ["/api/ppe", "/api/me/ppe"],
  quotes: ["/api/quotes"],
  machines: ["/api/machines"],
  // Dovolené a jejich souhrny; dovolené ovlivňují i personální přehled.
  leaves: ["/api/leaves"],
  // Faktury: seznam, detail, souhrn fakturace i nevyfakturovaní zákazníci.
  billingInvoices: [
    "/api/billing/invoices",
    "/api/billing/summary",
    "/api/billing/unbilled",
  ],
  // Šablony paušálních faktur.
  billingRecurringTemplates: ["/api/billing/recurring-templates"],
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
  // Aktivní přihlášení — admin přehled i vlastní session uživatele.
  sessions: ["/api/admin/sessions", "/api/sessions"],
  // Role and permission changes must update navigation in already-open sessions.
  auth: ["/api/auth/me", "/api/users"],
  switchboards: ["/api/switchboards"],
};

/**
 * Doménové kaskády: změna v jedné doméně musí obnovit i navázané domény.
 * (Vlastní prefixy domény se přidávají vždy; tady jsou jen mezidoménové vazby.)
 */
const DOMAIN_RELATED: Partial<Record<LiveDomain, readonly LiveDomain[]>> = {
  bankImport: ["billingInvoices"],
  emailImport: ["billingDocuments"],
  reviewQueue: ["billingDocuments"],
  // Přijaté doklady ovlivňují zákaznický detail a rizika (dokumenty → zákazníci).
  billingDocuments: ["customers"],
  // Vydané faktury a zakázky mění finanční souhrn zákazníka.
  billingInvoices: ["customers"],
  jobs: ["customers"],
  // Nabídky se propíší do finančního souhrnu zákazníka.
  quotes: ["customers"],
  // Dovolené ovlivňují personální přehled.
  leaves: ["people"],
};

function collectPrefixes(domains: readonly LiveDomain[]): string[] {
  const prefixes = new Set<string>();
  const visited = new Set<LiveDomain>();
  const visit = (domain: LiveDomain) => {
    if (visited.has(domain)) return;
    visited.add(domain);
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
 *
 * Vrací `Promise<void>`, takže lze volat s `await` vždy, kdy je třeba počkat
 * na dokončení invalidace před navigací nebo dalším krokem. Pro fire-and-forget
 * použijte `void invalidateData(...)`.
 */
export function invalidateData(
  queryClient: QueryClient,
  ...domains: LiveDomain[]
): Promise<void> {
  const prefixes = collectPrefixes(domains);
  if (prefixes.length === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0];
      if (typeof head !== "string") return false;
      return prefixes.some(
        (prefix) => head === prefix || head.startsWith(`${prefix}/`),
      );
    },
  });
}
