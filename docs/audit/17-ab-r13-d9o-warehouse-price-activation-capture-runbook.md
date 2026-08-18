# R13-D9O – warehouse-price activation capture a abort runbook

Datum: 2026-08-11  
Stav: **lokálně READY jako fail-closed capture/readiness/abort specifikace; není to povolení ani návod ke spuštění DB migrace nebo bootstrap apply a současný staging run je NO-GO**

## Účel a hard hranice

Tento runbook určuje, odkud musí vzniknout každý D9N soubor, co je trusted entry point a jak postup zastavit při neúplném nebo nejasném stavu. Neimplementuje chybějící capture/apply runner a neopravňuje:

- integraci public `main`, přidělení či spuštění migrace;
- vytvoření nebo změnu Coolify resource, DB, S3, GHCR, DNS či secretu;
- zapnutí accounting feature flagů, workeru, provideru nebo read/UI cutoveru;
- bootstrap nad produkčním targetem;
- automatický retry po nejasném nebo částečném výsledku.

Povolený budoucí target je pouze logical environment `site-logbook-staging`, exact předem schválený source SHA a staging production-copy-restricted boundary. `productionTargetsTouched` musí být vždy `false` a `0100` zůstává vyloučena.

## Stavová brána

| Brána             | Požadovaný důkaz                                                               | Aktuální stav 2026-08-11                                            |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Public source     | current `main` integrován bez nevyřešeného konfliktu                           | **BLOCKED / D9P ověřil 5 souborů a 10 bloků; integrace neproběhla** |
| Migration lineage | code/applied tag set exact, dvě opaque identity zachované, žádný unknown drift | **BLOCKED / D9P uložil forward-only plán; rebuild neproběhl**       |
| Expand migration  | nové schválené číslo mimo `0100`, exact SQL hash, applied on staging           | **BLOCKED / číslo nebylo přiděleno**                                |
| Staging release   | schema-v4 root + osm raw vstupů + PASS verification exact source SHA           | **BLOCKED / budoucí artefakty neexistují**                          |
| Backup/recovery   | exact target, completed backup, passed restore, fresh a ≤256 MiB               | **BLOCKED / budoucí artefakt neexistuje**                           |
| Source parity     | read-only canonical parity report nad exact staging snapshotem                 | **BLOCKED / skutečný audit nebyl spuštěn**                          |
| Plan              | canonical REVIEW, >0 candidates, 0 blockers, explicit cap                      | **BLOCKED / skutečný plán neexistuje**                              |
| Approval          | raw canonical schválení unknown-history/no-FX exact plánu                      | **BLOCKED / skutečné schválení neexistuje**                         |
| Authorization     | D9L authorization exact raw approval/report/plan/target                        | **BLOCKED / skutečná autorizace neexistuje**                        |
| Preflight         | D9M READY a D9N preflight verifier PASS                                        | **BLOCKED / skutečný set neexistuje**                               |
| Apply orchestrace | reviewed host runner s caller-owned transaction a commit outcome               | **BLOCKED / runner záměrně neexistuje**                             |
| Receipt           | source/before/after + committed outcome, D9N receipt verifier PASS             | **BLOCKED / bez apply nemůže existovat**                            |

Dokud není každá brána doložená přes exact raw bytes a samostatně schválený hash, výsledkem je `NO-GO`. „Soubor existuje“ nebo „testy kontraktu prošly“ není aktivační důkaz.

## Původ a vlastník dvanácti souborů

