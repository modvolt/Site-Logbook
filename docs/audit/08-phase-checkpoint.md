# Checkpoint FÁZE 8.12 – R06c: neměnné job/quote verze

- **Stav:** FÁZE 8.12 dokončena lokálně v commitu `fefc67e`.
- **Rozsah:** R06 je lokálně implementačně dokončen; R07 nebyl v této podfázi zahájen a celá FÁZE 8 proto ještě není dokončena.
- **Produkce:** žádný přístup k produkční DB, secrets ani `modvoltapp.cz`; žádný push ani deploy.
- **Souběžná práce:** UI preference, redesign, migrace `0100` a jejich generované výstupy nebyly zahrnuty do commitu.

## Co je nyní uzavřeno

1. Každý nový podpisový job token je svázán s jednou `job_document_versions` verzí a každý quote token s jednou `quote_versions` verzí.
2. Veřejný GET čte uložený snapshot; pozdější změna parent tabulky nemění obsah ani snapshot hash, který zákazník vidí.
3. Job podpis vyžaduje jméno podepisujícího, ukládá neměnný confirmation text, serverový čas, omezený hash User-Agentu, PNG hash a serverem vytvořené finální PDF + PDF hash.
4. Quote accept/reject vyžaduje jméno respondenta a v jedné transakci spotřebuje token, změní stav a zapíše event ke konkrétní verzi.
5. DB triggery blokují UPDATE/DELETE verzí a eventů. Povolen je pouze jednorázový job přechod `pending_signature → signed` a úzké odpojení zaniklého interního user ID při account erasure; ostatní důkazní pole zůstávají zmrazená.
6. Opětovné vydání odkazu zapisuje `cancelled`/`superseded` událost a revokuje předchozí token.
7. Oprava podepsaného protokolu nebo vydané nabídky zachová starou verzi a otevře parent pro novou verzi s povinným důvodem. Převedenou nabídku API bez samostatného storna navazujícího dokladu znovu neotevře.
8. Klientský `job-sheet` upload už nemůže příznakem `signed` vytvořit falešně označený důkaz.
9. Legacy job/quote odkazy bez verze jsou označené `legacy_unbound` a fail-closed. Historickým dokumentům se zpětně nepřisuzuje neměnnost.

Tím jsou lokálně uzavřeny `SEC-14`, `COMP-02`, `COMP-07` a korekční část `UX-09`. Společně s FÁZEMI 8.10–8.11 je lokálně dokončen R06.

## Migrační a návratový model

- `0102_immutable_job_quote_versions.sql` je aditivní migrace: čtyři nové tabulky, tři binding sloupce tokenů, indexy, constraints a neměnnostní triggery.
- `0102_snapshot.json` vznikl z čistého exportu `HEAD` bez migrace `0100_user_ui_preferences`.
- Čistý journal commitu obsahuje `0101` a `0102`, nikoli souběžnou `0100`; hlavní pracovní strom nadále obsahuje uživatelskou kombinaci.
- Guarded down migrace se odmítne, jakmile existuje verze, event nebo bound token. Po prvním vydání nového odkazu je správný návrat roll-forward.
- Produkční pořadí musí být migrace `0101` → `0102` → koordinované API/frontend nasazení → měřený cutover a znovuodeslání aktivních legacy odkazů.

## Provedené kontroly

| Kontrola | Výsledek |
|---|---:|
| Čistý migrační řetězec v izolovaném PostgreSQL 18.4 | 102/102 migrací, 97 tabulek ověřeno proti snapshotu |
| Finální cílené DB/API testy | 4 soubory, 14/14 testů |
| Relevantní hermetické kontrakty v hlavním stromu | 4 soubory, 53/53 testů |
| Stejné kontrakty nad čistým exportem commitu | 4 soubory, 53/53 testů |
| DB/API/frontend a generované klienty – TypeScript | bez chyb |
| OpenAPI/Orval + route manifest | úspěšně regenerováno; čistý manifest 402 tras |
| Produkční Vite/PWA build | úspěšný, 4002 modulů |
| `git diff --check` a izolace indexu | bez chyb; preference/redesign/`0100` nenalezeny ve staged obsahu |

Celý hermetický API gate skončil **273/274**. Jediný neúspěch `field-job-workflow-contract.test.ts` očekává starou field navigaci `[/, /calendar, /jobs, /me]`, zatímco souběžný nezahrnutý redesign přidal další cesty. Relevantní R06c kontrakty prošly a cizí navigace nebyla opravována ani commitována.

## Nevyřešené otázky a rizika

1. R07 zůstává celý otevřený: CSP/frame-ancestors/security headers, dependency scan/aktualizace, SMTP/IMAP TLS fail-closed, interní router auth a CSV formula neutralizace.
2. Produkční migrace, object-storage ověření, zneplatnění legacy odkazů a monitoring 409/410 nebyly provedeny; tento běh byl auditní a lokální.
3. Staré job/quote odkazy nelze bezpečně backfillovat na přesný historický obsah. Je nutné je znovu vydat, nikoli „doplnit“ falešnou verzi.
4. Legacy plaintext sloupce zůstávají pro kompatibilní expand/cutover krok; jejich odstranění vyžaduje pozdější inventuru a samostatný contract release.
5. Obecná retence evidence a privacy logy patří do R10/R12; širší dokumentový lifecycle do R13.
6. Produkční build stále hlásí existující velké chunky nad 500 kB; nejde o regresi R06c ani blokátor důkazní integrity.

## Jednoznačný checkpoint

**CHECKPOINT FÁZE 8.12:** R06 je lokálně dokončen. Nový podpis zakázky i rozhodnutí o nabídce jsou svázané s neměnnou verzí, canonical snapshotem, ověřitelnými hashi a append-only eventem; korekce nepřepisuje původní důkaz. Izolovaná migrace, DB triggery, závody, kontrakty, typecheck i build prošly. Produkce, remote a secrets zůstaly nedotčené. FÁZE 8 jako celek pokračuje jedině R07; FÁZI 9 ani její nový cíl zatím nelze založit.

- **další fáze:** FÁZE 8.13 – R07: perimetr, CSP/security headers, dependency/TLS kontrakty, interní routy a CSV formula neutralizace.
- **doporučený model:** GPT-5.6 Sol.
- **doporučený reasoning:** xhigh.
- **důvod použití této úrovně:** R07 kombinuje veřejný HTTP perimetr, build/dependency dopady, transportní bezpečnost a fail-closed klasifikaci tras; chybná změna může zablokovat legitimní produkční provoz nebo ponechat obcházení ochrany.
- **očekávané činnosti:** znovu zmapovat aktuální headers/CSP, dependency advisories a lockfile, SMTP/IMAP TLS volby, interní routery a CSV exporty; implementovat malé izolované opravy, přidat kontrakty a otestovat produkční build bez deploye.
- **soubory, které budou pravděpodobně změněny:** API bootstrap/middleware a security-header konfigurace, e-mailové/importní TLS klienty, interní routy/policy manifest, CSV export helpery a jejich testy, případně `package.json`/`pnpm-lock.yaml`, `docs/audit/07-remediation-roadmap.md` a `docs/audit/08-phase-checkpoint.md`.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** databázová migrace se nepředpokládá; možné jsou rizikové dependency/lockfile změny, CSP kompatibilita, TLS cutover a fail-closed změny přístupu k trasám. Žádný produkční zásah bez samostatného schválení.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**. Teprve checkpoint s dokončeným R07 může uzavřít FÁZI 8; následně bude možné označit současný cíl za splněný a založit uživatelem požadovaný cíl FÁZE 9.
