# R13-D9M – warehouse-price activation preflight checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako čistý canonical approval/preflight/receipt kontrakt; aktuální activation je BLOCKED a nevznikl runner, očíslovaná migrace, DB/S3/Coolify/GitHub operace, deploy ani cutover; R13 jako celek NOT READY**

## Výsledek

D9M uzavírá důkazní mezeru mezi D9L transaction-only apply primitive a případným budoucím staging během. Přidává tři strict canonical artefakty:

1. `site-logbook.warehouse-price-bootstrap-approval/v1` – raw schválení exact parity reportu a dry-run plánu;
2. `site-logbook.warehouse-price-bootstrap-activation-preflight/v1` – fail-closed READY rozhodnutí pro jediný staging target;
3. `site-logbook.warehouse-price-bootstrap-execution-receipt/v1` – post-commit důkaz source/pre/post parity a úplné applied nebo exact-replay dávky.

Každý artefakt má exact-key schéma, domain-separated SHA-256 a canonical JSON verifier. Samostatné binding verifiery znovu načtou přesné raw bytes celé evidence chain; přepočtení pouze vnějšího hashe proto nestačí k přesměrování artefaktu na jiný report, plán nebo autorizaci.

## Raw approval hranice

Approval artefakt váže target fingerprint, interní i raw-file SHA-256 parity reportu a plánu, candidate count, user ID, timestamp a exact confirmation phrase. Výslovně přijímá jen:

- `historicalCompleteness=unknown` bez domýšlení actor/effective/event historie;
- source-currency model bez implicitního FX;
- staging-only pokračování bez autorizace DB zápisu, migrace, deploye nebo produkčního targetu.

D9M porovná SHA-256 přesných approval bytes s `approvalEvidenceSha256` v D9L apply autorizaci a současně vyžaduje shodný user a čas. Tím zavírá D9L omezení, kde byl externí approval artefakt zatím pouze digest reference bez vlastního strict raw-byte kontraktu.

## READY activation preflight

READY preflight lze vytvořit jen pokud současně platí:

- logical environment je exact `site-logbook-staging`, `productionTargetsTouched=false` a source commit je exact 40-hex SHA;
- předem strictně ověřený staging release evidence digest a exact PASS verification-file digest vážou shodný source SHA, target fingerprint, provisioning a deployment inputs;
- public main je označen jako integrovaný a známý code/applied migration set má shodný počet i SHA-256, bez missing nebo unexpected známých tagů;
- přesně dvě produkční opaque legacy identity jsou zachované pouze jako SHA-256 identity, v seřazeném unikátním seznamu, s `opaqueLegacyMeaningInferred=false`;
- `0100` je jediný explicitně vyloučený tag a plánovaná účetní expand migrace nesmí mít prefix `0100_`;
- plánovaná migrace je již zahrnutá v code lineage, aplikovaná na staging target, je latest known tag a její exact SQL SHA-256 je uložený v preflightu;
- staging backup je completed, restore test passed, target fingerprint se shoduje, payload je nejvýše 256 MiB a restore zůstává čerstvý vůči času vytvoření preflightu;
- candidate count je nenulový, nejvýše 20 000 a vejde se do explicitního single-transaction limitu;
- požadované hranice jsou caller-owned single transaction, ascending candidate locks, exact replay, povinná pre/post parity a zákaz partial resume.

Preflight úmyslně obsahuje `applyRunnerIncluded=false`, `migrationExecutionIncluded=false`, `deploymentIncluded=false` a `productionWriteIncluded=false`. D9M nepřidává žádný způsob, jak jej použít k mutaci.

## Post-apply receipt

Receipt rozlišuje tři reporty:

- **source** – původní exact `legacy_only` report, ze kterého vznikl schválený plán;
- **before** – bezprostřední read-only snapshot před transakcí;
- **after** – read-only snapshot po potvrzeném commitu.

Pro fresh `applied` běh musí `before` semanticky odpovídat source stavu; timestamp může být novější. Pro `exact-replay` musí už `before` odpovídat úplnému bootstrapped stavu. `after` v obou režimech musí:

- zachovat target, limits a přesnou inventuru itemů;
- ponechat každý non-candidate item canonical-identický;
- u každého candidate itemu zachovat stored cenu i všechny legacy rows a přidat právě exact plan observation plus odvozený shadow projection head;
- skončit jako `legacy_bootstrap_match`, nikoli native/legacy overlap;
- mít globální decision `PASS`;
- exactně svázat seřazené candidate item IDs a observation IDs vrácené D9L apply primitive;
- zachovat source, before a after raw-file i semantic SHA-256, migration SQL digest, backup evidence digest a lineage evidence digest.

Receipt je vytvářen až s `callerTransactionCommitted=true`; samotný D9M ale commit neprovádí a neobsahuje runner. Budoucí orchestrace musí emitovat receipt až po skutečném úspěšném commitu a následné read-only parity inventuře.

## Ověření

- D9M contract test: **7/7 PASS**;
- celý API unit balík: **109/109 souborů, 816/816 PASS**;
- API TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- scoped `git diff --check`: **PASS**;
- žádná DB, Docker, síťová, provider, GitHub, Coolify, GHCR, S3, deploy nebo migrační operace nebyla provedena.

## Aktuální NO-GO stav

Tento checkpoint nedokládá operativní READY staging run. V tomto řezu nebylo provedeno:

- nové live ověření/integrace aktuálního public `main` a vyřešení migration-journal konfliktu;
- přidělení ani aplikace očíslované accounting expand migrace; test používá záměrně pouze `0999_test_only_accounting_expand`, které není návrhem skutečného čísla;
- vytvoření skutečného schema-v4 staging release evidence, lineage evidence a čerstvého backup/restore artefaktu pro exact budoucí source SHA;
- staging parity audit, bootstrap plan, raw approval nebo D9L apply autorizace nad reálnými daty;
- implementace host runneru, secret/env contractu, recovery abortu nebo post-commit artifact writeru.

D9M navíc váže hash a shrnutí **předem strictně ověřeného** schema-v4 staging release evidence i raw PASS verification file. Jeho plné raw schema-v4 ověření zůstává v existujícím staging release verifieru a budoucí orchestrace jej musí spustit před vytvořením D9M preflightu. D9N následně přidává exact sidecar a adresářové ověření tohoto řetězce.

## Další bezpečný řez

R13-D9N připravil read-only/offline verifier orchestration a přesný artifact layout pro source, before a after parity, approval, authorization, lineage, staging release, backup, preflight a receipt. Navazující D9O může doplnit pouze capture/readiness runbook a abort matrix. Skutečné přidělení migrace vyžaduje nejprve samostatně schválenou integraci aktuálního public `main`; staging apply, deploy, migrace, feature-flag activation, exporter/provider a read/UI cutover zůstávají oddělené kritické approval boundaries. `0100` zůstává vyloučena.
