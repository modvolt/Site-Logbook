# FÁZE 13.5C – GitHub publish readiness

- **Datum:** 2026-08-02.
- **Lokální větev:** `agent/phase13-4-remediation`.
- **Lokální head:** `397a295d2489ce092a95fa57821c3a9f30b40edf`.
- **Existující draft PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1).
- **Vzdálený PR head:** `12d57c512550a1a273947cbc742f577faddc5f72`.
- **Vzdálený main:** `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Verdikt:** **READY FOR EXPLICIT PUSH AUTHORIZATION**.
- **Remote/produkce:** žádný ref, PR, workflow, staging ani produkční stav nebyl změněn.
- **Migrace 0100:** nepřítomná a nedotčená.

## Živý GitHub stav

GitHub connector a veřejné read-only API potvrdily:

- repozitář `modvolt/Site-Logbook` je aktivní, výchozí větev je `main` a připojený
  GitHub účet má `admin` oprávnění;
- PR #1 je otevřený, mergeable draft z `agent/phase13-staging-gate` do `main`;
- PR head je stále `12d57c5`, base SHA `a25c312`;
- review submissions: 0, review threads: 0, komentáře: 0;
- poslední Quality gate run `30754695026` je `completed/success`, ale pouze pro
  původní head `12d57c5`;
- vzdálená větev `agent/phase13-4-remediation` neexistuje.

PR body je po případném publishnutí nutné aktualizovat: dnes uvádí starý head,
43 commitů, API 296/296 a původní remote gate. Nový kandidát by měl 51 commitů a
lokální API gate 306/306; vzdálený výsledek pro nový SHA zatím neexistuje.

## Autentizace a transport

| Kanál | Stav | Důkaz a omezení |
| --- | --- | --- |
| GitHub connector | **PASS** | Připojený účet `modvolt`, repo permission `admin`; použit pouze read-only. |
| `gh` CLI 2.97.0 | **FAIL** | `gh auth status` hlásí neplatný default token a `gh api user` vrací HTTP 401. Veřejné endpointy fungují bez přihlášení. |
| Výchozí SSH | **FAIL** | Bez configu/agentu se správný repo klíč nenabízí; `ssh-agent` je zastavený/disabled. |
| `id_rsa` | **FAIL** | GitHub klíč nepřijal. |
| `site_logbook_codex_20260802` | **FAIL** | GitHub klíč nepřijal. |
| `site_logbook_codex_20260712` | **PASS** | GitHub odpověděl `Hi modvolt/Site-Logbook!`; fingerprint `SHA256:g2peNhyDcTOSzf1YtruNK/O68CJ+yydW4cNjEZuwN60`. |
| Explicitní SSH `git ls-remote` | **PASS** | Vrací `main=a25c312`, PR větev `12d57c5`; remediation ref chybí. |
| Exact PR push `--dry-run` | **PASS** | Náhled je čistý fast-forward `12d57c5..397a295` na `agent/phase13-staging-gate`. Následný `ls-remote` znovu vrátil `12d57c5`. |

Není nutné měnit globální SSH nebo Git konfiguraci. Pro publikaci lze použít správný
repo klíč pouze v procesu konkrétního příkazu. `gh` token není pro samotný Git push
nutný; PR metadata lze po samostatném souhlasu změnit přes GitHub connector.

## Přesný publish delta

- 8 nových lineárních commitů, 0 merge commitů;
- 25 změněných/přidaných souborů;
- 1 610 přidaných a 42 odstraněných řádků před tímto checkpointem;
- remote PR head je přímý předek lokálního headu;
- po publishnutí by PR obsahoval 51 commitů proti base SHA;
- diff ani tracked tree neobsahují `0100`.

Commity v pořadí publikace:

1. `4fadfd91b5dfb28b1985b0f826d29b486cd44197` – checkpoint 13.1;
2. `0c93f9f8765e7838cf399f95ae2a474444752d8b` – checkpoint 13.2;
3. `4d04cd14c8bedda805ba6133ad56d21ae8a5d3e0` – checkpoint 13.3;
4. `250d0f343439ee617d86086f58965e998e955172` – release blocker remediation;
5. `e79bda6fa2bb3d0352328d34bfe537be33b908b0` – checkpoint 13.4;
6. `b9190c5ad481ebb2c4accc0a1d7ac65f9e899e79` – re-review 13.5A;
7. `2392425756eeb450b4fe1e737f00dad516769d6c` – F13.5-01 remediation;
8. `397a295d2489ce092a95fa57821c3a9f30b40edf` – checkpoint 13.5B.

Tento checkpoint vytvoří devátý dokumentační commit. Proto musí další fáze před
pushnutím načíst nový lokální head a použít právě ten, nikoli zde uvedený předchozí
head `397a295`.

## Bezpečný postup pro autorizované publishnutí

Po novém výslovném souhlasu:

1. ověřit čistý worktree a aktuální lokální full SHA;
2. přes explicitní repo klíč znovu načíst remote PR ref a vyžadovat přesně
   `12d57c512550a1a273947cbc742f577faddc5f72`;
3. zopakovat `git push --dry-run` aktuálního SHA na
   `refs/heads/agent/phase13-staging-gate`;
4. provést jediný normální fast-forward push bez `--force`;
5. ověřit remote ref proti přesnému lokálnímu SHA;
6. přes GitHub connector aktualizovat PR body na nový head, počet commitů a aktuální
   lokální/remote evidence;
7. počkat na nový Quality gate run přesného SHA. Neprovádět staging, merge ani deploy.

Pokud se remote head od `12d57c5` odchýlí, publishnutí se musí zastavit a delta znovu
posoudit. Nesmí být použit force push.

## Nevyřešené blokátory po publishnutí

- nový remote PostgreSQL 16 quality gate přesného SHA;
- nezávislé security review;
- staging Environment a oddělený owner/tester/rollback approver;
- service-owner rozhodnutí k PPE `--max-age-days` a token lifecycle;
- samostatná autorizace stagingu, merge a deploye.
