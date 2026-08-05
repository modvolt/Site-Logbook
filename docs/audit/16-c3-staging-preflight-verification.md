# R16-C3 – verifikace staging preflightu

Datum: 2026-08-05

## Rozhodnutí

Repozitářová část je připravena, ale živý staging rollout má stav **NO-GO**.
Produkce, Coolify konfigurace, GitHub environment, secrets, DB, S3, GHCR a DNS
nebyly změněny. Migrace `0105` nebyla spuštěna a feature flag nebyl zapnut.

## Read-only mapa aktuálního control plane

### Coolify

- Server `localhost` spravuje pouze environment `production`; samostatný staging
  resource ani spravovaná DB v seznamu není.
- Produkční aplikace `Modvolt` je Docker Compose resource, zdroj
  `modvolt/Site-Logbook`, branch `main`, doména `https://modvoltapp.cz`.
- UI ukazuje běžící commit `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`, stav
  health `unknown` a jednu neaplikovanou změnu Docker Compose vyžadující rebuild.
- Název `EXTERNAL_ACCOUNTS_ENABLED` v produkčním env seznamu přítomen není.
- Pro resource nejsou v Coolify nakonfigurované žádné scheduled tasks.
- Bylo provedeno pouze redigované čtení; žádné Save, rebuild, deploy, restart,
  stop, terminal command ani čtení secret hodnot.

### GitHub

- Environment `staging` existuje, ale povoluje pouze starou branch
  `agent/phase13-staging-gate`; má pětiminutový wait timer a žádného reviewera.
- Přítomné jsou jen `STAGING_ENVIRONMENT_ID` a nevyhovující
  `STAGING_MAIL_SANDBOX_CONFIRMED`; chybí obě URL a všechny tři staging secrets
  požadované smoke workflow.
- Neexistuje skutečný staging deployment ani staging artifact. Šest historických
  staging-smoke záznamů mělo failure a nula jobů.
- Privátní `modvolt/site-logbook-registry` existuje, ale jeho default branch
  obsahuje jen README. Wrapper je pouze v draft PR a nikdy nepublikoval image.
- Aktuální PR #14 je stacked, nikoli přímo proti `main`; dosavadní publisher jej
  proto nemůže přijmout.

## Implementovaná architektura

- Boundary preflight vyžaduje explicitní `flag=false`, exact SHA/manifest,
  migration confirmation a bounded backup evidence vstupy.
- Nový DB pre/postflight načte přesný migration bundle, odmítne `0100`, připne
  `0104`/`0105` hashe a snapshot chain a porovná exact DB migration set včetně
  hashů, extra řádků a duplicit.
- Pre/postflight běží v read-only repeatable-read transakci pod stejným advisory
  lockem jako standardní migrátor.
- Nejnovější backup řádek je svázán přes ID a musí mít success, nonempty object,
  size, SHA-256, `mve1`, key id, `restore_status=ok` a čerstvý restore timestamp.
  Log summary obsahuje pouze ID a stáří, ne path/hash/key/secret.
- One-shot schema gate je jediný writer a API je na jeho úspěchu závislé. API
  při každém startu opakuje read-only postflight a nespouští migrátor.
- Staging E2E a secret-free bootstrap artifact požadují přesně
  `0105_smooth_nitro`, 105/105, žádné missing tags, runtime false a nulový
  inventář externích účtů.
- GHCR publisher guard byl připraven pro candidate branch
  `agent/phase16c3-staging-preflight`; žádná publikace nebyla spuštěna.

## Provedené kontroly

- external schema preflight unit/contract: 11/11 PASS;
- staging guard + runtime contract: 24/24 PASS před rozšířením a 17/17 finální
  runtime slice PASS;
- staging runtime static gate: PASS;
- library TypeScript a staging E2E TypeScript: PASS;
- API TypeScript: PASS;
- API esbuild včetně `dist/external-schema-preflight.mjs`: PASS;
- wrapper bez env končí fail-closed kódem `ENV_MISSING`: PASS;
- ESLint full repository: PASS;
- Prettier pro podporované změněné soubory: PASS;
- YAML unique-key parse pro Compose a tři workflow: PASS;
- `git diff --check`: PASS;
- širší `test:staging-contract`: 44/53 PASS; zbývajících devět scénářů nebylo
  spuštěno, protože lokálně chybí offline Docker harness image. Jde o explicitní
  prerequisite, ne assertion failure; těžká část je ponechána exact-SHA CI.

## Nejasnosti a zbytková rizika

- Neexistuje izolovaný staging resource, doména, DB volume, storage, mail sandbox
  ani alert receiver; živý test proto nelze bezpečně spustit.
- Není read-only ověřen aktuální produkční DB journal. Obnovená produkční kopie
  proto může být za `0104`; před `0105` pak vyžaduje oddělený immutable baseline
  rollout na auditovaném predecessor SHA `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`,
  novou staging-only zálohu exact stavu `0104` a restore-test stejného ID.
- GitHub environment, publisher wrapper a draft PR stack musí být přepnuty na
  jeden auditovatelný candidate přímo proti `main`.
- Merge do `main` může ovlivnit produkční source branch a bez výslovného souhlasu
  je zakázán.
- SQL trigger custodiana kontroluje aktivního interního uživatele, ale nikoli
  efektivní `users.manage`; service/auth vrstva zůstává fail-closed. Jde o
  follow-up před pilotem, nikoli blokátor zero-row schema rollout.
- Trigger identity guardu je `BEFORE UPDATE`, nikoli `INSERT`; insert invarianty
  dnes zajišťuje schema shape + service vrstva. Před pilotem má být rozhodnuto,
  zda invariant rozšířit v nové migraci; `0105` se nyní nepřepisuje.
- Guarded rollback je bezpečný jen před prvním externím datovým záznamem.

Podrobný operační postup je v
[16-c3-staging-schema-gate-runbook.md](16-c3-staging-schema-gate-runbook.md).
