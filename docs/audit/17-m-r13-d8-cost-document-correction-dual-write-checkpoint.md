# R13-D8 – cost-document correction dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark reopen/reapprove correction path; R13 jako celek NOT READY**

## Výsledek

R13-D8 chrání již schválený a nativně verzovaný přijatý doklad před tichým přepsáním:

- exact `ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED=true` funguje pouze společně s `ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED=true`; samotný correction flag skončí fail-closed `503`;
- approved doklad lze přes `setDocumentStatus` přesunout jen do `needs_review`, nikoli přímo do `reviewed`, `ignored` nebo `duplicate`;
- reopen vyžaduje NFC-normalizovaný důvod o délce 3–1000 znaků bez nepovolených control znaků;
- ve stejné caller-owned transakci vznikne `review_reopened` lifecycle event, export intent, aggregate-head CAS a mutable reopen projection; selhání outboxu rollbackuje vše;
- původní approved version zůstane beze změny. Uživatel upravuje pouze current draft projection;
- následné schválení vytvoří version N+1 s `purpose=correction`, `supersedes` relation, `correction_linked` event, export intent a nový aggregate head ve stejné transakci jako schválení;
- exact replay již schválené current version je no-op. Legacy approved row bez nativní evidence se při zapnutém gate nepřepisuje na falešnou historii.
- každý cost document s accounting headem je service-level chráněn proti hard delete i po reopen; ochrana se nespoléhá pouze na budoucí FK;
- existuje-li pro doklad nebo jeho řádek legacy `warehouse_price_history` projection, reopen skončí `409` před eventem i změnou statusu. Tím D8 nepoužije starou destruktivní cleanup cestu, dokud nebude připraven version-bound append-only price ledger.

## Důvod korekce a UI

- API `CostDocumentStatusInput` přijímá volitelný `reason`; pro approved reopen jej backend vyžaduje bez ohledu na klienta;
- frontend místo obecného confirm dialogu používá samostatný formulář s popisem immutable původní verze, limitem, `aria-invalid`, character countem a ochranou proti zavření/dvojímu odeslání během requestu;
- vstup se vymaže až po úspěchu; při serverové chybě zůstane uživateli zachován;
- canonical lifecycle event ukládá pouze domain-separated SHA-256 normalizovaného důvodu a stejný digest se přenese do relation i correction eventu. Raw text důvodu se nyní nikam durable neukládá. Jde o minimalizační hranici, ale současně o otevřený P1 gap pro čitelnou lidskou historii; před aktivací je nutný schválený bounded reason artifact nebo jiný ověřitelný způsob jeho uchování.

## Exact stavový automat

1. `approved` + native head `approved|correction_linked` → `needs_review` + `review_reopened`.
2. Rozpracovaná correction projection může přecházet pouze mezi `needs_review` a `reviewed`; její accounting head musí stále končit `review_reopened`.
3. `approveDocument` nad touto projection vytvoří právě jednu version N+1, relation a `correction_linked` event.
4. Přímé ignorování nebo jiné ukončení rozpracované correction projection je fail-closed. Samostatná evidence-preserving abandon cesta zatím neexistuje.

## Otevřené hranice

- `setDocumentStatus` zůstává smíšený seam: approved reopen je atomicky persistovaný, ale pre-accounting `ignored` větev nemá vlastní immutable version/event. Exact policy registr proto tento caller neoznačuje jako plně uzavřený;
- stávající warehouse price-history je mutable derived projection. D8 ji proto před correction reopen detekuje a fail-closed odmítne; versioned append-only warehouse-price mapping ještě neexistuje;
- raw reason není součástí immutable archive bundle, pouze jeho digest;
- flagy se nesmí zapnout před číslovanou expand migrací, journal parity, staging cutoverem a uzavřením výše uvedených hranic;
- nečíslovaná SQL šablona zůstává mimo `lib/db/migrations`; journal je 105/105, tail `0105_smooth_nitro`, `0100` zůstává vyloučena;
- nebyl proveden commit, push, PR, workflow dispatch, GHCR/S3 zápis, deploy, backfill ani staging/produkční migrace.

## Ověření

- celý API unit/contract gate: **98 souborů, 756/756 PASS**;
- R13-D8 pure UI/evidence/policy kontrakty: **PASS**;
- disposable PostgreSQL 16 D8 success/replay/fault/retry/legacy/dark/price-history/delete-guard sada: **5/5 PASS**;
- společný izolovaný R13-D4 až D8 regresní běh: **21/21 PASS** v pěti disposable databázích nad migracemi **105/105**, latest `0105_smooth_nitro`; po doplnění delete guardu byla D8 sada znovu ověřena 5/5;
- frontend unit sada: **19 souborů, 181/181 PASS**; frontend produkční build s `BASE_PATH=/`: **PASS**;
- API codegen, API typecheck, scoped ESLint, Impeccable hardening detector a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaných Windows LF→CRLF upozornění;
- PostgreSQL kontejner měl limit 0.75 CPU / 1 GiB, data na bounded tmpfs a po testu byl odstraněn.

## Doporučený další řez

R13-D9 má navrhnout a lokálně uzavřít zbývající `setDocumentStatus` větve bez falešné historie: append-only `ignored`/abandon event potřebuje přesně definovat, zda a kdy vzniká immutable observation version, jak se uloží čitelný minimalizovaný důvod a jak se zachová warehouse-price provenance. Potom lze znovu vyhodnotit, zda je celý caller opravdu plně atomický.
