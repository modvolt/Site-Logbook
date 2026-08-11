# R13-D9QR – izolovaná integrační zkouška public main a migration lineage

Datum: 2026-08-11  
Stav: **LOKÁLNÍ DISPOSABLE REHEARSAL READY / AKTIVNÍ VĚTEV NENÍ INTEGROVÁNA; žádný commit, push, deploy, GHCR/S3/produkční DB zápis ani migrace**

## Schválené business hranice

Volby uživatele `1A`, `2A`, `3A` jsou závazné pro navazující R13 implementaci:

- `early_discard` je pouze provozní záznam s omezenou retencí; `reviewed_rejection` zůstává neměnnou R13 evidencí;
- důvod je omezený čitelný text v přístupově chráněném neměnném archivu, nikoli v telemetry, list metadata nebo object key;
- měna je vždy explicitní ISO kód a systém nesmí provádět implicitní ani automatický FX přepočet.

Tento rehearsal tyto volby nemění ani runtime neaktivuje.

## Izolované vstupy

- aktivní pracovní větev zůstala na `df918a5bbfb786420eba6c48844b632ba139d203`;
- produkční/public-main obsah byl reprezentován lokálním proxy commitem `d34f31441318c952588dea2642f06192e24b8cc1`, jehož strom je byte-exact shodný s live `main` `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5` z read-only D9P inventury;
- merge byl proveden pouze v dočasném klonu `C:\Users\venda\AppData\Local\Temp\site-logbook-d9qr-2649a99556fc4f64b2d8805df25ccf43` na větvi `d9qr-rehearsal`;
- dočasná větev stále ukazuje na `df918a5`; výsledek je pouze staged, bez merge commitu a bez remote refu.

## Výsledek konflikt resolution

1. Quote service/UI zachovává lokální immutable public-token/version cestu a současně přebírá produkční `rowType`, section/spacer řádky a margin výpočty.
2. Immutable quote snapshot byl povýšen na schema version 2 a ukládá `rowType`; section/spacer jsou finančně neutrální.
3. Veřejný share a PDF používají snapshotové prodejní hodnoty a nesmějí zveřejnit `purchaseUnitPrice`, purchase cost ani interní margin.
4. OpenAPI byl obnoven do původního repo stylu a obsahuje pouze produkční quote změnu `30+ / 4-`; React/Zod klienti byly regenerovány Orval `8.9.1`.
5. Produkční `0096_far_smiling_tiger.sql` je zachována byte-exact. Její Git blob je na obou stranách `03ba73d5cc38f290d58f561683cef52fa1404241`.
6. Neprodukční lokální session-generation `0096` a API-idempotency `0097` jsou sloučeny v původním pořadí do `0097_session_and_api_idempotency` včetně rollback guardů pro použitou session generation i použitý idempotency ledger.
7. Význam `0098`, `0099`, `0101` až `0105` zůstává zachován. `0100` nebyla vytvořena ani zařazena.
8. Snapshoty `0096` až `0105` byly znovu sestaveny v jediném navazujícím `prevId` řetězci a následně přeformátovány zpět do původního repo JSON stylu, aby se odstranil čistě formátovací šum.

## Přesná kandidátní lineage

- journal: 105 známých položek;
- tail:
  - `0096_far_smiling_tiger` – `1786383352759`;
  - `0097_session_and_api_idempotency` – `1786383360000`;
  - `0098_object-upload-ledger` – `1786383361000`;
  - `0099_secret_envelope_encryption` – `1786383362000`;
  - `0101_public_access_token_lifecycle` – `1786383363000`;
  - `0102_immutable_job_quote_versions` – `1786383364000`;
  - `0103_durable_operational_incident_outbox` – `1786383365000`;
  - `0104_thin_sheva_callister` – `1786383366000`;
  - `0105_smooth_nitro` – `1786383367000`;
