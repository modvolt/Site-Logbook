# R13-D9P – public main a migration-lineage integration readiness

Datum: 2026-08-11  
Stav: **READ-ONLY ZMAPOVÁNO / INTEGRACE NENÍ PROVEDENA ANI SCHVÁLENA; žádný commit, push, deploy, DB/S3/GHCR zápis ani migrace**

## Přesný ověřený stav

- Lokální pracovní větev je `agent/phase16c3-staging-preflight` na `df918a5bbfb786420eba6c48844b632ba139d203` a obsahuje rozsáhlý necommitnutý auditní/remediační celek. Tento audit pracovní strom nezměnil mimo dokumentační checkpoint.
- Vzdálený head stejné větve a draft PR #15 je `77b394e47ff39b5127de3a229fdfaae857a0115a`. Lokální commit je proti němu fast-forwardově o šest commitů napřed, ale žádný z aktuálních necommitnutých R09–R13/R17 řezů na GitHubu není.
- Live public `main` je `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5`, strom `bae2152c358be9cd7b299f3a3def4d919a6ab613`, parent `95b4e78ad333169279b973e4d90791302e62d77b`.
- Lokální HEAD již obsahuje `95b4e78` přes merge `c092fac`; proti live `main` mu proto chybí jediný obsahový commit `6ae3072` s quote margins/section rows a produkčně aplikovanou `0096_far_smiling_tiger`.
- PR #15 zůstává open/draft, ale GitHub jej hodnotí `mergeable=false`. Remote PR head je proti `main` o 164 commitů napřed a o dva pozadu. Poslední exact-head Quality gate je pouze run `31408898444` pro starý remote head `77b394e` a skončil `success`; není důkazem pro lokální `df918a5`, necommitnuté změny ani budoucí integrovaný SHA.
- Read-only produkční inventura z `17-d-production-lineage-inventory.md` zůstává konzistentní s live GitHub stavem: produkce je na `6ae3072`, obsahuje všech 97 známých položek do `0096_far_smiling_tiger` a dvě další identity pouze jako `legacy_production_only_unknown`.

## Deterministický konfliktový důkaz

GitHub API potvrdilo, že live commit `6ae3072` má stejný tree SHA jako lokálně dostupný commit `d34f31441318c952588dea2642f06192e24b8cc1`. `git merge-tree --write-tree df918a5 d34f314` proto poskytuje exact obsahový proxy merge bez změny indexu nebo pracovního stromu.

Výsledek: pět konfliktních souborů a deset konfliktových bloků.

