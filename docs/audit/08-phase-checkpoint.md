# Checkpoint FÁZE 8.9 – dokončení R05

- **Stav:** FÁZE 8.9 dokončena lokálně. Aplikační šifrování uložených secretů, měřený backfill a šifrování nových DB záloh jsou implementované; FÁZE 9 nebyla zahájena.
- **Výchozí revize:** `c7cd420` (`main`; lokální checkpoint FÁZE 8.8).
- **Implementační revize:** `5d1b041` (`security: encrypt stored secrets and database backups`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz`, vzdálený Git, push ani deploy.
- **Databázová změna:** expand-only migrace `0099_secret_envelope_encryption`; nebyla aplikována do produkce ani do existující sdílené databáze.
- **Provozní dokument:** [08-secret-encryption-runbook.md](08-secret-encryption-runbook.md).

## 1. Uzavřená lokální architektura R05

### Versioned envelope a key custody hranice

Nový formát `mve1` používá pro každou hodnotu náhodný 256bitový datový klíč, AES-256-GCM s 12bytovým IV a AAD svázané s tabulkou, ID řádku a polem. Datový klíč se samostatně zabalí aktivním externím KEK. Envelope nese verzi a key ID, takže podporuje současné čtení více klíčů a měřenou rotaci. Parser omezuje velikost hlavičky, odmítá neplatné key ID, neznámý klíč, zkrácený/tampered payload i neplatný autentizační tag.

Keyring je načítán pouze z `SECRET_ENCRYPTION_KEYRING` a `SECRET_ENCRYPTION_ACTIVE_KEY_ID`; přijímá jen kanonické Base64 hodnoty přesně 32 bajtů. Heslový/hash fallback byl odstraněn. Chybějící nebo chybný keyring blokuje nové zápisy a aplikační vrstva vrací bezpečnou 503 bez zveřejnění kryptografického detailu. Tato implementace vytváří přísnou externí secret-provider hranici, ale sama není KMS/HSM: konkrétní produkční provider, custody a disaster-recovery vlastník zůstávají provozním rozhodnutím.

### Pokryté hodnoty a kompatibilita

| Oblast | Nový stav | Legacy přechod |
|---|---|---|
| `device_credentials` | jeden row-bound encrypted payload pro přístupové údaje, uživatele a topologii | čtení původních sloupců; backfill je po zašifrování nulová/čistí |
| SMTP / IMAP | encrypted password + key ID + timestamp | plaintext čten pouze pokud envelope chybí |
| OpenAI | encrypted API key + key ID + timestamp | plaintext čten pouze pokud envelope chybí |
| Gmail OAuth | `mve1` refresh token svázaný s ID účtu | starý AES-GCM formát přes `TOKEN_ENCRYPTION_KEY` pouze pro čtení |
| QR rozvaděče | `mve1` token svázaný s ID rozvaděče | starý `v1` formát pouze pro čtení |
| DB zálohy | celý `pg_dump -Fc` se šifruje před object storage; hash se počítá z ciphertextu | staré řádky bez encryption metadata zůstávají čitelné |

Nové secret zápisy jsou encrypted-only. Vynechaná write-only hodnota zachová existující secret, prázdný řetězec jej explicitně smaže. Device create nejprve získá ID řádku a ve stejné transakci uloží AAD-bound envelope. Serializéry nevracejí ciphertext ani nová metadata klientovi.

Zálohy mají oddělený `BACKUP_ENCRYPTION_KEYRING`; aplikační a backup klíče se nesmějí znovu použít. Pokud backup keyring chybí, záloha selže ještě před `pg_dump` a vytvořením běžícího DB záznamu. Restore, restore-test a download nejprve ověří hash uložených bajtů a u `mve1` autentizovaně dešifrují. Legacy nešifrovaná záloha se během rollout okna stále načte, ale encrypted záznam nikdy nespadne zpět na raw bytes.

### Backfill, rotace a rollback

`secrets:backfill` je ve výchozím stavu dry-run a vypisuje pouze názvy kategorií a počty. Zápis vyžaduje současně `--execute`, `--confirm=ENCRYPT_SECRETS` a přesnou shodu `--database` s názvem v `DATABASE_URL`. Legacy hodnoty i envelopes se starým key ID přešifruje v jedné DB transakci; při chybě nezůstane poloviční cutover. Počet řádků musí provoz předem posoudit, protože současný nástroj není dávkovaný.

Rollback `0099` je možný pouze před prvním encrypted zápisem. Jakmile encrypted data existují, down migrace se úmyslně zablokuje; bezpečný postup je obnova správného keyringu a roll-forward, nikoli export do plaintextu. Staré klíče se smějí odstranit až po nulových počtech odkazů a ověřené obnově. Staré backup klíče musí zůstat po celou podporovanou retenci odpovídajících záloh.

## 2. Provedené kontroly

### Hermetická a statická brána

- v čistém izolovaném klonu prošel API typecheck a production build;
- finální hermetický API unit gate bez `DATABASE_URL` a `TEST_DATABASE_URL`: **37/37 souborů, 257/257 testů**;
- kryptografické testy pokrývají round-trip, row/field AAD, tamper, zkrácenou hlavičku, neznámý/odebraný klíč, rotaci, přísnou validaci keyringu, oddělenou binary backup envelope a legacy Gmail čtení;
- QR sada pokrývá row-bound AAD, tamper a legacy `v1` čtení;
- `git diff --check` prošel pro celý logický R05 commit;
- tracked manifesty ani lockfile nebyly testovacími Windows bindingy změněny. Lokální preexistující external-store junction byl po nedokončeném pnpm relinku obnoven a `tsc`/`vitest` entrypointy jsou znovu dostupné.

### Izolovaný PostgreSQL 18

- migration smoke prošel přes celý dostupný řetězec **101/101** migrací, včetně `0099`; snapshot ověřil nové sloupce a constraints R05;
- prázdný rollback `0099` odstranil secret sloupce; rollback nad řádkem s encrypted hodnotou skončil očekávaně nenulově a ciphertext zachoval;
- `secret-persistence.db.test.ts`: **3/3** – zařízení, SMTP, IMAP a OpenAI se ukládají bez legacy plaintextu, tamper selže uzavřeně;
- Gmail import se mocked Google/storage: **18/18**;
- vault authorization/regrese s test-only backup trigger secretem: **10/10**;
- backfill canary: dry-run naplánoval SMTP 1, IMAP 1, OpenAI 1; potvrzený běh aktualizoval 1/1/1, SQL ověřilo legacy `NULL` a prefix `mve1`, následný dry-run vrátil 0/0/0.

Do migration smoke se kvůli souběžné práci propsala také uživatelská lokální migrace `0100_user_ui_preferences`; není součástí commitu R05. Journal byl ve stagingu rozdělen přesně: commit `5d1b041` obsahuje pouze záznam `0099`, zatímco `0100` a redesign změny zůstaly nedotčené v pracovním stromu.

## 3. Nejasnosti a zbytková rizika

1. Repozitář nevolí konkrétní KMS/HSM/secret-manager provider. Environment keyring chrání samotný DB dump, ale kompromitovaný API host nebo účet, který čte jeho prostředí, může secrets stále získat. Před produkcí je nutné schválit custody, emergency access, audit a DR.
2. Produkční počty a velikost backfillu nejsou známy, protože produkční DB nebyla čtena. Nástroj používá jednu transakci; při neočekávaném objemu se rollout musí zastavit a rozdělit na bezpečné dávky v samostatném řezu.
3. Lokálně byl otestován crypto backup payload a všechny read/write větve typecheckem/buildem, nikoli úplný skutečný `pg_dump → object storage → pg_restore` drill. Ten patří do FÁZE 9 a musí běžet pouze v izolovaném prostředí.
4. Produkční rotace, ztráta klíče a emergency recovery nebyly simulovány se zvoleným providerem. Odebrání klíče bez nulového počtu odkazů by data znepřístupnilo.
5. Legacy sloupce a legacy reader zůstávají záměrně přítomné. `TOKEN_ENCRYPTION_KEY` se nesmí odstranit před úspěšným backfillem a funkčními canary testy; contract/drop migrace není součástí této fáze.
6. Nové backup objekty jsou aplikací šifrované, ale provider-side verze, off-site kopie, účetní izolace, object manifest a kompletní RPO/RTO stále náleží R08.
7. Kompletní lint, frontend/PWA, offline, upload/download, podpis, testovací e-mail a integrovaný restore gate nebyly v R05 opakovány; jsou explicitním rozsahem FÁZE 9.

## 4. Jednoznačný checkpoint a doporučení

**CHECKPOINT FÁZE 8.9:** R05 je lokálně implementačně uzavřen pro trezor zařízení, SMTP, IMAP, OpenAI, Gmail refresh tokeny, QR tokeny a nové databázové zálohy. Nové zápisy používají versioned authenticated envelope s row/field AAD a externím keyringem; legacy data lze bezpečně přečíst a měřeně přešifrovat. Produkční KMS/custody rozhodnutí, migrace, backfill, rotace, backup restore drill, push a deploy nebyly provedeny. Souběžné redesign změny včetně migrace `0100` nebyly zahrnuty do R05 commitu. V tomto spuštění se nepokračuje do FÁZE 9.

- **další fáze:** FÁZE 9 – závěrečné integrované ověření a dokument `docs/audit/08-final-verification.md`.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** finální gate musí propojit bezpečnost, autorizaci, migrace, souběh, PWA/offline, dokumenty, podpis, e-mail a skutečný backup/restore bez zaměnění izolovaného testu za produkční důkaz; selhání může odhalit regresi napříč dosavadními řezy.
- **očekávané činnosti:** spustit typecheck, lint, unit, integrační a bezpečnostní testy, build, celý migration/rollback smoke, základní workflow, PWA offline, upload/download, podpis, testovací e-mail a izolovaný `pg_dump → encrypted object → pg_restore`; každou neproveditelnou kontrolu zdokumentovat s důvodem, rizikem a ručním postupem; vytvořit evidence-based finální skóre a manažerské shrnutí.
- **soubory, které budou pravděpodobně změněny:** primárně nový `docs/audit/08-final-verification.md` a aktualizace checkpointu/centrálního registru. Produkční kód se nemá měnit, pokud gate neodhalí konkrétní blocker; případná oprava musí být cílená, otestovaná a v samostatném logickém commitu.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano, ale pouze jako izolované testování již připravených migrací a destruktivního restore v dočasném prostředí. Produkční migrace, backfill, rotace, práce s reálnými secrets, push a deploy nejsou automaticky autorizovány. Nová opravná migrace je možná jen při prokázaném blockeru a musí mít vlastní rollback a checkpoint.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