| Soubor                                                | Jediný přípustný původ                                                           | Co musí být ověřeno před zařazením                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `staging-release-evidence.json`                       | schema-v4 staging evidence producer po exact-SHA smoke/recovery                  | root schema 4, osm raw artifact hashů, source/target/approval/recovery invarianty                    |
| `staging-release-verification.json`                   | stdout `gate:staging-evidence` nad právě zařazeným rootem a osmi raw vstupy      | PASS, exact commit/environment a `releaseEvidenceFileSha256` stejného root souboru                   |
| `warehouse-price-bootstrap-lineage-evidence.json`     | budoucí reviewed capture helper z read-only code/applied journal inventury       | canonical sidecar, 2 opaque identity hashe, equal known sets, planned tag/SQL hash, `0100` exclusion |
| `warehouse-price-bootstrap-backup-evidence.json`      | budoucí reviewed capture helper z již strictně ověřeného staging backup evidence | canonical sidecar, target/ID/digest/size/timestamps/max-age shodné s release boundary                |
| `warehouse-price-parity-source.json`                  | `accounting:warehouse-price:parity-audit` v `REPEATABLE READ READ ONLY`          | exact target fingerprint, REVIEW, pouze `legacy_only` candidates a žádný blocker                     |
| `warehouse-price-bootstrap-plan.json`                 | `accounting:warehouse-price:bootstrap-plan` nad exact source reportem            | canonical REVIEW, exact report file hash, bounded candidates                                         |
| `warehouse-price-bootstrap-approval.json`             | budoucí explicitní operator approval capture                                     | exact confirmation, user/time, unknown-history/no-FX, žádné DB/deploy oprávnění                      |
| `warehouse-price-bootstrap-apply-authorization.json`  | budoucí reviewed authorization capture nad exact approval/report/plan            | D9L confirmation a všechny semantic/raw hashes                                                       |
| `warehouse-price-bootstrap-activation-preflight.json` | budoucí D9M preflight capture až po všech předchozích PASS                       | READY, exact source/target/lineage/backup/release a apply runner stále false                         |
| `warehouse-price-parity-before.json`                  | nový read-only parity audit bezprostředně před budoucí tx                        | fresh mode = source-equivalent; replay mode = exact bootstrapped state                               |
| `warehouse-price-parity-after.json`                   | nový read-only parity audit až po potvrzeném commitu                             | PASS, exact candidate `legacy_bootstrap_match`, nulový non-candidate drift                           |
| `warehouse-price-bootstrap-execution-receipt.json`    | budoucí receipt capture až po známém committed outcome a after parity            | exact source/before/after, apply result IDs/mode, migration/backup/preflight binding                 |

První dva staging soubory samy nenahrazují osm raw vstupů schema-v4 verifieru. Ty musí zůstat uchované v původním staging evidence bundle; D9N activation adresář nese root a jeho PASS verification output jako cross-workstream vazbu.

## Trusted hash pravidlo

`--expected-preflight-file-sha256` a `--expected-receipt-file-sha256` nesmí být odvozeny ve stejném příkazu ze souboru, který právě ověřují. Takový postup by pouze potvrdil vlastní tampered vstup.

Přípustný budoucí postup:

1. canonical soubor vznikne v isolated capture kroku;
2. jeho SHA-256 se zobrazí operátorovi spolu s exact source SHA, target fingerprintem a candidate countem;
3. operátor jej schválí mimo pracovní activation adresář a uloží do checkpointu nebo jiného separately reviewed immutable záznamu;
4. až následný offline verifier dostane tento předem uložený digest jako explicitní argument;
5. změna jediného raw bytu vyžaduje nový capture, nový hash a nové schválení.

Git working tree, dočasný text v terminálu ani proměnná odvozená během stejného verifier invocation nejsou samy o sobě oddělenou trust hranicí.

## Capture adresáře

Každý set musí vzniknout v novém prázdném dedicated adresáři. Nepoužívat workspace root, Downloads, sdílený staging output adresář ani adresář s předchozím pokusem.

- preflight capture obsahuje přesně devět souborů z D9N;
- po schválení preflight file SHA se tento adresář zmrazí a dále se nemění;
- receipt capture vznikne jako nový dvanáctisouborový adresář, nikoli dopisováním do schváleného preflight adresáře;
- devět společných souborů musí být byte-for-byte shodných s approved preflight setem;
- before, after a receipt jsou nové přesné soubory;
- žádné secrets, `.env`, DB URL, access tokeny, S3 credentials, raw dumpy ani provider key material nesmí být do adresáře vloženy.

D9N odmítne každý extra soubor; sidecar checksumy nebo poznámky proto patří mimo dedicated verifier directory.

## Povinné offline ověření

Preflight set:

```powershell
pnpm.cmd --filter @workspace/api-server run accounting:warehouse-price:bootstrap-activation:verify -- --mode=preflight --artifact-dir=<absolute-preflight-dir> --expected-preflight-file-sha256=<separately-approved-64-hex>
```

Receipt set:

