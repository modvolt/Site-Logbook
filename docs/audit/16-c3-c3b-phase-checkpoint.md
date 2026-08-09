# Checkpoint R16-C3C3B – merge privátního publikačního wrapperu

Datum: 2026-08-09

## Výsledek

**R16-C3C3B je dokončena. Privátní PR #2 byl označen jako ready a sloučen do
private `main`; workflow dispatch, GHCR zápis, deploy ani migrace nebyly
provedeny.**

Uživatel výslovně schválil pouze označení privátního PR #2 jako ready a jeho
merge do private `main`. Současně výslovně neschválil workflow dispatch ani GHCR
zápis. Tato hranice byla dodržena.

- privátní PR
  [modvolt/site-logbook-registry#2](https://github.com/modvolt/site-logbook-registry/pull/2)
  byl před změnou `OPEN`, `draft`, `CLEAN` a `MERGEABLE`;
- přesný schválený head byl
  `d4b8c9c95f4410c101cb480f8af39707c20960ee` a base
  `main@aeec7c4331c2305525b78a069352da587264c08d`;
- po označení ready byly head, base, mergeability, nulové workflow runy a prázdná
  aktivní GHCR inventura znovu ověřeny;
- merge byl proveden běžnou merge metodou s ochranou přesného headu, bez
  `--admin`, bez auto-merge a bez smazání feature větve;
- PR je nyní `MERGED`, merge provedl účet `modvolt` v čase
  `2026-08-09T18:34:23Z`;
- výsledný merge commit je
  `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc` a private `main` ukazuje přesně na
  tento commit;
- rodiče merge commitu jsou v pořadí původní private `main`
  `aeec7c4331c2305525b78a069352da587264c08d` a schválený PR head
  `d4b8c9c95f4410c101cb480f8af39707c20960ee`;
- merge tree je `8c1e7b1caf1172b3b5ef9c42040855d9aaf32425`;
- proti původnímu private `main` přibyl jediný soubor
  `.github/workflows/publish-staging-predecessor.yml`, 46 řádků, bez odstranění
  jiných souborů;
- feature větev `agent/phase16c3-predecessor-wrapper` zůstala zachována na
  přesném headu `d4b8c9c95f4410c101cb480f8af39707c20960ee`.

## Ověření wrapperu na private main

- wrapper na merge commitu private `main` má 1 496 bytů a SHA-256
  `61aa49bdb033e5bc3a100d28e3a1251c8f4619591efc33e9362e8bdb16f24830`;
- veřejná auditovaná template na public headu má stejnou délku i SHA-256;
- porovnání bytes je přesně shodné;
- workflow je na private default branch registrováno jako `active`, ID
  `330628153`, název
  `Publish fixed Site Logbook staging predecessor (manual, no deploy)`;
- workflow je dostupné pouze přes ruční `workflow_dispatch` s přesnou potvrzovací
  frází; v této podfázi nebyl dispatch proveden;
- bezprostřední post-merge kontrola i závěrečná kontrola v přihlášeném GitHub
  kontextu vrátily pro toto workflow 0 běhů;
- aktivní privátní GHCR container inventura účtu `modvolt` měla před merge i po
  merge 0 položek; žádný package ani tag nebyl vytvořen.

Výsledek `0 active packages` neprokazuje, že stejný namespace nikdy historicky
neexistoval a nebyl kompletně smazán. Jde o známou mez GitHub Packages API;
checkpoint proto tvrdí pouze nepřítomnost aktivního package v okamžiku kontrol.

## Veřejný release train

- draft PR [modvolt/Site-Logbook#15](https://github.com/modvolt/Site-Logbook/pull/15)
  zůstal před uložením tohoto checkpointu `OPEN`, `draft` a `CLEAN`;
- jeho head byl
  `91d505b619ac3ff906db62b85df1df0c61b84d47`, base
  `main@a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- exact-head Quality gate run
  [31328649172](https://github.com/modvolt/Site-Logbook/actions/runs/31328649172),
  job `93283139638`, byl `completed/success` a všech 19 povinných kroků prošlo;
- veřejný PR nebyl označen ready ani mergován.

Po přidání tohoto checkpointu musí nový přesný veřejný head získat vlastní zelený
Quality gate; starší běh je důkazem pouze pro head `91d505b…`.

## Provedené kontroly

- live kontrola public PR #15 a private PR #2 v přihlášeném GitHub kontextu;
- kontrola přesných head/base SHA a mergeability těsně před ready a merge;
- kontrola nulových private workflow runů a aktivní GHCR inventury před ready,
  před merge a po merge;
- označení PR ready a následná opakovaná kontrola neměnnosti headu;
- merge s `--match-head-commit` na přesný schválený head;
- kontrola merged metadata, autora, času, merge commitu a private `main` refu;
- kontrola obou rodičů merge commitu, tree a diffu proti původnímu private `main`;
- kontrola zachování feature větve;
- vzdálené byte/length/SHA-256 porovnání wrapperu na private `main` s public
  auditovanou template;
- kontrola registrace workflow jako `active` a potvrzení 0 jeho běhů;
- kontrola, že public exact-head Quality gate zůstal zelený.

## Nejasnosti a zbývající hranice

1. Úplně smazaný historický GHCR package nelze použitými API endpointy odlišit od
   namespace, který nikdy neexistoval. Budoucí publisher musí tuto mez zachovat
   v evidenci.
2. Workflow je nyní bezpečnostně citlivě dostupné na private default branch, ale
   nebylo spuštěno. Každý dispatch vyžaduje nový samostatný výslovný souhlas.
3. Pokud exact predecessor tag neexistuje, budoucí publisher může vytvořit jednu
   novou privátní immutable GHCR verzi. To je externí a prakticky nevratný zápis;
   současný souhlas jej nepokrývá.
4. Runtime baseline `0104`, staging backup/restore, aplikace `0105`, Coolify,
   staging deploy a produkce zůstávají mimo tuto podfázi.
5. Migrace `0100` zůstává výslovně nezařazená.
6. GitHub Quality gate hlásí neblokující upozornění, že některé připnuté action
   commity deklarují Node.js 20 a runner je vynuceně spouští na Node.js 24.
   Současné exact-head běhy jsou úspěšné; aktualizace action pinů patří do
   samostatné úzké údržby.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C – po samostatném výslovném souhlasu jednorázově
  dispatchovat fixed predecessor publisher z private `main`, ověřit fail-closed
  stavový automat a uložit immutable evidence; bez deploye;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze může provést první externí GHCR zápis a musí
  přesně svázat zdrojový commit/tree, jediný `linux/amd64` image digest,
  provenance, SBOM, package/version ID a auditní checksum;
- očekávané činnosti: znovu ověřit public exact-head green CI, private wrapper na
  přesném `main`, nulové aktivní publisher runy a aktuální GHCR inventuru; po nové
  explicitní autorizaci spustit workflow s přesnou potvrzovací frází; sledovat
  jeden běh; stáhnout a nezávisle ověřit evidence artifact a checksum; zastavit
  před jakýmkoli staging deployem nebo migrací;
- soubory, které budou pravděpodobně změněny: žádný produkční soubor; po
  úspěšném běhu pouze nový veřejný auditní checkpoint. GitHub Actions může
  vytvořit privátní GHCR package verzi a evidence artifact;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: nesmí obsahovat
  DB migraci ani deploy. Může obsahovat jediný explicitně schválený, externí a
  prakticky nevratný GHCR zápis, pokud je exact tag před spuštěním nepřítomný.

## Stop

Checkpoint R16-C3C3B je vytvořen. Privátní wrapper je na private `main`, ale
publisher nebyl spuštěn, GHCR nebyl změněn a nebyl proveden žádný deploy ani
migrace.
