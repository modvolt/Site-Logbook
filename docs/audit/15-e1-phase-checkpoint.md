# FÁZE R15-E1 – checkpoint

- **Datum:** 2026-08-05
- **Stav:** REPO-LEVEL R15-E1 DOKONČENA; EXACT-SHA QUALITY GATE PROŠEL
- **Větev:** `agent/phase15e-staging-workflow-validation`
- **Základ:** `d82baca4c84b0f007c6139797689aacff5be47c7`
- **Draft PR:** [#10](https://github.com/modvolt/Site-Logbook/pull/10), stacked na
  `agent/phase15d-dead-letter-requeue`
- **Implementační commit:** `6045dcac2c2c90ecf6ddee96882c462ec111bf2e`
- **GitHub CI:** [Quality gate 30963167977](https://github.com/modvolt/Site-Logbook/actions/runs/30963167977),
  PASS
- **Staging/produkce:** beze změny; manuální workflow nebylo spuštěno
- **Migrace:** žádná změna ani aplikace; `0103` nenasazena, `0100` nezařazena

## Uložené výstupy

- [centrální verifikační registr](15-e1-staging-workflow-validation-verification.md);
- úzká oprava umístění `runner.temp` v manuálním workflow;
- regresní test triggeru a GitHub expression context boundary.

## Kontroly

- 4/4 cílené operational alert drill testy: PASS;
- 35/35 non-Docker staging kontraktů: PASS;
- strict YAML, ESLint, TypeScript a `git diff --check`: PASS;
- push exact SHA bez zero-job `staging-smoke` validačního běhu: PASS;
- GitHub Quality gate včetně izolovaných DB, recovery a fault gate: PASS.

## Jednoznačný checkpoint

Repozitář obsahuje platné, výhradně manuální staging smoke workflow. R15-E1
neautorizuje merge, `workflow_dispatch`, staging nebo produkční deploy, GHCR
publikaci, DNS/TLS/secret změnu, migraci ani fault injection.

## Nejasnosti a zbytková rizika

- externí staging aplikace a receiver nejsou v tomto checkpointu provisionované;
- staging secrets, image provenance, záloha a migrace `0103` nebyly ověřeny;
- skutečné durable delivery, restart-volume, dead-man a log-alert drilly čekají;
- workflow musí zůstat bez automatického triggeru;
- širší statická kontrola všech GitHub expression contextů by vyžadovala připnutý
  `actionlint`; není podmínkou této úzké opravy.

## Doporučení pro další část

- **další fáze:** R15-E2 – izolovaná staging aktivace a provozní drilly;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** další část kombinuje externí secrets, privátní
  image provenance, kopii produkčních dat, migraci a řízenou fault injection;
- **očekávané činnosti:** provisionovat oddělené staging DNS/TLS a receiver,
  nastavit staging environment, publikovat exact-SHA image, ověřit zálohu,
  aplikovat `0103` pouze na staging, nasadit exact SHA a ručně provést staging
  smoke i alert/restart/dead-man drilly;
- **soubory, které budou pravděpodobně změněny:** pouze staging evidence a
  checkpoint dokumentace, případně úzké opravy rollout skriptů odhalené drillem;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano, může
  aplikovat již existující `0103` pouze na staging a provádět fault injection;
  produkce zůstává mimo rozsah bez nového výslovného schválení.