| Soubor                                              | Konfliktové bloky | Povinné rozuzlení                                                                                                                                                                                     |
| --------------------------------------------------- | ----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/api-server/src/lib/quote-service.ts`     |                 2 | zachovat immutable public-token/version snapshot cestu z lokální větve a doplnit `rowType`, structurální řádky a margin výpočty z `main`; veřejná odpověď ani PDF nesmí obsahovat `purchaseUnitPrice` |
| `artifacts/stavba/src/pages/quote-detail.tsx`       |                 1 | zachovat obě sady akcí/importů a následně ověřit editaci položky, sekce, spaceru, návratovou navigaci a privacy hranici                                                                               |
| `lib/api-client-react/src/generated/api.schemas.ts` |                 1 | neřešit ručně; nejprve sloučit OpenAPI source a potom klienta deterministicky regenerovat                                                                                                             |
| `lib/db/migrations/meta/0096_snapshot.json`         |                 5 | nepřijímat jednu stranu ani ručně spojovat JSON; produkční quote snapshot `0096` je základ a všechny pozdější snapshoty se musí znovu vygenerovat                                                     |
| `lib/db/migrations/meta/_journal.json`              |                 1 | zachovat produkční `0096_far_smiling_tiger`; dvojí index/tag `0096` je zakázaný                                                                                                                       |

Další quote route/spec/schema soubory se textově auto-mergeují, ale stále vyžadují semantické testy. Zvlášť `QuoteVersionSnapshot` nyní nezná `rowType`: integrovaná customer-facing immutable verze musí strukturální typ uložit a použít v public JSON/PDF, zatímco interní purchase cost zůstane mimo veřejný snapshot/response.

## Proč nelze journal sloučit mechanicky

Aktuální lokální journal má 105 položek a konec:

- `0096_daffy_puppet_master` – session generation;
- `0097_api_idempotency_records`;
- `0098_object-upload-ledger`;
- `0099_secret_envelope_encryption`;
- `0101_public_access_token_lifecycle`;
- `0102_immutable_job_quote_versions`;
- `0103_durable_operational_incident_outbox`;
- `0104_thin_sheva_callister`;
- `0105_smooth_nitro`.

Produkce má místo lokální `0096` již aplikovanou `0096_far_smiling_tiger` s `when=1786383352759`. Žádný aplikovaný produkční timestamp/hash se nesmí přepsat, přejmenovat ani odstranit. Dvě opaque legacy identity se nesmí zpětně pojmenovat. `0100` zůstává vyloučena.

Custom migrátor sice umí po Drizzle průchodu recovery missing `when` položek v journal order, ale tato pojistka není důvodem ponechat dvě různé `0096` nebo ručně slepit snapshot. Cílová code lineage musí být jednoznačná pro fresh install, produkční upgrade, staging preflight i offline evidence.

## Doporučený forward-only integrační tvar

Nejmenší varianta, která zachová význam kritických `0104`/`0105` staging kontraktů a přitom vytvoří jedinou `0096`, je:

1. zachovat byte-exact SQL, rollback, tag a `when` produkční `0096_far_smiling_tiger` z live `main`;
2. protože lokální `0096_daffy_puppet_master` ani `0097_api_idempotency_records` nebyly v produkci aplikovány, sloučit jejich expand-only SQL v původním pořadí do jedné nově zreviewované `0097` security/idempotency migrace;
3. ponechat význam a čísla `0098`, `0099`, `0101`, `0102`, `0103`, `0104` a `0105`; `0100` nevytvořit;
4. při schválené integraci přidělit všem dosud neprodukčním journal položkám `0097`–`0105` nové unikátní, striktně rostoucí `when` hodnoty vyšší než `1786383352759`; tento checkpoint konkrétní timestamps nepřiděluje;
5. začít exact produkčním `0096_snapshot.json` a deterministicky regenerovat `0097_snapshot.json` až `0105_snapshot.json` i celý `_journal.json`; žádný snapshot se nesmí ručně mergeovat;
6. vytvořit nový combined rollback pro `0097`, odstranit pouze dosud neprodukční lokální `0096_daffy_puppet_master` soubory a aktualizovat jejich characterization testy/runbooky;
7. zachovat staré Git commity a existující GHCR predecessor image jako historické immutable artefakty, ale označit je jako neautorizované pro novou lineage; nic nemažat ani nepřetagovat.

Tato varianta udrží 105 známých journal položek a zachová tail `0104_thin_sheva_callister` → `0105_smooth_nitro`, ale změní strom, snapshot IDs, journal timestamps a exact source SHA. Dosavadní predecessor/candidate GHCR evidence ani pinned private caller proto nelze znovu použít. Budou potřebovat nový reviewed source, nový exact-head Quality gate, novou publication evidence a samostatná schválení.

## Povinné ověření schválené integrace

1. Vyřešit quote konflikty tak, aby veřejný share/PDF zůstal snapshot-bound a bez purchase cost/margin leakage.
2. Regenerovat OpenAPI klienty a prokázat nulový ruční drift generated souborů.
3. Ověřit journal exact tag set, unikátní/rostoucí `when`, snapshot `prevId` chain, SQL/rollback páry a explicitní absenci `0100`.
4. Spustit fresh PostgreSQL migraci od nuly do `0105`.
5. Na izolované plné kopii produkce nejprve read-only porovnat schema/catalog s expected `0096` a dvěma opaque identities; teprve samostatně schválený testovací apply smí ověřit upgrade `0097`–`0105` a rollback/fault hranice.
6. Zopakovat exact-0104 predecessor → 0105 transition, backup/restore a schema-v4 evidence nad novým source SHA; staré image/evidence nejsou náhradou.
7. Spustit celý Quality/release gate a vyžadovat `completed/success` pro exact finální PR head po posledním integračním commitu.

## Zbývající blokery a approval boundaries

- Tento audit neprovedl merge/rebase, změnu migrace, commit ani push. Samotná integrace `main` a rebuild journalu/snapshotů je materiální změna a vyžaduje výslovné schválení.
- Journal inventura nedokládá schema význam dvou opaque produkčních řádků. Před jakýmkoli apply je nutný samostatně schválený read-only schema/catalog diff nebo izolovaná obnovená kopie; význam se nesmí odhadovat.
- Nové R09–R13/R17 migration číslo se nepřiděluje, dokud není výše popsaná základní lineage integrována a její fresh/upgrade testy zelené.
- Private repin/merge, workflow dispatch, GHCR zápis, staging deploy, DB migrace, feature-flag activation a produkční změna zůstávají oddělené schvalovací hranice.

## Checkpoint

- Live GitHub `main`, PR #15, remote head a exact-head CI: read-only ověřeno.
- Produkční deployed SHA/journal: převzato z dnešní read-only inventury a shoduje se s live `main`.
- Exact obsahové konflikty: 5 souborů / 10 bloků, ověřeno bez změny indexu.
- Doporučený forward-only lineage tvar: uložen, ale neimplementován.
- Produkční data, GitHub, Coolify, GHCR, S3, DB a migrace změněny: ne.
