# R13-D9QT – dokončení aktivního transferu

Datum: 2026-08-11  
Aktivní HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`  
D9QR rehearsal tree: `f4c56d4e26e5e40a84eb1dac7382bee5bd32a1d8`  
D9QT combined tree: `9a8581bf1e65b230a5f31493c5241de61fdc5487`  
Stav: **aktivní D9QT transfer bez 0106 dokončen a cíleně ověřen; nic není stageováno, commitnuto, pushnuto ani nasazeno**

## Přenesený rozsah

Transfer proběhl ve dvou uživatelem schválených fail-closed dávkách po 24 cestách. Každý vstupní i výstupní blob byl před zápisem porovnán s přesným D9QT stromem. Při každé dávce existoval automatický rollback na původní aktivní bajty pro případ chyby.

Úplný D9QR diff má 49 `--no-renames` name-status položek:

- 45 výsledných přítomných cest;
- 4 odstraněné konfliktní cesty;
- 0 odchylek aktivního worktree od odpovídajících D9QT blobů;
- jedna z 49 cest, `lib/api-client-react/src/generated/api.ts`, už byla před transferem byte-shodná s kombinovaným výsledkem;
- zbývajících 48 cest bylo přeneseno ve dvou dávkách.

Canonical integrační fingerprint vzniká z 49 řádků `status<TAB>path<TAB>expectedBlob`, seřazených ordinalně podle celého řádku, UTF-8 bez BOM, LF a jedním finálním newline:

- počet řádků: `49`;
- počet bajtů: `4373`;
- SHA-256: `d1173eb36ba53c3458b87436b6730c682c2514e814aa7fecc68a550541f3e1c5`.

Nesouvisející fyzický/stat-cache drift pod `attached_assets/` nebyl součástí D9QR integrace a nebyl změněn.

## Migration lineage

- journal: `105` položek;
- SQL soubory: `105`;
- rozdíl množiny journal tagů a SQL basename: `0`;
- tail: `0105_smooth_nitro`;
- produkční `0096_far_smiling_tiger` je přítomna byte-exact;
- sloučená `0097_session_and_api_idempotency` je přítomna;
- staré neprodukční `0096_daffy_puppet_master` a `0097_api_idempotency_records` SQL i rollback soubory jsou odstraněny;
- `0100` ani `0106` nejsou přítomné.

Hlavní aktivní Git index zůstal před i po transferu přesně:

`89c13526075ef496ca49cd72c41e676566a9a4853a8cdfe33bd695562b487589`

`git diff --cached --quiet` je úspěšný; transfer nic automaticky nestageoval.

## Ověření

- API quote, token a migration kontrakty: `24/24` PASS;
- Stavba quote margin výpočty: `5/5` PASS;
- API TypeScript `--noEmit`: PASS po omezeném buildu DB/Zod deklarací;
- Stavba TypeScript `--noEmit`: PASS po omezeném buildu React API deklarací;
- Orval `8.9.1` + Prettier `3.8.3`: dva po sobě jdoucí běhy vytvořily přesné D9QT SHA všech tří generated výstupů;
- disposable PostgreSQL 16, exact digest, 1 CPU / 768 MiB / 256 PID:
  - všech `105` migrací aplikováno;
  - 7 izolovaných document/public-token DB souborů, `29/29` testů PASS;
  - auth/session/vault/private-object/offline-idempotency/offboarding: `47/47` testů PASS;
  - auth session-generation a idempotency-ledger rollback guardy PASS;
  - samostatný workflow forward/down/forward cyklus PASS;
- external-schema preflight: `22/22` PASS;
- staging runtime mutation suite: `27/27` PASS;
- staging runtime contract: PASS;
- scoped ESLint: PASS;
- scoped Prettier: PASS;
- `git diff --check`: PASS; hlášené LF/CRLF zprávy jsou pouze checkout warningy.

Po testech neběžel žádný Docker kontejner. Poslední kontrola hlásila přibližně `7.68 GiB` volné RAM.

## Zachované hranice

- Nebyl vytvořen commit ani Git ref.
- Neproběhl push, změna PR, private repin/merge, workflow dispatch ani GHCR zápis.
- Neproběhl deploy, změna Coolify, S3/DNS/secretů ani spuštění DB migrace mimo disposable lokální PostgreSQL.
- Produkce nebyla změněna.
- D9QW a migrace `0106_graceful_frog_thor` zůstávají samostatnou navazující integrační a migrační hranicí.

## Checkpoint

D9QT aktivní transfer bez `0106` je dokončen. Další logický celek je přenos a integrace již disposable-ověřeného D9QW/`0106` runtime kandidáta do aktivního worktree, stále nejprve bez commitu, pushnutí, deploye a spuštění migrace. Protože jde o novou skutečnou migraci a runtime control plane, vyžaduje samostatné výslovné schválení.