- `0100`: explicitně nepřítomna;
- SHA-256 `0096_far_smiling_tiger.sql`: `30b8114934317bd8d9e009716e0bd10cbb00fb647b456bd38ef534cd5c51c995`;
- SHA-256 `0097_session_and_api_idempotency.sql`: `044213e7839f6ef3a1e21eb4fb1c20e647c4aa3bdf3fa4568d5aa6d5391e4f0c`;
- SHA-256 `0104_thin_sheva_callister.sql`: `f35f5d418a7961ed34b5dc23bd563b83bf03cb911c74a0d0dca254f5bfef7e7a`;
- SHA-256 `0105_smooth_nitro.sql`: `a7ecbfc67e2d91885ac554e958d66922246ddc32383271cfc336d075acc31a71`.

Dvě produkční opaque identity zůstávají pouze `legacy_production_only_unknown`; rehearsal jim nepřiděluje název, význam ani code migration.

## Ověření

- Orval `8.9.1`: dva po sobě jdoucí běhy vytvořily stejné SHA-256 pro všechny tři generované výstupy; následně byl pouze normalizován počet EOF newline na existující repo konvenci.
- API kontraktní slice po konečném codegenu: 6 souborů / 23 testů PASS.
- Samostatný migration-lineage contract: 4/4 PASS.
- Stavba quote calculations: 5/5 PASS.
- API TypeScript `--noEmit`: PASS po lokálním buildu relevantních knihovních deklarací.
- Ručně změněný TS/TSX rozsah: Prettier 21/21 souborů PASS; ESLint PASS bez warningu.
- Fresh disposable PostgreSQL 16: všech 105 migrací aplikováno; dokumentové/public-token/quote DB testy 15/15 PASS.
- Druhý disposable PostgreSQL 16: auth/session/vault/private-object/offline-idempotency/offboarding DB suite 45/45 PASS; oba rollback guardy `0097` PASS.
- External-schema preflight: 22/22 PASS.
- Staging runtime contract: normalized-view rehearsal PASS a aktivní-worktree checker PASS.
- `git diff --cached --check`: PASS.

Celý root library build v dočasném klonu nebyl použit jako acceptance gate: zastavil se na temp-only dependency junctionu `lib/object-storage-web` bez lokálního `react` resolution. Relevantní DB/Zod deklarace byly vytvořeny a následný API typecheck prošel; nejde o pozorovanou chybu kandidátního kódu.

## Obnovitelný staged výsledek

- staged rozsah: 48 souborů, `3185+ / 820-` proti `df918a5`;
- Git tree: `f4c56d4e26e5e40a84eb1dac7382bee5bd32a1d8`;
- stable patch ID: `1c8097b30972d5a8c9b099209c672bb4d66c3f70`;
- žádné unstaged tracked soubory;
- žádný commit ani ref nevytvořen.

Dočasná cesta není dlouhodobý archiv. Tree a patch ID slouží k identifikaci výsledku, nikoli jako náhrada za schválený commit v aktivním repozitáři.

## Co ještě není prokázáno

- Není provedena integrace do rozsáhle dirty aktivního pracovního stromu.
- Není proveden upgrade na izolované plné kopii produkční DB se dvěma opaque journal identitami; fresh DB test nedokazuje production-copy upgrade.
- Není zopakován exact-0104 → 0105 backup/restore/schema-v4 release evidence nad budoucím finálním source SHA.
- Není celý hermetic Quality/release gate ani exact-head GitHub CI pro budoucí integrační commit.
- Private caller repin/merge, workflow dispatch, GHCR zápis, staging deploy, feature flag, DB migrace a produkční změna zůstávají samostatnými schvalovacími hranicemi.

## Checkpoint a další bezpečný krok

Disposable integrační návrh je lokálně **READY K REVIEWOVANÉMU PŘENOSU**, nikoli k deployi nebo migraci. Další materiální krok je přenést přesně tento konflikt-resolution a lineage rebuild do aktivní větve, zachovat všechny současné necommitnuté R09–R13/R17 změny a znovu spustit cílené i celé lokální gate. To vyžaduje výslovné schválení změny aktivního produkčního kódu a migračních souborů; commit a push zůstávají ještě samostatně.
