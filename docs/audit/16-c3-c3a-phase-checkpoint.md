# Checkpoint R16-C3C3A – autorizovaná read-only GHCR inventura

Datum: 2026-08-09

## Výsledek

**R16-C3C3A je dokončena bez merge, workflow dispatch, GHCR zápisu nebo
deploye.**

Uživatel výslovně schválil pouze přidání GitHub OAuth scope `read:packages`
účtu `modvolt` pro read-only inventuru. Současně výslovně neschválil merge ani
GHCR zápis. Tato hranice byla dodržena.

- `gh` je přihlášeno jako aktivní účet `modvolt`;
- token nyní obsahuje scope `read:packages`; nebyl přidán `write:packages` ani
  `delete:packages`;
- `GET /user/packages?package_type=container&visibility=private&per_page=100`
  vrátil na první stránce 0 položek;
- kontrolní `GET /user/packages?package_type=container&per_page=100` bez filtru
  visibility rovněž vrátil na první stránce 0 položek;
- protože první stránka obsahuje méně než 100 položek, aktivní inventura je pro
  tento okamžik úplná bez další stránky;
- v namespace účtu proto není žádný aktivní container package, včetně
  `site-logbook-staging-api`, a není zde žádný aktivní exact predecessor tag;
- žádný GitHub Actions publisher nebyl spuštěn a GHCR nebyl změněn.

Výsledek `0 active packages` neprokazuje, že stejný namespace nikdy historicky
neexistoval a nebyl kompletně smazán. GitHub API neposkytuje pro uživatelský
seznam packages ekvivalent `state=deleted`; viditelné smazané verze lze načíst
až pro stále existující package. Budoucí publisher proto smí tvrdit pouze
`active package absent`, nikoli `namespace never used`.

## Read-only merge readiness

Veřejný release train:

- draft PR [modvolt/Site-Logbook#15](https://github.com/modvolt/Site-Logbook/pull/15)
  je `OPEN`, `CLEAN`, `draft` a nemergovaný;
- head je přesně `291d07fc2accff5273e7a2d52e38e52020377b0a`, base
  `main@a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- exact-head Quality gate run `31327126061`, job `93279172782`, je
  `completed/success`; všech 19 povinných kroků prošlo;
- připnutý reusable workflow existuje na implementačním commitu
  `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb` jako blob
  `5f6fd77d9e4370b629ccad3a4dec64cde384ff3b`, velikost 39 164 bytů.

Privátní wrapper:

- draft PR
  [modvolt/site-logbook-registry#2](https://github.com/modvolt/site-logbook-registry/pull/2)
  je `OPEN`, `CLEAN`, `draft` a nemergovaný;
- head je přesně `d4b8c9c95f4410c101cb480f8af39707c20960ee`, base
  `main@aeec7c4331c2305525b78a069352da587264c08d`;
- PR obsahuje dva navazující commity a jediný přidaný soubor
  `.github/workflows/publish-staging-predecessor.yml` s 46 řádky;
- wrapper na private headu a public template na finálním public headu mají
  shodnou délku 1 496 bytů a shodný SHA-256
  `61aa49bdb033e5bc3a100d28e3a1251c8f4619591efc33e9362e8bdb16f24830`;
- pro privátní feature větev neexistuje žádný workflow run;
- Actions jsou v private repo povolené s `allowed_actions=all`; výchozí token
  permission je `read` a workflow si musí explicitně vyžádat omezené
  `packages: write` až ve schváleném publikačním jobu;
- PR #2 je technicky připravený k budoucímu přesně kontrolovanému merge, ale
  tento checkpoint merge neautorizuje.

## Provedené kontroly

- `gh auth status --hostname github.com`;
- `gh api user --jq .login`;
- read-only stránkovaná inventura privátních i všech viditelností container
  packages;
- live kontrola public PR #15, private PR #2 a jejich exact head/base SHA;
- kontrola exact-head public Quality gate a jeho 19 povinných kroků;
- kontrola private PR diffu, commitů a nulových workflow runů;
- read-only kontrola GitHub Actions permissions private repo;
- vzdálené stažení a SHA-256/length porovnání public template a private
  wrapperu;
- kontrola čistých public i private worktree a shody lokálního headu s
  upstreamem.

## Nejasnosti a blokátory

1. Úplně smazaný historický package nelze použitými API endpointy odlišit od
   namespace, který nikdy neexistoval. Jde o známou mez důkazu, nikoli o tvrzení
   o existenci tombstonu.
2. Privátní PR #2 stále není na `refs/heads/main`; workflow tedy nelze bezpečně
   ručně dispatchovat z default branch.
3. Merge PR #2 nebyl schválen a nebyl proveden.
4. GHCR write ani publisher dispatch nebyly schváleny a nebyly provedeny.
5. Runtime baseline `0104`, staging backup/restore, aplikace `0105`, Coolify a
   produkce zůstávají mimo tuto podfázi.
6. GitHub Quality gate hlásí neblokující upozornění, že některé připnuté action
   commity deklarují Node.js 20 a runner je vynuceně spouští na Node.js 24.
   Současný exact-head běh je úspěšný; aktualizace action pinů patří do
   samostatné úzké údržby.

## Doporučení pro další spuštění

- další fáze: R16-C3C3B – po samostatném výslovném souhlasu merge pouze
  privátního PR #2 do private `main`, následné byte/hash/ref ověření a stop před
  workflow dispatch;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: merge zpřístupní security-sensitive workflow na
  default branch, ze které lze později provést jednorázový immutable GHCR write;
- očekávané činnosti: znovu ověřit neměnné public/private heady, exact green CI,
  nulové workflow runy a prázdnou aktivní GHCR inventuru, po explicitním
  souhlasu označit PR #2 jako ready a mergovat s exact-head ochranou, ověřit
  merge commit, private `main`, identické wrapper bytes a stále nulový dispatch;
- soubory, které budou pravděpodobně změněny: v public repo žádný produkční
  soubor; v private repo se připravený
  `.github/workflows/publish-staging-predecessor.yml` pouze začlení do `main`;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: nesmí
  aplikovat DB migraci, spustit publisher, měnit GHCR, Coolify ani produkci.
  Rizikovou změnou je samotný merge security workflow do private default branch
  a vyžaduje samostatný explicitní souhlas.

## Stop

Checkpoint R16-C3C3A je vytvořen. Privátní PR nebyl mergován, publisher nebyl
spuštěn a GHCR nebyl změněn.
