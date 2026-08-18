# Checkpoint FÁZE 9 – závěrečné ověření

- **Stav:** dokončeno; auditní FÁZE 0–9 jsou uzavřeny.
- **Ověřovaný baseline:** čistý `5dc93dc` včetně bezpečnostního `7510a9c`.
- **Hlavní výstup:** `docs/audit/08-final-verification.md`.
- **Produkce:** nedotčena; bez produkční DB, secrets, mailu, storage, browser session, deploye nebo push.
- **Celková připravenost:** 62/100; podmíněné `NO-GO` pro neřízený rollout.

## Důkazy

- hermetická release gate: typecheck, 5/5 environment guardů, 127/127 frontend, 15/15 live-events, 286/286 API a oba buildy;
- migrace: 102/102 a 97 tabulek proti snapshotu;
- authorization/session/object/offline DB: 38/38;
- workflow DB: 6/6; rollback 0086–0090 forward/DOWN/forward;
- kritický podpis/token/upload-ledger pack: 26/26;
- mail test-mode pack: 11/11, bez síťového odeslání;
- upload/signature/mail security pack: 48/48;
- offline pack: 49/49 a lokální browser precache reload bez serveru;
- backup/restore: skutečný test nepokračoval bez izolovaného object storage, 5 testů správně přeskočeno;
- celý API DB strom: nezelený, sekvenčně 19 failed testů + 2 failed suites;
- dependency audit: celý graf 17 advisory, produkční graf 1 Moderate;
- lint chybí, peer gate hlásí ZXing rozpor.

## Nevyřešené otázky

- Jsou scheduler lock, work-session overlap a warehouse rematching potvrzené produktové regrese, nebo se změnil authoritative business kontrakt?
- Které legacy time-entry testy mají být migrovány na `work_sessions` a které chování musí zůstat kompatibilní?
- Kdo vlastní RPO/RTO, recovery key custody, nezávislý backup účet a pravidelný restore drill?
- Jaké jsou právně schválené retence, hold/erase hranice a důkazní požadavky?
- Kdy bude dostupný izolovaný PostgreSQL + S3 + SMTP/IMAP full-stack CI?

## Jednoznačný checkpoint

FÁZE 9 skončila vytvořením závěrečné zprávy a tohoto checkpointu. Do produkce se nic nenasadilo a žádná další auditní fáze se automaticky nezahajuje. Necommitnuté uživatelské změny byly zachovány a nebyly zahrnuty do výsledků.

## Doporučení pro další spuštění

- **další fáze:** žádná další auditní fáze; případně samostatná předprodukční stabilizační vlna pro VER-01, VER-02, VER-04, VER-05 a VER-06;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** opravy zasahují souběh, transakce, skladovou integritu, testovací izolaci, dependency graf a obnovu dat;
- **očekávané činnosti:** root-cause diagnostika červených invariantů, per-suite DB/S3/mail harness, úplný restore drill, lint/peer/dependency gate a staging E2E;
- **soubory, které budou pravděpodobně změněny:** `scripts/run-safe-test-db.mjs`, `artifacts/api-server/vitest.db.config.ts`, DB test runner/suites, scheduler a work-session služby, warehouse reconciliation, `package.json`, `pnpm-lock.yaml`, CI workflow a provozní runbooky;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano; DB constraints/locking nebo recovery/outbox práce mohou vyžadovat aditivní migrace a rizikové provozní drilly. Produkční zásah musí mít nový explicitní souhlas, samostatný rollback/forward-fix a nesmí být odvozen z tohoto checkpointu.