```powershell
pnpm.cmd --filter @workspace/api-server run accounting:warehouse-price:bootstrap-activation:verify -- --mode=receipt --artifact-dir=<absolute-receipt-dir> --expected-preflight-file-sha256=<same-separately-approved-64-hex> --expected-receipt-file-sha256=<separately-approved-64-hex>
```

Pouze exit code 0 a canonical `verified=true` pro exact mode jsou PASS. Stdout nesmí být interpretován jako apply authorization; je to pouze verifikace již existujícího evidence setu.

## Abort matrix

| Okamžik                 | Nález                                                                                | Povinná reakce                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Před budoucí tx         | libovolný hash/schema/layout/source/target/lineage/backup mismatch                   | nic nespouštět; adresář označit rejected a vytvořit nový capture až po vysvětlení driftu                    |
| Před budoucí tx         | parity `BLOCK`, 0 candidates, unknown third opaque identity nebo jakýkoli `0100` tag | hard NO-GO; neobcházet limity ani nepřeklasifikovat opaque řádek                                            |
| Před budoucí tx         | backup stale, restore neprošel nebo payload >256 MiB                                 | nový backup + restore test; starý preflight je neplatný a vyžaduje nový hash/approval                       |
| Uvnitř caller-owned tx  | D9L stale/partial/outbox/projection chyba                                            | rollback celé tx; nevytvářet PASS receipt                                                                   |
| Výsledek tx neznámý     | ztráta spojení/timeout po commit requestu                                            | žádný blind retry; nejprve read-only observation/outbox/head a parity inventory                             |
| Po potvrzeném rollbacku | žádný nový observation/outbox/head                                                   | nový before audit a nový execution attempt pouze se stále platným explicitním schválením                    |
| Po potvrzeném commitu   | after parity PASS a exact IDs                                                        | vytvořit receipt, uložit samostatný trusted receipt hash a spustit D9N receipt verification                 |
| Po potvrzeném commitu   | receipt capture/write selže                                                          | DB stav neměnit a apply neopakovat; zachovat raw source/before/after/outcome a řešit jako evidence incident |
| Po potvrzeném commitu   | after parity drift nebo partial state                                                | hard incident; žádný automatický cleanup/delete/second apply, feature/read cutover zůstává vypnutý          |
| Exact replay            | before už je úplný exact bootstrapped stav                                           | povolit pouze D9L exact-replay větev; receipt musí mít `beforeState=exact-replay-match`                     |

## Cleanup a retence

Před DB mutací lze odmítnutý lokální capture přesunout do quarantine nebo bezpečně odstranit, pokud nebyl použit jako schválený důkaz. Po jakémkoli nejasném outcome nebo potvrzeném commitu se source, before, after, plan, approval, authorization, preflight a všechny outcome logy nesmí mazat ani přepisovat; jsou součástí incident/evidence chain.

Tento runbook nedefinuje finální účetní retention dobu ani immutable provider. Dokud není provider/capability preflight schválen, artefakty zůstávají lokální a nesmí se vydávat za durable off-host archiv.

## Exit z D9O

D9O je dokončen, když:

- přesný původ všech 12 souborů je jednoznačný;
- trusted hash není self-derived ve verifier invocation;
- fresh, replay, rollback, unknown outcome, committed-without-receipt a partial-state cesty mají fail-closed reakci;
- runbook neobsahuje žádný apply, migration, deploy nebo provider-write příkaz;
- D9N statický test chrání názvy souborů, oba verifier příkazy a NO-GO hranice.

Skutečný staging běh zůstává BLOCKED, dokud samostatně schválené workstreamy nedodají integrovaný source, migration lineage, expand migraci, schema-v4 release evidence, backup/restore, capture helper, reviewed apply runner a skutečné artefakty.

## Ověření checkpointu

- D9M/D9N/D9O contract, CLI process a statický runbook gate: **13/13 PASS**;
- celý API unit balík: **109/109 souborů, 822/822 PASS**;
- schema-v4 staging release evidence: **12/12 PASS**;
- staging runtime contract: **27/27 PASS**;
- API TypeScript, scoped ESLint, Prettier, production build, runtime-contract checker a scoped `git diff --check`: **PASS**;
- nebyla provedena žádná DB, Docker, síťová, provider, GitHub, Coolify, GHCR, S3, deploy ani migrační operace.
