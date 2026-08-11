# R13-D9QT – úplná kombinovaná zkouška rozpracovaného worktree a D9QR

Datum: 2026-08-11

Stav: **DISPOSABLE COMBINED REHEARSAL READY / aktivní produkční kód, Git index, remote ani produkce nezměněny**

## Účel

Tento checkpoint ověřuje, že lze bezpečně spojit:

- celý současný rozpracovaný aktivní worktree na `df918a5bbfb786420eba6c48844b632ba139d203`;
- izolovaný D9QR výsledek integrující public `main` a opravenou migration lineage;
- jediný skutečný překryv v OpenAPI a třech generovaných klientech.

Zkouška proběhla výhradně v dočasném worktree `C:\Users\venda\AppData\Local\Temp\site-logbook-d9qt-6f3e9a12`. Aktivní zdrojové soubory, migrace a index nebyly tímto krokem změněny.

## Přesné složení vstupů

Snapshot před vytvořením tohoto checkpointu obsahoval:

- aktivní worktree: 55 tracked změn a 125 untracked souborů;
- D9QR: 49 `name-status` cest při vypnuté detekci rename, což odpovídá 48 Git diff souborům;
- přesně čtyři tracked překryvy:
  - `lib/api-spec/openapi.yaml`;
  - `lib/api-client-react/src/generated/api.schemas.ts`;
  - `lib/api-client-react/src/generated/api.ts`;
  - `lib/api-zod/src/generated/api.ts`;
- nulový překryv mezi aktivními untracked soubory a D9QR cestami.

Automatická kontrola výsledku prokázala:

- všechny aktivní tracked cesty mimo čtyři překryvy jsou obsahově shodné s aktivním worktree;
- všechny D9QR cesty mimo čtyři překryvy jsou obsahově shodné s D9QR staged indexem;
- množina 135 před-stage untracked cest je přesně sjednocením 125 aktivních untracked cest a 10 D9QR additions;
- žádný očekávaný soubor nechybí, žádný neočekávaný soubor nepřibyl a nebyl nalezen žádný hash mismatch.

## Řešení čtyř překryvů

`openapi.yaml` zachovává všechny rozpracované R09–R13/R17/GDPR/work-session endpointy a současně přebírá čtyři D9QR quote schemas:

- interní `rowType` a `purchaseUnitPrice`;
- margin summary v interním `QuoteDetail`;
- section/spacer vstupní pravidla;
- public `rowType` bez purchase cost a margin dat.

Tři klientské výstupy nebyly kopírovány z D9QR. Byly z kombinovaného OpenAPI dvakrát deterministicky regenerovány Orval `8.9.1` a následně normalizovány Prettierem. Druhý raw codegen vytvořil byte-shodný výsledek.

## Obnovitelný kandidát

- HEAD dočasného worktree: `df918a5bbfb786420eba6c48844b632ba139d203`;
- staged rozsah: 224 Git diff souborů, `95483+ / 39555-`;
- status: 134 added, 86 modified, 3 deleted a 1 rename;
- Git tree: `9a8581bf1e65b230a5f31493c5241de61fdc5487`;
- stable patch ID: `1d105b62fdf680b14ee5c53b26c8a4354343fb65`;
- žádný unstaged ani untracked zbytek;
- žádný commit ani ref nebyl vytvořen.

Tento checkpoint soubor sám není součástí uvedeného dočasného tree; tree identifikuje ověřený kombinovaný kód a dosavadní dokumentaci před vytvořením checkpointu.

## Ověření kombinace

- D9 quote/API slice: 6 souborů / 23 testů PASS.
- Migration-lineage contract: 4/4 PASS.
- Změněné accounting contracty: 16 souborů / 89 testů PASS.
- Všechny změněné non-DB API testy: 42 souborů / 300 testů PASS.
- Stavba quote calculations: 5/5 PASS.
- API combined typecheck: PASS.
- Stavba combined typecheck: PASS přes dočasný alias config; config byl po testu odstraněn.
- External-schema preflight: 22/22 PASS.
- Staging runtime contract: PASS.
- Staging runtime mutation suite: 27/27 PASS.
- ESLint nad 164 ručně změněnými TS/TSX/MJS soubory mimo generated výstupy: PASS.
- Disposable PostgreSQL 16, první běh: všech 105 migrací a 20 vybraných DB/API test souborů PASS.
- Disposable PostgreSQL 16, druhý běh: všech 105 migrací a zbývajících 10 změněných integračních/DB test souborů PASS.

Oba PostgreSQL běhy používaly official digest, limit 1 CPU a 768 MiB RAM a byly ukončeny v `finally`. Následná read-only kontrola `docker ps` neukázala žádný běžící kontejner.

## Formátovací stav bez skrytého rozšíření scope

Úplná Prettier inventura našla 20 souborů. Každý z nich je po Git clean-filter porovnání přesně shodný s již existující aktivní změnou, nikoli s novým D9 merge obsahem. Nebyly proto v integrační zkoušce potichu přeformátovány.

`git diff --cached --check` dále hlásí 41 trailing-whitespace markerů ve 30 již existujících aktivních untracked auditních Markdown souborech. Všechny tyto soubory prošly výše uvedenou exact-union kontrolou; nejde o novou D9QT regresi. Celý kombinovaný index proto nelze označit za globálně whitespace-clean, dokud nebude tento samostatný dokumentační dluh vědomě normalizován.

## Bezpečnostní hranice

- Aktivní worktree obdržel pouze tento nový auditní checkpoint, žádný produkční kód ani migraci.
- Neproběhl commit, push, změna PR, private repin/merge, workflow dispatch, GHCR/S3 zápis, deploy, feature flag ani DB migrace.
- `0100` zůstává vyloučena.
- Dvě opaque production-only migration identity zůstávají pouze `legacy_production_only_unknown`; zkouška jim nepřiděluje význam.
- Public `main` byl v tomto pracovním celku read-only potvrzen na `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5`; draft PR #15 zůstává na starém remote headu, takže jeho dřívější CI není důkazem pro tento tree.

## Checkpoint

D9QT dokládá, že plný aktuální rozpracovaný worktree a D9QR lze složit bez ztráty aktivních změn a bez nečekaného souborového překryvu. Technicky bezpečný další krok je přenést přesně tento kombinovaný výsledek do aktivního worktree, stále bez commitu, pushnutí, deploye a spuštění migrací. Protože by tento krok již měnil aktivní produkční zdrojový a migrační strom, zůstává samostatnou výslovnou approval boundary.
