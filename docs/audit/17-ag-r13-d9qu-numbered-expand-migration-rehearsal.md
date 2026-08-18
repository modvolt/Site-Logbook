# R13-D9QU – izolovaná zkouška číslované expand-only migrace 0106

Datum: 2026-08-11

Stav: **DISPOSABLE MIGRATION REHEARSAL READY / NENÍ RELEASE READY / aktivní produkční kód, Git index, remote ani produkce nezměněny**

## Účel

Tento checkpoint materializuje dosud šablonové R13 účetní evidence do skutečného forward-only kandidáta migrace. Zkouška proběhla výhradně nad přesným kombinovaným D9QT stromem v dočasném worktree. Aktivní worktree neobdržel produkční kód ani migraci.

Business kontrakt zůstává podle schválených rozhodnutí:

- `early_discard` má omezenou retenci, `reviewed_rejection` má immutable evidenci;
- důvod může být lidsky čitelný, ale pouze v omezeném immutable archivu;
- měna je vždy explicitní ISO kód a automatický FX přepočet není dovolen.

## Výchozí přesný strom

- HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`;
- D9QT base tree: `9a8581bf1e65b230a5f31493c5241de61fdc5487`;
- D9QT stable patch ID: `1d105b62fdf680b14ee5c53b26c8a4354343fb65`;
- hlavní index disposable worktree zůstal po celou zkoušku přesně na D9QT base tree.

## Generování a identita migrace

Drizzle Kit `0.31.10` při prvním pokusu odhalil reálný generační blocker: JavaScript `bigint` výchozí hodnota `.default(0n)` v `accounting_aggregate_heads.revision` nebyla JSON serializovatelná. V disposable kopii byla nahrazena sémanticky shodným SQL defaultem `.default(sql\`0\`)`.

Poté byl deterministicky vygenerován kandidát:

- migrace `lib/db/migrations/0106_graceful_frog_thor.sql`;
- snapshot `lib/db/migrations/meta/0106_snapshot.json`;
- journal entry `idx=106`, `when=1786459128910`, `tag=0106_graceful_frog_thor`;
- rollback `lib/db/rollbacks/0106_graceful_frog_thor.down.sql`.

Druhé spuštění Drizzle Kit skončilo přesně `No schema changes, nothing to migrate`.

`0100` zůstává vyloučena: neexistuje soubor s prefixem `0100` ani journal tag `0100`.

## Migrační obsah

Vygenerovaná část a schválený trigger tail dohromady vytvářejí:

- 9 účetních evidence tabulek;
- 5 databázových funkcí;
- 13 triggerů;
- 114 tabulek v úplném výsledném Drizzle snapshotu.

Immutable trigger tail od `deny_accounting_evidence_mutation()` je bajtově shodný se schválenou šablonou `docs/audit/17-f-r13-accounting-evidence-expand.template.sql`.

Hash evidence:

- migrace SHA-256: `697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd`;
- rollback SHA-256: `281853c600cd0a92dd6713bdc4e64cfa143f767c501770b8e8bc6503cda2fab3`;
- snapshot SHA-256: `32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24`;
- journal SHA-256: `c2858e82efb604968cf65ae9c0aec199146201927d44cf22fe068792c83b04c1`.

## Testovací přechod a rollback

Disposable PostgreSQL 16 běžel pouze na loopbacku, s limitem 1 CPU, 1 GiB RAM, 1 GiB memory-swap a 256 PID. Runner vytvořil pro každý soubor oddělenou databázi a po běhu kontejner odstranil.

Výsledek:

- všech 106/106 migrací aplikováno, tail `0106_graceful_frog_thor`;
- 14/14 izolovaných DB/API testovacích souborů PASS;
- celkem 55/55 testů PASS;
- API TypeScript `--noEmit` PASS;
- Prettier, ESLint a `git diff --check` nad změnami 0106 PASS.

Rollback je záměrně úzký:

- nad prázdnými devíti tabulkami odstraní schéma a přesný Drizzle journal row `created_at=1786459128910`, čímž vrátí lineage na 105;
- jakmile existuje jediný účetní evidence row, rollback se fail-closed odmítne a vyžaduje roll-forward recovery;
- oba scénáře jsou samostatně vykonané DB testy.

## Přesný rozšířený kandidát

Alternativní jednorázový Git index, založený na D9QT base tree, vytvořil:

- extended tree: `1737fb41cb13aff7c637e5c5ca6ede1b6a73003c`;
- stable patch ID vůči D9QT: `fc4488743d6353ba568af450f194406481b41a02`;
- 20 změněných cest;
- 4 nové migrační artefakty, 3 nové testovací/helper soubory a 13 úzkých úprav schema/kontrakt/test cest.

Dočasný alternativní index byl po výpočtu odstraněn. Nebyl vytvořen commit ani Git ref.

## Důležitá release hranice

Kandidát je **migration-ready proti čisté disposable DB**, ale není připraven k zařazení do současného staging/release toku:

- současný external schema gate a release evidence vyžadují přesně 105 migrací a tail `0105_smooth_nitro`;
- současný přechod je navržen jako jediný krok `0104 -> 0105`;
- image obsahující 0106 by z baseline 0104 mohla aplikovat 0105 a 0106 společně, čímž by porušila exact-one-migration gate a zneplatnila již navržený evidence chain.

Proto se 0106 nesmí potichu přidat do prvního D9QT transferu ani do současné 0105 aktivace.

## Doporučená posloupnost

1. Přenést a samostatně ověřit přesný D9QT kombinovaný výsledek **bez 0106**.
2. Dovést tento zdroj přes existující exact-0105 CI, staging a produkční release hranice.
3. Teprve poté připravit nový exact přechod `0105 -> 0106`, jeho evidence schema, staging gate a kandidátní image.
4. Zařadit již ověřený 0106 strom až v tomto druhém, samostatně schváleném releasu.

## Bezpečnostní hranice

- Aktivní worktree obdržel pouze tento auditní checkpoint.
- Neproběhl commit, push, změna PR, private repin/merge, workflow dispatch, GHCR/S3 zápis, deploy, feature flag ani produkční DB migrace.
- Produkční journal ani opaque production-only identity nebyly změněny ani nově interpretovány.
- Přenos D9QT produkčního kódu a pozdější zařazení 0106 zůstávají dvě oddělené kritické approval boundary.

## Checkpoint

R13-D9QU dokládá, že účetní expand schema lze bezpečně a deterministicky materializovat jako forward-only migraci 0106 a že její prázdný rollback i data-preserving rollback guard fungují. Současně prokazuje, že 0106 nesmí být spojena s existující exact-0105 aktivací. Nejbližší bezpečný aktivní krok je přenos exact D9QT výsledku bez 0106; změna aktivního produkčního stromu vyžaduje výslovné schválení.
