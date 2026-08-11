# R13-D9N – warehouse-price offline verifier checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako striktně read-only offline artifact verifier; skutečný staging activation zůstává NO-GO, bez runneru, DB/provider zápisu, očíslované migrace, deploye nebo cutoveru; R13 jako celek NOT READY**

## Výsledek

D9N převádí jednotlivé D9M canonical kontrakty do jednoznačně ověřitelného offline balíku. Přidává:

- canonical lineage sidecar `site-logbook.warehouse-price-bootstrap-lineage-evidence/v1`;
- canonical backup sidecar `site-logbook.warehouse-price-bootstrap-backup-evidence/v1`;
- čisté artifact-set verifiery pro preflight a post-commit receipt;
- jediný read-only CLI `accounting:warehouse-price:bootstrap-activation:verify`;
- canonical secret-free PASS summary `site-logbook.warehouse-price-bootstrap-offline-verification/v1`.

CLI neumí vytvořit approval, autorizaci, preflight ani receipt, nespouští D9L apply primitive a nemá DB, S3, síť, Docker, Coolify ani provider import. Přijímá jen existující lokální raw soubory a dva explicitní trusted entry-point hashe.

## Přesný artifact layout

Preflight režim vyžaduje dedicated adresář s přesně těmito devíti soubory a žádným dalším:

1. `staging-release-evidence.json`;
2. `staging-release-verification.json`;
3. `warehouse-price-bootstrap-lineage-evidence.json`;
4. `warehouse-price-bootstrap-backup-evidence.json`;
5. `warehouse-price-parity-source.json`;
6. `warehouse-price-bootstrap-plan.json`;
7. `warehouse-price-bootstrap-approval.json`;
8. `warehouse-price-bootstrap-apply-authorization.json`;
9. `warehouse-price-bootstrap-activation-preflight.json`.

Receipt režim vyžaduje stejných devět a navíc:

10. `warehouse-price-parity-before.json`;
11. `warehouse-price-parity-after.json`;
12. `warehouse-price-bootstrap-execution-receipt.json`.

Chybějící, přejmenovaný nebo nadbytečný soubor je fail-closed chyba. Adresář i každý soubor musí být non-symlink; čtení ověřuje typ, velikost a nezměněný size/mtime/ctime před a po readu.

## Resource a argument hranice

- každý parity report: nejvýše 256 MiB;
- plan, staging release evidence a receipt: nejvýše 64 MiB;
- každý ostatní JSON: nejvýše 8 MiB;
- celý set: nejvýše 384 MiB před prvním readem;
- soubory se čtou sekvenčně;
- `--artifact-dir` musí být absolutní;
- preflight režim vyžaduje exact trusted `--expected-preflight-file-sha256`;
- receipt režim vyžaduje navíc exact trusted `--expected-receipt-file-sha256`;
- `--activate`, `--apply`, `--execute`, `--backfill`, `--migrate`, `--deploy`, DB/write/delete/update/output aliasy a všechny neznámé argumenty jsou zakázané.

CLI nic nezapisuje na disk. Canonical PASS summary jde pouze na stdout bez trailing newline; chyba jde pouze na stderr a vrací exit code 1.

## Staging release vazba

Existující schema-v4 staging verifier nyní do svého CLI summary přidává `releaseEvidenceFileSha256`, vypočtený z exact raw `staging-release-evidence.json`. D9N vyžaduje:

- summary `schemaVersion=4`, `decision=PASS` a `environmentId=site-logbook-staging`;
- `commitSha` shodný s D9M source SHA;
- exact hash `staging-release-verification.json` uložený v preflightu;
- `releaseEvidenceFileSha256` ze summary shodný s právě čteným raw release evidence souborem i hashem v preflightu.

Tím se PASS output neváže jen na commit, ale i na exact root evidence file. Úplnou semantickou validaci root evidence a jeho osmi raw staging vstupů nadále provádí existující `gate:staging-evidence`; D9N tento velký verifier neduplikuje.

## Lineage a backup sidecary

Lineage a backup sidecar mají vlastní domain-separated integrity hash a strict exact-key schema. D9N současně vyžaduje:

- raw sidecar file SHA shodný s preflightem;
- canonical obsah sidecaru exactně rovný embedded migration-lineage nebo backup summary po odebrání pouze self file-hash pole;
- dvě seřazené opaque legacy identity, žádné domyšlení významu a `0100` exclusion;
- shodný source, target, migration SQL digest, backup ID/digest/size/freshness a všechny D9M hranice.

Přepočtení jen sidecar integrity nebo jen preflight integrity proto nezmění trusted chain bez změny explicitně schváleného preflight file SHA.

## Příkazy budoucího offline ověření

Preflight:

```powershell
pnpm.cmd --filter @workspace/api-server run accounting:warehouse-price:bootstrap-activation:verify -- --mode=preflight --artifact-dir=<absolute-preflight-dir> --expected-preflight-file-sha256=<approved-64-hex>
```

Receipt:

```powershell
pnpm.cmd --filter @workspace/api-server run accounting:warehouse-price:bootstrap-activation:verify -- --mode=receipt --artifact-dir=<absolute-receipt-dir> --expected-preflight-file-sha256=<approved-64-hex> --expected-receipt-file-sha256=<approved-64-hex>
```

Tyto příkazy jsou pouze verifier invocation. Nevytvářejí artefakty a nesmí být zaměněny za budoucí apply nebo migration runner.

## Ověření

- D9M/D9N contract a skutečný CLI process: **12/12 PASS**;
- staging schema-v4 release evidence test: **12/12 PASS**;
- staging runtime-contract test: **27/27 PASS**;
- celý API unit balík: **109/109 souborů, 821/821 PASS**;
- API TypeScript, scoped ESLint, Prettier, API production build, runtime-contract checker a scoped `git diff --check`: **PASS**;
- žádná DB, Docker, síťová, provider, GitHub, Coolify, GHCR, S3, deploy nebo migrační operace nebyla provedena.

## Aktuální NO-GO stav

Repo neobsahuje reálný dvanáctisouborový activation artifact set. Nebyl vytvořen live staging release PASS pro budoucí exact source SHA, integrován aktuální public `main`, vyřešen migration journal, přidělena/aplikována expand migrace ani spuštěn parity audit a approval proces nad skutečnými staging daty. D9N tedy dokáže budoucí set odmítnout nebo ověřit, ale nic neaktivuje.

`0100` zůstává vyloučena. Skutečný staging apply, deploy, migrace, provider/exporter aktivace, feature flags a read/UI cutover jsou nadále samostatné kritické schvalovací hranice.

## Další bezpečný řez

R13-D9O připravil fail-closed artifact-capture runbook a readiness matrix, která přesně určuje původ každého z dvanácti souborů, odděluje trusted expected hashe od pracovního adresáře a definuje abort/cleanup po fresh, replay, rollback, unknown-outcome i partial stavu. Integrace public `main` a skutečné přidělení migrace už jsou materiální změny a musí mít samostatné výslovné schválení.
