# R13-D9QS – připravenost bezpečného přenosu do aktivního worktree

Datum: 2026-08-11  
Stav: **READ-ONLY TRANSFER MAP READY / aktivní produkční kód, migrace a Git index nezměněny**

## Ověřený výchozí stav

- aktivní worktree HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`;
- D9QR rehearsal HEAD: stejný `df918a5bbfb786420eba6c48844b632ba139d203`;
- live public `main` byl znovu read-only porovnán 2026-08-11 a zůstává přesně `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5` (`compare 6ae3072...main = identical`);
- draft PR #15 zůstává open/draft, `mergeable=false`, na vzdáleném headu `77b394e47ff39b5127de3a229fdfaae857a0115a`; jeho starý zelený CI není důkazem pro lokální rehearsal ani aktivní necommitnutý strom.

## Překryv souborů

D9QR obsahuje 48 souborů. Aktivní worktree má proti HEAD 55 změněných tracked a 124 untracked souborů.

- 44 D9QR souborů nemá žádný tracked ani untracked překryv s aktivními změnami;
- jejich raw Git patch prošel proti aktuálnímu aktivnímu worktree přes `git apply --check --whitespace=error-all`;
- žádný D9QR path nekoliduje s aktivním untracked souborem;
- přesně čtyři soubory se překrývají:
  - `lib/api-spec/openapi.yaml`;
  - `lib/api-client-react/src/generated/api.schemas.ts`;
  - `lib/api-client-react/src/generated/api.ts`;
  - `lib/api-zod/src/generated/api.ts`.

## Povaha jediného skutečného překryvu

Aktivní OpenAPI změny proti `df918a5` zasahují deset cest a šest schemas:

- cesty: people/customer/contact/site privacy deletion, GDPR erase, activity/job work-session correction, invoice cancel/status a cost-document disposition;
- schemas: `ErrorEnvelope`, `CancelInvoiceInput`, `CostDocumentStatusInput`, `CostDocumentDispositionInput`, `CostDocumentEarlyDiscardInput`, `CostDocumentReviewedRejectionInput`.

Aktivní změny nijak nemění `QuoteItem`, `QuoteItemInput`, `QuoteDetail` ani `PublicQuoteItem`; všechny čtyři quote schemas jsou byte-semanticky shodné s HEAD. D9QR mění právě tyto quote schemas. Jde proto o line-context konflikt způsobený vloženými aktivními API bloky před quote částí, nikoli o business-schema konflikt.

## Bezpečný přenosový algoritmus

1. Bez checkout/reset/clean zachovat přesný aktivní worktree a předem znovu uložit jeho status + diff hash.
2. Aplikovat pouze 44 nekolizních D9QR cest z exact staged tree `f4c56d4e26e5e40a84eb1dac7382bee5bd32a1d8`; patch byl read-only ověřen jako aplikovatelný.
3. Do aktivního `openapi.yaml` vložit pouze čtyři D9QR quote-schema změny:
   - `rowType` pro interní i public položku;
   - nullable `purchaseUnitPrice` pouze v interním/admin modelu;
   - margin summary v `QuoteDetail`;
   - u inputu povolit section/spacer popis a nonnegative prodejní/nákupní cenu.
4. Nekopírovat tři D9QR generated soubory. Z výsledného aktivního OpenAPI je deterministicky regenerovat Orval `8.9.1`, čímž se současně zachovají aktivní R09/R13/GDPR/work-session endpointy i nové quote typy.
5. Zkontrolovat, že public schema ani klient neobsahují purchase cost/margin v customer share response; interní admin schema je obsahuje.
6. Spustit nejprve D9QR cílené quote/migration/auth testy, potom aktivní R09–R13/R17 cílené testy a až následně společný Quality/release gate.
7. Znovu vypočítat kandidátní tree/patch ID; původní D9QR tree identifikuje rehearsal vstup, nikoli budoucí aktivní combined výsledek.

## Bezpečnostní a rollback hranice

- Přenos mění produkční zdrojový kód a migrační lineage, ale nesmí migrace spustit.
- Staré `0096_daffy_puppet_master` a jeho rollback se odstraní pouze jako dosud neprodukční code artifacts; produkční `0096_far_smiling_tiger` zůstává exact.
- Aktivní untracked R09–R13/R17 soubory se nesmějí přepisovat, mazat ani automaticky stageovat mimo přesný přenosový rozsah.
- Jakýkoli neočekávaný další překryv, změna live `main`, změna produkčního journalu nebo odlišný generated schema výsledek je stop condition pro opětovný review.
- Commit, push, private repin/merge, workflow dispatch, GHCR write, staging deploy, feature flags a DB migrace zůstávají samostatné approval boundaries.

## Checkpoint

Přenos je nyní technicky připraven tak, že 44/48 cest lze aplikovat přímo a zbývající čtyři se řeší jedním source-of-truth OpenAPI mergem plus regenerací. Žádná aktivní code/migration změna v tomto kroku neproběhla. Další krok vyžaduje dříve vyžádané výslovné schválení přenosu D9QR do aktivního worktree.
