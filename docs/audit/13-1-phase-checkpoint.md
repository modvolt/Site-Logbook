# Checkpoint FÁZE 13.1 – publikační předpoklady

- **Datum:** 2026-08-02.
- **Vstupní commit:** `e90d866`.
- **Stav fáze:** přesný čistý lokální kandidát ověřen; autorizovaná publikace a
  externí staging execution jsou **BLOCKED**.
- **Produkce:** nedotčena; bez přístupu k `modvoltapp.cz`, produkční DB, storage,
  mailu, secrets, deployi nebo migracím.
- **Remote:** nedotčen; žádná nová větev, push, pull request, workflow dispatch,
  merge ani release.
- **Uživatelský worktree:** všechny existující rozpracované UI/schema změny včetně
  necommitnuté migrace 0100 byly zachovány beze změny.

## Výstupy

- [manifest kandidáta k publikaci](13-1-publish-manifest.md)
- [centrální verifikace a externí gate matice](13-1-verification.md)

## Výsledek

Čistý commit `e90d866fbe04daa1cce1363bbb243ab6430f2365` prošel typecheckem,
16/16 guard testy, frontend 127/127, live-events 15/15, API 296/296, API a PWA
buildem, staging TypeScriptem, discovery 5 E2E scénářů, ESLintem, peer kontrolou a
dependency auditem pro práh moderate. Audit hlásí jednu low závažnost.

Externí část nemohla bezpečně začít: chybí staging URL/identity/DB/storage/mail,
GitHub CLI a publikovaný integrační branch. Remote `main` navíc postrádá 42
závislých lokálních commitů a kandidát obsahuje šest databázových migrací s
otevřeným rozhodnutím kolem necommitnuté uživatelské migrace 0100.

## Jednoznačný checkpoint

FÁZE 13.1 zde končí **BLOCKED publikačním checkpointem**. Lokální ověření je
dokončeno, ale nevznikl branch, PR, remote CI, staging deploy ani externí release
evidence. Tento stav nesmí být interpretován jako schválení merge, migrací,
stagingu nebo produkčního release. Automaticky se nepokračuje.

Pro další běh je potřeba výslovně potvrdit alespoň:

> Schvaluji publikaci commitů `f1bb210..e90d866` do nové větve
> `agent/phase13-staging-gate` a vytvoření draft PR; rozhodnutí k migraci 0100 je
> [publikovat stávající mezeru / nejprve integrovat 0100]. GitHub CLI je
> nainstalované a přihlášené.

Toto potvrzení stále neopravňuje merge, deploy ani použití produkčních secretů.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.2 – schválená publikace integrační větve a remote quality
  gate;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** publikovaný rozsah zahrnuje 42 bezpečnostních,
  recovery a provozních commitů, šest migrací, autorizační hranice, key custody a
  otevřenou integraci migrace 0100; chyba ve scope nebo pořadí může změnit release
  kandidáta;
- **očekávané činnosti:** potvrdit přesný commit rozsah a migraci 0100, ověřit
  GitHub autentizaci, vytvořit `agent/phase13-staging-gate`, pushnout pouze tento
  kandidát, otevřít draft PR, zkontrolovat remote diff a spustit/vyhodnotit quality
  workflow; bez merge a bez deploye;
- **soubory, které budou pravděpodobně změněny:** primárně žádné lokální soubory;
  externě vznikne GitHub branch, draft PR a CI artefakty. Jen při skutečném CI
  problému mohou být po samostatném posouzení úzce upraveny `.github/workflows/*`,
  `scripts/*` nebo související audit dokumentace;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** pull request
  bude obsahovat migrace 0096–0099 a 0101–0102 a další vysoce citlivé změny, ale
  FÁZE 13.2 je nesmí aplikovat. Merge, staging deploy, DB/object restore,
  provider retention a jakýkoli zásah do produkce vyžadují další samostatnou
  autorizaci.
