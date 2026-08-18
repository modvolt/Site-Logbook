# R13-D9QW – aktivní transfer preflight

Datum: 2026-08-11  
Aktivní HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`  
D9QT base tree: `9a8581bf1e65b230a5f31493c5241de61fdc5487`  
D9QW target tree: `57ffc0ac6cb1e46cd20c376ac9f09729cb3b7b04`  
Stav: **read-only preflight dokončen; D9QW/0106 zatím nebyly přeneseny**

## Úplný rozsah

Manifest byl odvozen přímo jedním úplným `git diff-tree --no-renames` mezi přesnými D9QT a D9QW stromy. Nejde o omezenou podmnožinu pracovního stromu.

- celkem `49` cest;
- `22` přidání;
- `27` náhrad;
- `0` odstranění;
- `27013` vložení a `207` odstranění;
- stable patch ID `0f727122cb59feed0404f957d10151231ee4496d`.

Úplný fail-closed manifest `status<TAB>path<TAB>beforeBlob<TAB>afterBlob` je uložen v `17-am-r13-d9qw-active-transfer-manifest.tsv`:

- řádků: `49`;
- UTF-8 bez BOM, pouze LF, jeden finální newline;
- bajtů: `6154`;
- SHA-256: `6659e2cb5f7414cdb98959bb5972d562236df1b777a20d0415a6a38934645222`.

## Aktivní preconditions

Každá z 49 aktivních cest byla obsahově porovnána s `beforeBlob` z přesného D9QT stromu:

- precondition failures: `0`;
- všech 22 budoucích přidání je nyní nepřítomných;
- všech 27 budoucích náhrad je nyní přesně na D9QT blobu;
- `lib/db/migrations/0106_graceful_frog_thor.sql` není v aktivním worktree přítomna;
- aktivní Git index zůstává `89c13526075ef496ca49cd72c41e676566a9a4853a8cdfe33bd695562b487589`;
- `git diff --cached --quiet` je úspěšný.

Preflight změnil pouze tento checkpoint a jeho TSV manifest. Produkční kód, migrace, Git index, commit, ref ani vzdálený stav nebyly změněny.

## Exact-tree source archive rehearsal

Samostatný read-only rehearsal načetl všech 49 cest z kanonického TSV, vytvořil
dočasný ZIP přímo z D9QW Git stromu a po rozbalení znovu ověřil každý Git blob:

- archivované regular files: `49`;
- chybějící nebo nadbytečné cesty: `0`;
- blob mismatch: `0`;
- symlink/reparse point: `0`;
- součet payload bajtů: `1503211`;
- největší soubor: `lib/db/migrations/meta/0106_snapshot.json`, `582274` bajtů;
- dočasný ZIP: `247573` bajtů;
- vstupní manifest SHA-256: `6659e2cb5f7414cdb98959bb5972d562236df1b777a20d0415a6a38934645222`.

Dočasný archiv i rozbalená kopie byly po ověření odstraněny. Aktivní worktree
ani Git index tento rehearsal nezměnil.

## Obsah budoucího transferu

D9QW přidává a váže zejména:

- forward-only migraci `0106_graceful_frog_thor`, snapshot a guarded rollback;
- accounting-schema inventory, exact-0105 encrypted backup/restore-test a steady gate;
- canonical 0106 binding, one-shot transition runner a offline execution verifier;
- D9QW rozšíření external-schema steady gate;
- Compose účetní gate a API dependency;
- provisioning/runtime resource contract a navazující testy;
- DB testy prázdného rollbacku, data-preserving rollback guardu a 0106 transition/recovery.

`0100` zůstává vyloučena. Samotný přenos `0106` pouze přidá zdrojový a migrační kandidát; nesmí spustit migraci.

## Fail-closed přenosový postup po schválení

1. Znovu ověřit HEAD, hlavní index a všech 49 `beforeBlob` hodnot proti TSV manifestu.
2. Extrahovat pouze 49 cílových cest přímo z přesného D9QW Git stromu, nikoli z jeho později měněné pracovní kopie.
3. Před zápisem vytvořit dočasnou obnovovací kopii všech 27 nahrazovaných cest.
4. Přenést 22 přidání a 27 náhrad; při jakékoli chybě celou dávku automaticky vrátit.
5. Ověřit všech 49 `afterBlob` hodnot, nezměněný hlavní index a nulový cached diff.
6. Ověřit migration parity `106/106`, tail `0106_graceful_frog_thor`, nepřítomnost `0100` a přesné migration/rollback SHA.
7. Spustit cílené runtime/binding/verifier, DB unit, API unit, typecheck, build, lint, formát a constrained disposable PostgreSQL rollback/forward testy.

Commit, push, private repin/merge, workflow dispatch, GHCR/S3 zápis, deploy a spuštění migrace zůstávají samostatné approval boundary.

## Checkpoint

D9QW je připraven k přesně ohraničenému aktivnímu transferu, ale tento krok obsahuje skutečný nový migrační soubor `0106` a runtime control plane. Aktivní zápis proto čeká na samostatné výslovné schválení uživatele.
