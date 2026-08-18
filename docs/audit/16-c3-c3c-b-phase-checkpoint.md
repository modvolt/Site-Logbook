# Checkpoint R16-C3C3C-B – fixed predecessor dispatch fail-closed

Datum: 2026-08-09

## Výsledek

**Jediný schválený fixed predecessor dispatch byl proveden, ale publisher skončil
fail-closed před buildem a před GHCR zápisem.**

Run:
[`31335035618`](https://github.com/modvolt/site-logbook-registry/actions/runs/31335035618)

- event: `workflow_dispatch`;
- private ref: `main`;
- private head: `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`;
- actor / triggering actor: `modvolt` / `modvolt`;
- attempt: `1`;
- conclusion: `failure`;
- jediný job: `validate-manual-owner` (`93299393091`) – `success`;
- called reusable ref byl rozpoznán jako
  `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`;
- artifacts: `0`;
- post-failure GHCR container packages: `0`;
- post-failure target `site-logbook-staging-api`: `0`.

Schválení jednoho dispatch bylo spotřebováno. Nebyl proveden rerun ani druhý
dispatch. Produkce, deploy, Coolify, DB, S3, DNS a migrace zůstaly beze změny;
`0100` zůstává nezařazena a `0105` nebyla spuštěna.

Centrální registr je v
[16-c3-staging-preflight-verification.md](16-c3-staging-preflight-verification.md#r16-c3c3c-b--prvni-fixed-predecessor-dispatch-skoncil-fail-closed).

## Root cause – stav důkazu

GitHub Actions API ani CLI nevydaly run-level anotaci. Úplný job seznam však
prokazuje, že selhání nastalo mezi úspěšným caller owner gate a vytvořením
prvního reusable jobu. Build, tokenový package preflight ani GHCR klient se
nespustily.

Vysoce pravděpodobná příčina je self-collision workflow concurrency:

- private wrapper:
  `group: site-logbook-images-publication`, `cancel-in-progress: false`;
- called reusable:
  `group: site-logbook-images-publication`, `cancel-in-progress: false`;
- historický candidate caller používal odlišný
  `group: site-logbook-registry-publication`, zatímco jeho reusable používal
  `site-logbook-images-publication`.

GitHub v jednom concurrency group připouští nejvýše jednu aktivní lease a
reusable lease se vyhodnocuje v caller kontextu. Pozorovaný okamžitý failure bez
called jobu je s touto kolizí konzistentní. Protože chybí přímá run anotace,
zůstává toto zjištění označeno jako **high-confidence inference** do ověření
opravy jedním budoucím během.

## Navržená úzká oprava

1. Ponechat public reusable group `site-logbook-images-publication`.
2. Změnit pouze private wrapper template group na
   `site-logbook-registry-publication`.
3. Rozšířit runtime kontrakt a mutation test tak, aby:
   - oba private caller publishery sdílely `site-logbook-registry-publication`;
   - caller group byl odlišný od reusable group;
   - `cancel-in-progress` zůstal `false`.
4. Publikovat opravu standardním public exact-head CI a samostatným private PR;
   private merge vyžaduje samostatné schválení.
5. Teprve po novém výslovném souhlasu povolit nový jediný dispatch/GHCR zápis.

Pravděpodobně dotčené veřejné soubory:

- `docs/audit/16-c3-private-predecessor-wrapper.template.yml`;
- `scripts/check-staging-runtime-contract.mjs`;
- `scripts/test/staging-runtime-contract.test.mjs`;
- auditní checkpointy.

Private repo následně změní pouze odpovídající wrapper group na nové větvi/PR.

## Provedené kontroly

- před-dispatch atomický preflight: PASS;
- exact source/tree, wrapper hash, public PR head a Quality run: PASS;
- před-dispatch GHCR target count: `0`;
- před-dispatch queued/running publisher runs: `0`/`0`;
- přesně jeden dispatch: potvrzen runem `31335035618`;
- úplný post-run job a artifact audit: jeden owner job, nula artifacts;
- post-run GHCR inventura: stále nula packages;
- browser fallback nepřidal důkaz, protože in-app browser nebyl přihlášen k
  privátnímu GitHubu; žádná UI akce nebyla provedena.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-B1 – po výslovném schválení implementovat a ověřit úzké
  oddělení caller/reusable concurrency groups, bez nového dispatch;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: oprava mění serializaci dvou publish cest a musí
  zabránit jak self-deadlocku, tak souběžnému append-only GHCR zápisu;
- očekávané činnosti: upravit template/kontrakt/mutation test, spustit cílené a
  plné relevantní gate, vytvořit public commit a exact-head CI, připravit
  samostatný private PR; bez dispatch a bez GHCR zápisu;
- soubory, které budou pravděpodobně změněny:
  `docs/audit/16-c3-private-predecessor-wrapper.template.yml`,
  `scripts/check-staging-runtime-contract.mjs`,
  `scripts/test/staging-runtime-contract.test.mjs` a checkpoint; následně jedna
  wrapper řádka v private repo;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: žádné DB
  migrace, deploy ani GHCR write. Obsahuje GitHub workflow změnu a případný
  private PR/merge, každý za vlastní schvalovací branou.

## Stop

Checkpoint je vytvořen. Publisher zůstává opravitelný, ale nespouštěný; nový
dispatch ani GHCR zápis nejsou autorizovány.
