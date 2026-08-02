# Checkpoint FÁZE 8.11 – R06b: lifecycle veřejných tokenů

- **Stav:** FÁZE 8.11 dokončena lokálně. SEC-12 je uzavřen pro veřejné odkazy podpisu zakázky, podpisu a potvrzení OOPP a rozhodnutí o nabídce. R06 jako celek ani R07 dokončeny nejsou.
- **Výchozí revize:** `4b42ef6` (`main`; checkpoint FÁZE 8.10).
- **Implementační revize:** `a749475` (`security: enforce one-time public access tokens`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla čtena ani změněna produkční DB, produkční secrets nebo `modvoltapp.cz`; nebyl proveden push ani deploy.
- **Databázová změna:** expand-only migrace `0101_public_access_token_lifecycle.sql`. Legacy plaintext zůstává během přechodu zachován; jeho odstranění je samostatný měřený krok.
- **Provozní dokument:** [08-public-token-runbook.md](08-public-token-runbook.md).

## 1. Uzavřená architektura

Nová tabulka `public_access_tokens` je společným zdrojem stavu credentialu. Do DB se ukládá pouze SHA-256 hash 256bitového base64url tokenu, osmiznakový necitlivý prefix, účel, typ a ID zdroje, expirace, revokace a consume metadata. Účel a zdroj vynucuje DB `CHECK`; jeden hash nelze pro tentýž účel vložit dvakrát.

| Účel | Zdroj | Terminální akce | Výchozí expirace |
|---|---|---|---|
| `job_signature` | `job` | `signed` | 7 dní |
| `ppe_signature` | `ppe_assignment` | `signed` | 30 dní |
| `ppe_confirmation` | `ppe_assignment` | `confirmed` | 30 dní |
| `quote_decision` | `quote` | `accepted` nebo `rejected` | 30 dní |

Expirace lze nastavit proměnnými `JOB_SIGNATURE_EXPIRY_DAYS`, `PPE_SIGNATURE_EXPIRY_DAYS`, `PPE_CONFIRM_EXPIRY_DAYS` a `QUOTE_SHARE_EXPIRY_DAYS`; hodnoty mimo 1–365 dní bezpečně padají na výchozí hodnotu. Nový raw token existuje pouze v paměti při vydání a v odkazu odeslaném uživateli. Rotace v jedné transakci revokuje předchozí aktivní token stejného účelu a zdroje.

Veřejný resolver váže hash na konkrétní účel a zdroj. Malformed token vrací 400, neznámý 404, již spotřebovaný 409 a expirovaný nebo revokovaný 410. Spotřeba uzamkne token, provede doménový přechod a teprve v téže DB transakci označí token jako spotřebovaný. Paralelní accept/reject nabídky proto nemohou obě uspět.

Podepsaná nebo uzavřená zakázka a již potvrzený výdej OOPP nedostanou nový podpisový odkaz. Admin odpovědi již nevracejí raw job token, OOPP confirmation token ani quote `shareToken`; vracejí pouze okamžitě vytvořený odkaz tam, kde je raw credential právě dostupný. Staré ovládací prvky pro kopírování uloženého quote tokenu byly odstraněny.

## 2. Přechod legacy dat

Migrace vytváří novou tabulku a hashově importuje stávající job, OOPP a quote tokeny. Zachovává jejich známý terminální stav a tam, kde staré schéma nemá spolehlivou expiraci, používá explicitní legacy výchozí dobu. Aplikace po dobu přechodu umí legacy záznam importovat při prvním použití; nové credentialy zapisuje pouze do nové tabulky.

Migrace záměrně nemaže plaintext sloupce. Skript `public-tokens:backfill` má defaultně pouze dry-run, hlásí počty plaintext a unmatched řádků a při jediném unmatched tokenu odmítne mazání. Execute vyžaduje současně přesný název DB a potvrzení `CLEAR_PUBLIC_TOKEN_PLAINTEXT`. Rollback migrace je povolen jen před vznikem nového, revokovaného nebo spotřebovaného tokenu a pouze když každý hash stále přesně odpovídá obnovitelnému legacy plaintextu; jinak failuje a vyžaduje roll-forward.

## 3. Důkazy a kontroly

- TypeScript build knihoven `db`, `api-zod`, `api-client-react` a `live-events`: prošel.
- API a frontend typecheck: prošel.
- Cílený DB gate pro public token, job, OOPP a quote toky: **7/7 souborů, 100/100 testů**.
- Čerstvý izolovaný PostgreSQL 18 aplikoval pracovní migrační řetězec **102/102** včetně souběžné uživatelské `0100` a této `0101`; vzniklo 93 tabulek.
- Skutečný rollback na prázdném stavu odstranil tabulku i journal záznam; po vložení nového tokenu guard zachoval obojí a rollback odmítl.
- Cleanup drill: dry-run našel 1 plaintext/1 unmatched, execute jej odmítl; po doplnění přesného hashe execute odstranil 1/1 a ověřil nulu.
- Cílené kontraktní testy malformed/expired/revoked/replay/purpose binding prošly.
- `git diff --check`, staged-only kontrola a scan raw tokenů prošly; `shareToken` není v OpenAPI, generovaných klientech ani quote UI.
- Izolovaný commit obsahuje 29 souborů R06b. Překrývající se OpenAPI, klienti a journal neobsahují uživatelské preference ani migraci `0100`.

Celý API unit gate v hlavním pracovním stromu skončil **269/270**. Jediný neúspěch `field-job-workflow-contract.test.ts` očekává starou množinu field navigace, zatímco souběžný nezahrnutý redesign ji rozšířil. Cílený `public-access-token.contract.test.ts` prošel 3/3. Neúspěch není způsoben R06b a tato fáze cizí navigaci neopravovala ani nestagovala.

## 4. Nejasnosti a zbytková rizika

1. Produkční počet a stav legacy tokenů nebyl čten. Před cleanupem je nutný zálohovaný, měřený dry-run a nulový unmatched výsledek.
2. Po vymazání plaintextu nelze existující raw link z administrace znovu zobrazit. Pro nabídku se nový zákaznický odkaz získá opětovným odesláním/rotací; samostatná autorizovaná akce „vytvořit a kopírovat nový odkaz“ zatím není navržena.
3. Starší OOPP metadata `hasSignToken`/`hasConfirmToken` odvozují stav z legacy sloupců a po cleanupu mohou být informativně zastaralá; bezpečnostní rozhodování je nepoužívá.
4. Automatická retence a purge spotřebovaných/revokovaných tokenových metadat ani privacy logů nejsou součástí tohoto řezu. GDPR-11 je proto uzavřen pouze v části minimalizace raw credentialů.
5. Podpis zakázky a rozhodnutí o nabídce stále nejsou svázány s neměnným snapshotem, PDF hashem a verzí. SEC-14, COMP-02 a COMP-07 zůstávají otevřené; nelze tvrdit zpětnou neměnnost legacy dokumentů.
6. Korekční/storno model po podpisu a odpovídající UX-09 zůstává otevřený. R07 (CSP, dependency/TLS kontrakty a zbývající perimetr) nebyl zahájen.
7. V pracovním stromu zůstávají souběžné uživatelské redesign soubory a migrace `0100`; nejsou součástí `a749475`. Před další migrací je nutné znovu ověřit aktuální journal a volné číslo.

## 5. Jednoznačný checkpoint a doporučení

**CHECKPOINT FÁZE 8.11:** jednotný lifecycle job/PPE/quote veřejných credentialů je lokálně implementován jako hash-only, purpose-bound, expirovatelný, revokovatelný a atomicky jednorázový. Legacy přechod je expand-only, měřitelný a cleanup failuje při nesouladu. Produkční data, secrets, push ani deploy nebyly použity. R06 zůstává otevřen pro neměnné podepisované snapshoty a R07 zůstává celý otevřen. V tomto spuštění se nepokračuje do FÁZE 8.12 ani FÁZE 9 a aktivní cíl zůstává dokončení FÁZE 8.

- **další fáze:** FÁZE 8.12 – R06c: neměnné job/quote snapshoty, verze a hash přesně podepisovaného/akceptovaného artefaktu; korekční nebo storno návaznost bez přepisování důkazu.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** změna spojuje autorizaci, právně a účetně významný důkaz, transakční souběh, verzování a migraci existujících dokumentů; chybný návrh by mohl tvrdit neměnnost, která historicky neexistovala.
- **očekávané činnosti:** inventarizovat okamžik a obsah job/quote renderu; navrhnout immutable snapshot/version record a kanonický hash; atomicky svázat consume tokenu s konkrétní verzí; definovat legacy označení, korekci/storno a auditní metadata; přidat tamper, race, replay a migrační testy; připravit expand/backfill/cutover/rollback runbook.
- **soubory, které budou pravděpodobně změněny:** schéma a nová migrace/rollback v `lib/db`, job/quote PDF a veřejné transition služby/routy v `artifacts/api-server`, OpenAPI a generované kontrakty podle zvoleného modelu, cílené DB/concurrency testy a checkpoint/runbook.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Pravděpodobná je expand-only migrace snapshotů/verzí a označení legacy záznamů; změna zasahuje podpisy, akceptaci nabídky a důkazní integritu. Produkční migrace, backfill, práce s reálnými daty/secrets, push a deploy nejsou automaticky autorizovány.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**. FÁZI 9 lze zahájit a založit její cíl teprve po checkpointu, který prokáže dokončení celých R06 a R07.
