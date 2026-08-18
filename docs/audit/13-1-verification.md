# FÁZE 13.1 – publikační a externí staging verifikace

- **Datum:** 2026-08-02.
- **Ověřený commit:** `e90d866fbe04daa1cce1363bbb243ab6430f2365`.
- **Rozsah běhu:** přesná čistá reprodukce lokálního kandidáta, read-only kontrola
  remote a předpokladů pro autorizovanou publikaci/staging.
- **Mimo rozsah:** produkce, `modvoltapp.cz`, produkční DB/storage/mail/secrets,
  merge, deploy, migrace a jakákoli externí destruktivní sonda.

## Centrální registr zjištění

| ID       | Stav      | Zjištění                                                                                                         | Důkaz / dopad                                                                                            |
| -------- | --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| F13.1-01 | potvrzeno | Proces nemá žádné proměnné s prefixy staging/E2E/DB/storage/mail/deploy providerů.                               | Neexistuje bezpečně adresovatelný externí staging; produkce není náhradní target.                        |
| F13.1-02 | potvrzeno | Remote `main` je na `a25c312`; nemá lokální quality/staging workflow, odpovídající statusy ani integrační větev. | Remote CI a staging workflow nelze spustit pro lokální SHA bez publikace celého závislého rozsahu.       |
| F13.1-03 | potvrzeno | Lokální kandidát je 42 commitů a 268 souborů před remote, s 108 486 vloženími a 3 503 odstraněními.              | Jde o široký bezpečnostní/recovery/migrační release, ne izolovaný workflow patch.                        |
| F13.1-04 | potvrzeno | GitHub CLI `gh` není dostupné a není potvrzená autentizovaná publikační session.                                 | Publikační workflow se bezpečně zastavilo před vytvořením větve, pushnutím nebo PR.                      |
| F13.1-05 | potvrzeno | Samostatný `e90d866` závisí na dřívějších lokálních commitech, které remote neobsahuje.                          | Cherry-pick pouze FÁZE 13 by nebyl úplný ani odpovídající ověřenému stavu.                               |
| F13.1-06 | otevřeno  | Kandidát obsahuje migrace 0096–0099 a 0101–0102; necommitnutá uživatelská práce přidává 0100.                    | Před publikací je nutné rozhodnutí o integraci/pořadí migrace 0100; uživatelská práce zůstala nedotčena. |
| F13.1-07 | ověřeno   | Přesný commit prošel v čistém detached worktree hermetickým a quality gate.                                      | Výsledky nejsou ovlivněny 58 záznamy v uživatelském špinavém worktree.                                   |

## Ověření přesného commitu

Pro SHA `e90d866fbe04daa1cce1363bbb243ab6430f2365` vznikl dočasný detached
worktree. Závislosti byly instalovány přes `pnpm --frozen-lockfile`; první offline
pokus korektně skončil na chybějícím tarballu `@eslint/js@10.0.1`, následný frozen
install doplnil pouze dočasné `node_modules` a lockfile nezměnil.

| Kontrola                                       | Výsledek                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Workspace typecheck                            | PASS, 4/4 projekty                                                     |
| Safe env + staging guard/evidence testy        | PASS, 16/16                                                            |
| Frontend unit                                  | PASS, 127/127                                                          |
| Live-events unit                               | PASS, 15/15                                                            |
| API unit                                       | PASS, 296/296                                                          |
| API build                                      | PASS                                                                   |
| Frontend/PWA build                             | PASS; manifest a service worker vygenerovány                           |
| Staging E2E TypeScript                         | PASS                                                                   |
| Playwright staging discovery                   | PASS, 5 scénářů ve 3 projektech; pouze `--list`, bez sítě/global setup |
| ESLint                                         | PASS, 0 warnings                                                       |
| Peer dependencies                              | PASS                                                                   |
| Dependency audit                               | PASS pro práh moderate; 1 známá low závažnost                          |
| `git diff --check` a čistota detached worktree | PASS; žádná verzovaná změna                                            |

První hermetický běh prošel typecheckem a 16/16 guard testy, ale sandbox zabránil
`esbuild` číst nadřazený adresář dočasného worktree. Toto nebyl test fail. Stejný
nezměněný příkaz po explicitním spuštění mimo dané filesystem omezení prošel celý.
Databázové integrační testy a migrace nebyly v této fázi opakovány, protože není
k dispozici schválená izolovaná staging DB a produkční target je zakázaný.

## Externí release matice

| Gate                                                 | Stav    | Co chybí                                              |
| ---------------------------------------------------- | ------- | ----------------------------------------------------- |
| Schválený publikační rozsah a strategie migrace 0100 | BLOCKED | explicitní rozhodnutí uživatele                       |
| Autentizovaný publikační kanál                       | BLOCKED | instalované/přihlášené `gh` nebo ekvivalent           |
| Remote integrační větev a draft PR                   | BLOCKED | předchozí dva předpoklady                             |
| Remote quality workflow na přesném SHA               | BLOCKED | publikovaný commit a workflow                         |
| Izolovaný staging deploy                             | BLOCKED | URL, owner, DB/storage/mail handly a deploy oprávnění |
| Authenticated API, desktop/mobile a PWA smoke        | BLOCKED | nasazený staging commit a dedikovaná identita         |
| Společný anonymizovaný DB + object restore           | BLOCKED | recovery point a nová izolovaná DB/bucket             |
| Provider IAM, versioning/Object Lock a retention     | BLOCKED | schválený provider, fingerprint a owner               |
| Mail sandbox a freshness alert delivery              | BLOCKED | sandbox route/inbox a on-call channel                 |
| RPO/RTO a dvoučlenné finální evidence                | BLOCKED | skutečný drill, operator a nezávislý reviewer         |

Lokální zelený gate není externí release evidence. Remote ani produkce nebyly
změněny a žádný řádek externí matice nelze označit jako PASS.

## Nejasnosti

- Zda se má publikovat celý stávající rozsah 42 commitů, nebo připravit nová
  integrační větev po dokončení uživatelské migrace 0100.
- Kdo smí schválit a reviewovat bezpečnostní/migrační pull request.
- Jaký konkrétní neprodukční staging provider, URL, identity, DB, storage a mail
  sandbox budou použity.
- Jaké RPO/RTO, retention a cleanup pravidlo schválí service owner.
