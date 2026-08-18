# FÁZE 13.8F – code publication a exact-SHA Quality gate

- **Datum dokončení:** 2026-08-03.
- **Repozitář:** `modvolt/Site-Logbook`.
- **PR:** [#1 – Security hardening, recovery readiness, and staging release gate](https://github.com/modvolt/Site-Logbook/pull/1).
- **Publikovaná větev:** `agent/phase13-staging-gate`.
- **Publikovaný exact SHA:** `aacb767be933e3589b40066f33d8ee0bac8939f4`.
- **Nezměněný `main`:** `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Verdikt:** **CODE PUBLICATION PASS / EXACT-SHA QUALITY GATE PASS / IMAGE PUBLICATION A DEPLOY NEPROVEDENY**.
- **Migrace `0100`:** nepřítomná v publikačním diffu, nespouštěná a nadále vyloučená.

## Publikační preflight

GitHub connector před zápisem potvrdil otevřený draft PR #1 s base `main`, head branch
`agent/phase13-staging-gate` a remote headem
`7f4bd719c951dffd58f7697253156c3cb7146b23`. Lokální worktree byl čistý a lokální
`aacb767be933e3589b40066f33d8ee0bac8939f4` byl přímým potomkem remote headu:

```text
remote behind / local ahead: 0 / 4
```

Fast-forward scope tvořily přesně čtyři commity:

1. `179a8dd2e8c87ef0c7b66e357759c550b9933888` – F13.8B checkpoint;
2. `bd113437102a706ec37e4282b5f64b08c6dd433d` – F13.8C capability preflight;
3. `3b5ac57bbc9b7630e015dbb804db0f9e19f14de2` – F13.8D decision gate;
4. `aacb767be933e3589b40066f33d8ee0bac8939f4` – immutable staging runtime hardening.

Diff obsahoval 21 očekávaných cest, 1743 vložených a 36 odstraněných řádků. `git
diff --check` prošel. Cílené jmenné ověření nenašlo migraci `0100` ani
`0100_user_ui_preferences`.

## Autorizovaný push

Uživatel výslovně schválil push commitů `179a8dd` až `aacb767` na
`origin/agent/phase13-staging-gate`. Push byl proveden bez force jako přesné refspec:

```text
aacb767be933e3589b40066f33d8ee0bac8939f4:
refs/heads/agent/phase13-staging-gate
```

První standardní pokusy skončily před zápisem: jeden na `dubious ownership`, druhý na
neautorizovaném výchozím SSH klíči a třetí na chybně escapované Windows cestě. Nebyla
změněna globální Git konfigurace, remote ani autentizační nastavení. Následný push použil
jen pro jeden proces existující repository deploy key, který GitHub read-only preflightem
rozpoznal jako `modvolt/Site-Logbook`. Výsledek byl fast-forward:

```text
7f4bd71..aacb767
```

Závěrečné nezávislé `git ls-remote` potvrdilo:

```text
aacb767be933e3589b40066f33d8ee0bac8939f4  refs/heads/agent/phase13-staging-gate
a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f  refs/heads/main
```

Lokální `gh` credential byl při preflightu neplatný; pro push ani ověření nebyl použit a
nebyl měněn nebo mazán.

## Remote exact-SHA Quality gate

Push automaticky spustil jediný PR workflow běh asociovaný connectorovým ověřením s
publikovaným SHA:

- **workflow:** `Quality gate`;
- **run:** [30829378906](https://github.com/modvolt/Site-Logbook/actions/runs/30829378906), číslo 6;
- **job:** `hermetic-release-gate`;
- **stav:** `completed`;
- **závěr:** `success`;
- **exact head:** `aacb767be933e3589b40066f33d8ee0bac8939f4`.

Zeleně skončily zejména:

- frozen instalace závislostí;
- `gate:quality` a `gate:release`;
- immutable staging runtime contract;
- staging guard, evidence a runtime contract testy;
- izolované PostgreSQL API suites;
- start a readiness izolovaného MinIO test targetu;
- encrypted streaming object recovery drill;
- odstranění MinIO a zastavení CI service kontejnerů.

Po dokončení GitHub connector znovu potvrdil PR `OPEN`, `draft=true`, `merged=false`,
`mergeable=true` a head přesně `aacb767be933e3589b40066f33d8ee0bac8939f4`.

## Negativní důkazy a hranice

- nebyl vydán žádný `workflow_dispatch` pro `.github/workflows/staging-images.yml`;
- nebyl proveden GHCR package write, image build/push ani stažení image na server;
- nebyl kontaktován Coolify, S3 provider, DNS, staging runtime ani produkce;
- nebyl vložen, čten ani měněn žádný aplikační secret;
- nebyla spuštěna DB migrace, API runtime ani migrace `0100`;
- PR zůstal draft, nebyl mergeován ani označen ready for review;
- `main` zůstal na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- CI MinIO byl pouze dočasný hermetický recovery target a workflow jej úspěšně
  odstranil; staging runtime nadále používá samostatný externí S3 kontrakt.

## Nevyřešené otázky před image publication

1. Je Coolify host potvrzen jako `linux/amd64`?
2. Budou GHCR packages veřejné, nebo privátní se staging-only read credentialem?
3. Má uživatel samostatně schválit čtyři GHCR image zápisy a spuštění přesného
   `staging-images.yml` workflow pro `aacb767…`?
4. Jak se po publikaci ověří čtyři `repository@sha256` reference a secret-free digest
   manifest bez deploye?
5. AWS/provider a user-owned staging origin zůstávají nerozhodnuté a nadále blokují
   provisioning i první deploy, nikoli samotnou image publication.
