# R15-E1 – ověření validace manuálního staging workflow

## Rozsah

R15-E1 opravuje pouze statickou validaci `.github/workflows/staging-smoke.yml`.
Nic nenasazuje, nespouští `workflow_dispatch`, nečte staging secrets, nepublikuje
image, nemění DNS/TLS ani produkci a neaplikuje databázovou migraci. Migrace
`0103` zůstává nenasazena; `0100` zůstává nezařazena.

## Kořen chyby a oprava

Workflow používalo `${{ runner.temp }}` v `jobs.authenticated-staging-smoke.env`.
Kontext `runner` podle [matice dostupnosti GitHub Actions
kontextů](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
není na úrovni `jobs.<job_id>.env` dostupný. GitHub proto odmítl workflow ještě
před vytvořením jobu.

Proměnná `STAGING_ALERT_DRILL_EVIDENCE_FILE` byla přesunuta pouze do `env`
konkrétního kroku, který spouští alert drill. Cesta uploadu evidence ani samotný
drill se nezměnily.

Regresní test nyní:

- přísně parsuje workflow jako unique-key YAML;
- vyžaduje jediný trigger `workflow_dispatch`;
- zakazuje `${{ runner.* }}` v job-level `env`;
- vyžaduje evidence path právě u jediného alert-drill kroku.

## Ověření

Lokálně bez Dockeru:

- strict unique-key YAML parse: PASS;
- cílené testy operational alert drillu: 4/4 PASS;
- non-Docker staging kontrakty: 35/35 PASS;
- cílený ESLint: PASS;
- TypeScript kontrola skriptů: PASS;
- `git diff --check`: PASS.

GitHub:

- draft PR [#10](https://github.com/modvolt/Site-Logbook/pull/10) je stacked na
  `agent/phase15d-dead-letter-requeue`;
- implementační SHA `6045dcac2c2c90ecf6ddee96882c462ec111bf2e`;
- push tohoto exact SHA nevytvořil žádný zero-job `staging-smoke` běh;
- [Quality gate 30963167977](https://github.com/modvolt/Site-Logbook/actions/runs/30963167977):
  PASS za 9 minut 39 sekund;
- quality/release, immutable runtime, publisher harness, staging kontrakty,
  izolované API DB testy, encrypted backup/restore, streaming recovery a R14
  full-stack/fault gate: PASS.

## Bezpečnostní hranice

Workflow zůstává výhradně manuální. Tento checkpoint neautorizuje jeho spuštění.
Skutečný smoke zapisuje a maže storage sondu a vytváří syntetický alert, proto
nesmí získat `push` ani `pull_request` trigger. Statickou kontrolu změn zajišťuje
PR Quality gate.

Manuální workflow je na GitHubu běžně dostupné až po přítomnosti souboru na
výchozí větvi. R15-E1 proto dokazuje platnost repo kontraktu, nikoli připravenost
neexistujícího externího staging prostředí.

## Zbývající externí podmínky R15-E

- oddělené staging DNS/TLS pro aplikaci a alert receiver;
- staging proměnné a secrets bez použití produkčních credentials;
- privátní GHCR image připnuté na exact SHA;
- ověřená záloha staging kopie produkčních dat;
- aplikace migrace `0103` pouze na staging;
- exact-SHA deploy a durable/restart/dead-man/log-alert drilly.

