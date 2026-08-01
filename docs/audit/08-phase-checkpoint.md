# Checkpoint FÁZE 8.8 – dokončení R04

- **Stav:** FÁZE 8.8 dokončena lokálně. Request/upload/object-storage řez R04 je implementovaný; FÁZE 8.9 ani FÁZE 9 nebyly zahájeny.
- **Výchozí revize:** `1ed61f4` (`main`; lokálně dvacet pět commitů před `origin/main`).
- **Implementační revize:** `63ba086` (`main`; lokálně dvacet šest commitů před `origin/main`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz`, vzdálený Git, push ani deploy.
- **Databázová změna:** aditivní migrace `0098_object-upload-ledger`; nebyla aplikována do produkce ani do existující sdílené databáze.
- **Provozní dokument:** [08-upload-protection-runbook.md](08-upload-protection-runbook.md).

## 1. Uzavřená architektura R04

### Request hranice

Globální 50MB JSON parser před autentizací byl odstraněn. Pořadí je nyní autentizace → route permission → přesná body policy/parser → offline idempotency → handler. Běžné public i authenticated JSON má 1 MiB, URL-encoded body 256 KiB a pouze přesně vyjmenované POST routy pro base64 PDF/bankovní parse mají 32 MiB. Raw uploady si ponechávají route-local parser, ale autentizace běží před rate limiterem i načtením těla. Nginx pro `/api` používá 30s body timeout a neposílá celý request do proxy bufferu.

### Strukturální validace a decompression budget

PNG, JPEG, GIF, WebP, PDF a ZIP mají kanonické strukturální kontroly včetně platného konce bez trailing polyglot dat. Neznámý MIME typ selže uzavřeně. OLE/OOXML mají vlastní validátory; OOXML odmítá macros, ActiveX, embeddings a XML signatures. Běžný ZIP má předalokovací budget 25 MiB vstup, 50 entries, 25 MiB/entry, 64 MiB celkem a poměr 100:1. Office povoluje nejvýše 2000 entries při stejných byte limitech. ISDOCX má přísnější 10/10/20 MiB budget. Vnitřní ZIP soubory se znovu typově ověřují; traversal, nested ZIP a nepovolené typy jsou odmítnuty.

Podpisové data URL/base64 mají limit 500 KiB, musí být skutečný PNG, dekódují se přes canvas, mají limit 2048 × 2048 a 2 miliony pixelů a před uložením se sanitizovaně znovu kódují. Job/customer/bank base64 vstupy používají kanonický bounded decoder a PDF se strukturálně ověří.

Gmail a IMAP byly zahrnuty jako samostatné ne-HTTP vstupy: 25 MiB/příloha, kanonické Gmail Base64URL a shoda deklarované velikosti, IMAP nejvýše 20 podporovaných příloh a 64 MiB na zprávu, strukturální/ZIP validace a stejný Office scanner. Přechodná nedostupnost scanneru se nepřepíše na trvalé „skipped“; zůstává retryable/fail-closed.

### Scanner, provider metadata a durable staging

Nový scanner adapter používá `UPLOAD_SCANNER_URL`, volitelný `UPLOAD_SCANNER_TOKEN`, produkční HTTPS, timeout 10 s a nejvýše 8 KiB odpovědi. Pasivní strukturálně validované formáty mohou pokračovat jako `content_validated`. Office vyžaduje verdict `clean`; malicious je odmítnut a unavailable selže uzavřeně. Generický unavailable Office upload je uložen pouze do nepřístupné karantény a klient nedostane použitelný object path.

Každý provider put počítá SHA-256 a zapisuje checksum i upload status do S3/GCS metadat. Hetzner kompatibilita zůstává zachována; nebyl vynucen S3 checksum režim, který tento provider dříve vyžadoval vypnout.

Migrace `0098` přidává `object_uploads` se stavem uploadu, scanneru, checksumem, vlastníkem, claim referencí, chybou a timestamps. Nové generické uploady používají `/objects/uploads/v2/…`. Job, activity a customer-site registrace atomicky claimnou jen `stored` objekt stejného uživatele ve stejné DB transakci. Frontendová inventura potvrdila, že všechny současné `useUpload` konzumenty končí v jedné z těchto tří claim rout. Legacy `/objects/uploads/…` zůstávají kompatibilní bez backfillu; nelze zpětně tvrdit, že byly ledgerem ověřeny.

Cost-document ingest a přímé customer/job PDF cesty odstraňují nově uložený objekt, pokud následný DB zápis selže. Pokud selže ledger update po provider putu, durable záznam zůstane `pending/failed` s chybou namísto bezevidence orphanu. Úplný reconciler, retence a mazání patří do R12.

## 2. Stav nálezů a hranice

| Nález | Stav po FÁZI 8.8 | Důkaz / hranice |
|---|---|---|
| SEC-11 | uzavřen lokálně pro nové vstupy | auth před parserem, pevné body/time/decompression limity, abort/413 kontrakty |
| SEC-13 | uzavřen lokálně pro nové vstupy | strukturální MIME/ZIP/OOXML validace, skutečné dekódování podpisu, scanner/quarantine |
| SEC-21 | částečně uzavřen R04, lifecycle pokračuje v R12 | SHA-256/status metadata, durable staging/claim; staré objekty, backup SSE/KMS, retence a cleanup se nemění |

R04 je tímto **lokálně dokončen**. R12 musí nad ledgerem doplnit inventuru, bezpečný reconciler, retenci, delete retry a orphan cleanup. V této fázi se žádný starý objekt nemaže, nemění ani neoznačuje zpětně za ověřený.

## 3. Provedené kontroly

### Hermetická a statická brána

- po hlavní implementaci prošel celý release gate: API/stavba/mockup/scripts typecheck, pět environment guardů, frontend 127/127, live-events 15/15, API 241/241 a API/PWA production build; celkem 383 aplikačních testů plus 5 guardů;
- po rozšíření ochrany na Gmail/IMAP prošel API typecheck a rozšířená hermetická sada 35 souborů, 245/245;
- bezpečnostní cílená sada pokrývá spoof/polyglot, trailing payload, ZIP bomb/entry/ratio budget, OOXML active content, oversized/aborted request, podpis decode/re-encode, scanner verdicty a upload ledger;
- `git diff --check` prošel; `package.json`, `pnpm-lock.yaml` a `pnpm-workspace.yaml` nemají diff po odstranění dočasných Windows bindingů;
- po posledním rozlišení retryable `scanner_unavailable` proběhla ještě syntax/transpile kontrola změněných importérů a diff kontrola. Opakovaný Vitest běh bez vyšších oprávnění zastavilo výhradně sandboxové čtení pnpm junction cest.

Na Windows byly pro úspěšný gate dočasně propojeny přesně verzované nativní bindingy esbuild, Rollup, Lightning CSS, Tailwind Oxide a canvas a root preinstall byl dočasně nahrazen Node ekvivalentem. Tracked manifesty a lockfile byly následně přesně obnoveny.

### Izolovaný PostgreSQL 18

- migration smoke: 99/99 migrací, latest `0098`, 92 tabulek proti snapshotu;
- `object-upload-ledger.db.test.ts`: 3/3;
- prázdný rollback `0098` prošel, po vložení evidenčního řádku se destruktivní rollback zablokoval a záznam zachoval;
- relevantní PPE concurrency s mocked storage: public token 9/9 a admin flow 9/9.

Pokus spustit celý historický DB test tree paralelně nad jednou DB prokázal existující cross-file kontaminaci fixture dat a několik nehermetických storage testů; relevantní sady byly proto ověřeny izolovaně/sekvenčně. Po posledním doplnění Gmail/IMAP limitů nebylo možné znovu vytvořit nový lokální PostgreSQL proces: běhové prostředí odmítlo další schválení kvůli vyčerpanému approval/usage limitu. Nebyla použita náhradní ani produkční DB a tato neprovedená matice je zbytková testovací nejasnost, nikoli skrytý úspěch.

## 4. Nejasnosti a zbytková rizika

1. `UPLOAD_SCANNER_URL` je pouze lokálně otestovaný kontrakt; konkrétní scanner, jeho dostupnost, limity, DPA, aktualizace signatur a alerting musí určit provozní vlastník před produkcí. Bez něj se Office obsah fail-closed nepřijme.
2. Nová tabulka musí být aplikována před novým API. Bez `0098` generický upload selže a nesmí pokračovat bez evidence.
3. Legacy object paths se záměrně neclaimují v ledgeru. Je to rollout kompatibilita, nikoli potvrzení jejich původu nebo čistoty.
4. Karanténa a stavy `pending/failed/stored` nemají v R04 automatickou retenci ani reconciler. Mazání bez inventury je zakázané; dokončí R12.
5. S3/GCS checksum/status metadata nebyla ověřena proti skutečnému produkčnímu provideru. Kód zachovává existující Hetzner checksum workaround.
6. Limit 60 generických uploadů za 15 minut je kompromis pro dávkové fotografie; produkční prahy je nutné měřit a odlišit oprávněný terénní batch od abuse.
7. Historická DB sada není plně izolovaná per file. R14 má dodat opakovatelný ephemeral stack a odstranit cross-suite kontaminaci.
8. Kompletní release gate proběhl před posledním malým rozlišením retryable scanner outage v e-mailových importérech. Toto rozlišení prošlo syntax kontrolou, ale jeho cílený DB test je výslovně odložen do prvního kroku dalšího běhu nebo R14.

## 5. Jednoznačný checkpoint a doporučení

**CHECKPOINT FÁZE 8.8:** R04 je lokálně uzavřen pro nové requesty, uploady, dekompresi, podpisové obrázky, e-mailové přílohy a nové generické object-storage staging/claim workflow. Má pevné limity, fail-closed strukturální validaci, Office scanner/quarantine hook, SHA-256/status provider metadata a durable ledger `0098`. Existující objekty nebyly změněny ani smazány. Nebyl proveden push, deploy, produkční test ani produkční migrace. V tomto spuštění se nepokračuje do FÁZE 8.9 ani FÁZE 9.

- **další fáze:** FÁZE 8.9 – izolovaný řez R05: šifrování trezoru a provozních secretů.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** práce zasáhne kryptografický formát, KMS/master-key vlastnictví, citlivá data, dual-read/write, rotaci, backup recovery a migrační backfill; chyba může nevratně znepřístupnit nebo odhalit zákaznické přístupy, SMTP/IMAP hesla a API klíče.
- **očekávané činnosti:** nejprve uzavřít KMS/DR threat model a inventuru všech plaintext secret fields; navrhnout versioned envelope ciphertext s AAD a externím master key; zavést crypto adapter a fail-closed dual-read/write; přidat canary/tamper/rotation/rollback testy; připravit měřitelný backfill bez plaintext logů/exportu, backup key separation a provozní recovery runbook. Jako první kontrolu zopakovat odložené cílené Gmail/IMAP DB testy v izolovaném PostgreSQL.
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/lib/token-crypto.ts`, vault/device-credential služby a routy, `artifacts/api-server/src/lib/email.ts`, `artifacts/api-server/src/lib/email-import.ts`, email/import/OpenAI/backup settings služby, `lib/db/src/schema/device-credentials.ts`, `email-settings.ts`, `email-import-settings.ts`, `openai-settings.ts`, nové crypto/KMS adaptéry, migrace/rollbacky, bezpečnostní testy a recovery/rotation runbook.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Očekává se aditivní schema migrace a následný citlivý re-encryption backfill; možné jsou dual-read cutover, key rotation a změna záloh. Žádný plaintext se nesmí logovat nebo exportovat a contract/drop starých sloupců nesmí proběhnout bez ověřené obnovy, počtů a rollbacku.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
