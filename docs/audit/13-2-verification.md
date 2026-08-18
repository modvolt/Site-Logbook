# FÁZE 13.2 – publikace kandidáta a remote quality gate

- **Datum:** 2026-08-02.
- **Draft PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1).
- **Base:** `main` na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Publikovaná větev:** `agent/phase13-staging-gate`.
- **Finální head:** `12d57c512550a1a273947cbc742f577faddc5f72`.
- **Původní kandidát:** `e90d866fbe04daa1cce1363bbb243ab6430f2365`.
- **Rozsah:** 43 lineárních commitů, 0 merge commitů; draft PR a remote CI.
- **Mimo rozsah:** merge, deploy, aplikace migrací, externí staging E2E a produkce.

## Centrální registr zjištění

| ID       | Stav     | Zjištění                                                                                         | Důkaz / dopad                                                                                       |
| -------- | -------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| F13.2-01 | ověřeno  | Remote `main` zůstal na původním SHA a kandidát je oddělený v draft PR.                          | `main` = `a25c312`; PR #1 head = `12d57c5`; žádný merge ani deploy.                                 |
| F13.2-02 | ověřeno  | Publikovaná větev obsahuje migrace 0096–0099 a 0101–0102 včetně rollbacků, nikoli migraci 0100.  | Mezera 0099 → 0101 je záměrná dle pokynu uživatele a vyžaduje explicitní review před integrací.     |
| F13.2-03 | opraveno | První Linux CI odhalilo platformně závislé řazení route manifestu.                               | `localeCompare()` bez explicitního locale dávalo na Windows a Linuxu jiné pořadí stejných 402 rout. |
| F13.2-04 | ověřeno  | Schválená oprava používá deterministické porovnání JavaScript code units.                        | Commit `12d57c5`; 3 soubory, 25 vložení a 13 odstranění; množina rout ani oprávnění se nezměnily.   |
| F13.2-05 | ověřeno  | Lokální hermetický i quality gate jsou zelené na finálním headu.                                 | Typecheck, guardy, unit testy, buildy, lint, peer check, audit a `git diff --check` prošly.         |
| F13.2-06 | ověřeno  | Finální GitHub Actions quality gate je zelený na přesném head SHA.                               | Run `30754695026` dokončen `success`, včetně izolovaných DB suites a MinIO recovery drillu.         |
| F13.2-07 | otevřeno | Neproběhlo nezávislé security/migration review ani autentizované externí staging E2E.            | Draft PR není připraven k merge nebo deployi pouze na základě tohoto checkpointu.                   |
| F13.2-08 | sledovat | GitHub Actions v4 mají upozornění na deprecated Node.js 20 a dependency audit hlásí 1 low nález. | Obojí je neblokující pro tento gate, ale musí být znovu posouzeno před release.                     |

## První remote běh a příčina selhání

První [GitHub Actions run 30754127879](https://github.com/modvolt/Site-Logbook/actions/runs/30754127879)
na `e90d866` selhal v `pnpm gate:release` na contract testu route manifestu. Stejných
402 API rout bylo pouze v jiném pořadí: generátor i test používaly výchozí
`localeCompare()`, jehož výsledek závisel na locale/platformě. Následující databázové
a MinIO kroky byly kvůli tomuto selhání korektně přeskočeny.

Po samostatném hlášení příčiny uživatel schválil výhradně úzkou opravu
deterministického řazení. Commit `12d57c5`:

- přidal stejný code-unit comparator do generátoru a contract testu;
- regeneroval `artifacts/api-server/src/generated/api-route-manifest.ts`;
- změnil pouze pořadí sedmi switchboard záznamů;
- nepřidal ani neodebral žádnou routu a nezměnil permission ani runtime logiku.

## Lokální ověření finálního headu

Kontroly proběhly v izolovaném čistém worktree větve PR:

| Kontrola                                 | Výsledek                            |
| ---------------------------------------- | ----------------------------------- |
| Route manifest generator a kontrakt      | PASS; 402/402 rout, contract 12/12  |
| Workspace typecheck                      | PASS; 4/4 projekty                  |
| Safe env + staging guard/evidence        | PASS; 16/16                         |
| Frontend unit                            | PASS; 127/127                       |
| Live-events unit                         | PASS; 15/15                         |
| API unit                                 | PASS; 296/296                       |
| API build                                | PASS                                |
| Frontend/PWA build                       | PASS                                |
| ESLint                                   | PASS; 0 warnings                    |
| Peer dependencies                        | PASS                                |
| Dependency audit                         | PASS pro práh moderate; 1 low nález |
| `git diff --check` a čistota PR worktree | PASS                                |

První cílený pokus přes `pnpm exec vitest` nenašel launcher shim a přímý Vitest v
sandboxu narazil na známé omezení přístupu `esbuild` k nadřazenému adresáři. Nebyl to
test failure: stejný nezměněný příkaz po povoleném spuštění mimo toto filesystem
omezení prošel 12/12. Celý hermetický a quality gate následně prošel.

## Finální remote quality gate

[GitHub Actions run 30754695026](https://github.com/modvolt/Site-Logbook/actions/runs/30754695026)
na přesném SHA `12d57c512550a1a273947cbc742f577faddc5f72` skončil stavem `success`.
Úspěšně proběhly:

- frozen instalace, `pnpm gate:quality` a `pnpm gate:release`;
- izolované API databázové suites na GitHub runneru;
- start a kontrola izolovaného MinIO;
- encrypted streaming object recovery drill;
- ukončení MinIO, post kroky a cleanup kontejnerů.

Jedinou anotací je neblokující upozornění, že `actions/checkout@v4`,
`actions/setup-node@v4` a `pnpm/action-setup@v4` používají Node.js 20 a runner je
vynuceně spustil na Node.js 24.

## Bezpečnostní hranice a nejasnosti

- PR je otevřený a mergeable draft; nebyl sloučen ani nasazen.
- Remote `main`, `modvoltapp.cz`, produkční DB, storage, mail a secrets zůstaly
  nedotčené.
- Remote CI použilo pouze izolovaný GitHub runner, PostgreSQL a MinIO. Nejde o
  autentizované testy skutečného stagingu ani o produkční recovery důkaz.
- Je nutné nezávisle zkontrolovat auth/authz, migrace, key custody, object recovery a
  hranice immutable retention.
- Musí být výslovně přijato pořadí migrací 0099 → 0101 a vyloučení rozpracované 0100.
- Stále chybí schválený staging owner, URL, dedikované identity, DB, storage, mail
  sandbox, cleanup pravidla a RPO/RTO.
