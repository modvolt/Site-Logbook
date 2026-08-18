# R13-D9QW — exact-0105 backup a účetní 0106 runtime rehearsal

Datum checkpointu: 2026-08-11  
Výchozí commit disposable worktree: `df918a5bbfb786420eba6c48844b632ba139d203`  
Stav: **READY pouze jako izolovaný rehearsal; není commit, push, deploy ani migrace produkce**

## Rozhodnutí vlastníka

Tento řez zachovává schválený kontrakt:

1. `early_discard` používá omezené uchování, zatímco `reviewed_rejection` zůstává neměnnou účetní evidencí;
2. čitelný omezený důvod smí být pouze v přístupově omezeném neměnném archivu, nikoli v telemetry, list metadata ani object key;
3. měna je vždy explicitní ISO kód a systém neprovádí implicitní FX přepočet.

Migrace `0100` zůstává vyloučená. Neprůhledné produkční journal řádky nejsou přejmenovány ani jim není domýšlen význam.

## Dokončený izolovaný řetězec

Disposable strom nyní obsahuje:

- pinned expand-only migraci `0106_graceful_frog_thor` a guarded empty-only rollback;
- exact-0105 schema preflight, který odmítá `0100`, `0106`, accounting rows a aktivní externí účty;
- one-shot vytvoření nové šifrované exact-0105 zálohy a non-destructive restore-testu se stropem 256 MiB a bez retention prune;
- kanonický binding, který odvodí nový inspect artifact s čerstvým backup ID a sváže jej s exact source SHA, API digestem, provisioningem a migrací 0106;
- one-shot 0106 runner s durable intentem, explicitním příkazem, kontrolou resolved Compose a stejným živým PostgreSQL kontejnerem na všech hranicích;
- fail-closed recovery: první `NOOP` je odmítnut, opakovaný `NOOP` je přijat jen se shodným již uloženým intentem;
- samostatný offline verifier, který znovu hashově a sémanticky ověří transition, inspect, exact-0105 backup execution a finální 0106 execution bytes;
- normální API startup čekající na obě read-only steady gate: external schema přijímá pouze exact 0105 nebo přesně připnuté pokračování 0106, accounting gate vyžaduje exact 0106;
- žádný S3 write surface v accounting schema gate a žádné automatické startup migrace.

Routine runtime limit po přidání privátní accounting gate je přesně `3.00 CPU`, `3200 MiB` hard memory a `1984 MiB` reservations. One-shot exact-0105 backup je profilový a do routine součtu se nezapočítává.

## Přesné identity

- migrace 0106 SHA-256: `697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd`;
- rollback SHA-256: `281853c600cd0a92dd6713bdc4e64cfa143f767c501770b8e8bc6503cda2fab3`;
- snapshot 0106 SHA-256: `32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24`;
- journal SHA-256: `d59722d0bc23fb0f3fd13f960f83f585a1b32c6e9c1c4efb6468e1de5d535100`;
- binding SHA-256: `2ff09b5bf30d16f04e18bc8399cd371f996f7314495882f1ef395b47f92364df`;
- exact-0105 backup runner SHA-256: `9fea4a0bf7cb79a62682eda17697fb33582bc7ae8f76b9d9cfd6f150ff66241b`;
- 0106 transition runner SHA-256: `b8ab23285206f50c24530c2d94c7b0e8ae48f226ac016cf8a41e4931b8b1c09b`;
- offline execution verifier SHA-256: `3c052c61594c1008987a87f820a7e897ac30c901090756063d252920aa9d8649`;
- Compose SHA-256: `6bdf0e00c3c8707106dca0fcae60d1cfc89517c2afe518311ab86814d4582720`.

Alternativní Git index odvozený z přesného D9QT stromu
`9a8581bf1e65b230a5f31493c5241de61fdc5487` vytvořil:

- D9QW strom `57ffc0ac6cb1e46cd20c376ac9f09729cb3b7b04`;
- stable patch-id `0f727122cb59feed0404f957d10151231ee4496d`;
- rozsah 49 souborů, `27013` vložení a `207` odstranění proti D9QT;
- hlavní D9QT index zůstal před i po fingerprintu přesně
  `7e8d3bab20c219e944f522e3f0c795da0d4bd92fa9a094e8c1e33a36289d21ad`.

Nevznikl commit, tag ani ref.

## Ověření

- runtime/binding/verifier Node testy: `48/48 PASS`;
- external + accounting DB unit testy: `32/32 PASS`;
- API accounting gate a exact-0105 backup unit testy: `8/8 PASS`;
- API a DB TypeScript `--noEmit`: PASS;
- API build včetně accounting entrypointů: PASS;
- cílený ESLint: PASS;
- Prettier a `git diff-tree --check`: PASS;
- read-only `docker compose config`: PASS; accounting gate má 0.25 CPU / 384 MiB, závisí jen na preflight+Postgres a nemá S3 proměnné; API čeká i na accounting gate;
- disposable PostgreSQL 16: `106/106`, guarded rollback na exact 0105, inventory `READY_0105`, právě jedna forward migrace, accounting steady `ALREADY_0106` a external steady `ALREADY_0106`: `1/1 PASS`;
- disposable PostgreSQL kontejner byl omezen na 1 CPU / 1.5 GiB / 256 PID, při ukončení používal přibližně 97 MiB a byl odstraněn.

## Bezpečnostní hranice a nehotové části

- Aktivní produkční kód nebyl tímto checkpointem změněn; aktivní worktree dostal pouze tento dokument.
- Produkční Coolify, DB, S3, DNS, secrets a migration journal nebyly čteny ani měněny.
- `0106` není zařazena do aktivního D9QT transferu a nesmí se spustit bez samostatného schválení.
- Offline verifier pouze potvrzuje způsobilost evidence k samostatnému schválení startu staging aplikace; sám nespouští API, deploy ani migraci.
- R09–R13/R17 jako celé workstreamy zůstávají `NOT READY`; tento checkpoint uzavírá jen schema/runtime základ budoucího účetního řezu.

## Další větší část

1. Samostatně schválit přenos již zmrazeného D9QT základu do aktivní větve **bez 0106**.
2. Znovu ověřit aktivní diff a cílené testy, vytvořit commit a non-force push až po zvláštním schválení.
3. Teprve následně samostatně přenést a reviewovat 49-souborový D9QW strom s 0106.
4. Po exact-head zeleném CI připravit staging-only aktivaci: exact-0105 backup, binding, one-shot 0106, offline verification, oddělený start aplikace a smoke.
5. Produkční deploy a produkční migrace zůstávají další samostatnou rizikovou hranicí.

Pro další běh je vhodný **GPT-5.6 Sol, xhigh**: půjde o konfliktně citlivý Git přenos, migraci, důkazní řetězec a oddělení staging/produkce. Pravděpodobně se budou měnit soubory vyjmenované v tomto checkpointu; další fáze může obsahovat migraci `0106`, ale pouze po explicitním schválení a nejprve mimo produkci.
