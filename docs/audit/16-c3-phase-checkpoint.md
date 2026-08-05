# Checkpoint R16-C3A – fail-closed staging schema gate

Datum: 2026-08-05

## Stav checkpointu

**R16-C3A je dokončena na úrovni lokálního repozitáře.** Implementační commit je
`09e9f08` (`gate isolated external schema rollout`) na branch
`agent/phase16c3-staging-preflight`.

Commit zatím nebyl pushnut a nemá draft PR ani exact-SHA CI, protože aktuální
`gh auth status` hlásí neplatný token, HTTPS Git nemá credentials a SSH GitHub
odmítá public key. Produkce, Coolify, GitHub environment, GHCR, DNS, secrets, DB,
S3 i mail zůstaly beze změny. Migrace `0105` nebyla aplikována, `0100` zůstává
vyloučená a feature flag nebyl zapnut.

Rozsah byl kvůli chybějícímu stagingu a control-plane vstupům rozdělen:

- R16-C3A – dokončená repo implementace a read-only mapa;
- R16-C3B – candidate publikace, baseline `0104` a izolovaný staging provisioning;
- R16-C3C – samostatně schválená aplikace `0105` s flagem stále `false` a dark
  smoke.

## Uložené výstupy

- [16-c3-staging-preflight-verification.md](16-c3-staging-preflight-verification.md)
  – centrální registr read-only topologie, implementace, kontrol a rizik;
- [16-c3-staging-schema-gate-runbook.md](16-c3-staging-schema-gate-runbook.md) –
  přesný baseline, pre/migrate/post, backup bind, stop a rollback postup;
- DB-free unit/contract testy exact journal/hash/schema/backup gate;
- API image entrypoint a hardened one-shot staging orchestrace;
- explicitní `flag=false` guard, exact `0105` E2E a secret-free bootstrap evidence;
- Quality gate zapojení a candidate-branch publisher guard.

## Shrnutí architektury

- Boundary preflight failne ještě před PostgreSQL při chybějícím confirmation,
  SHA/manifest driftu, neplatném backup ID/age nebo flagu jiném než `false`.
- DB pre/postflight pracuje pod advisory lockem `911072468` v read-only
  repeatable-read snapshotu a porovnává exact `(created_at, hash)` migration set.
- Pre-mode povolí pouze přesných 104 migrací do `0104`, žádné objekty `0105`,
  žádné extra/duplicate řádky a žádnou `0100`.
- Nejnovější backup řádek musí být přesně svázaný ID, úspěšný, neprázdný,
  SHA-256 označený, `mve1` šifrovaný a čerstvě restore-testovaný.
- Jediný one-shot writer spustí standardní migrátor. Post-mode vyžaduje 105/105,
  kompletní validované schema/triggery a nulu externích dat.
- API startuje až po gate a při každém restartu opakuje postflight; startup API už
  migrace automaticky neprovádí.
- Staging smoke vyžaduje exact `0105_smooth_nitro`, 105/105,
  `runtimeEnabled=false` a prázdný externí inventář.

## Kontroly

- external schema preflight: 11/11 PASS;
- staging release guard + runtime contracts: 24/24 PASS;
- staging static runtime gate: PASS;
- library, API a staging E2E TypeScript: PASS;
- API esbuild včetně `dist/external-schema-preflight.mjs`: PASS;
- full ESLint: PASS;
- podporované soubory Prettier: PASS;
- Compose a workflow YAML unique-key parse: PASS;
- `git diff --check`: PASS;
- širší staging contract: 44/53 assertions PASS; devět Docker harness scénářů
  nebylo lokálně dostupných kvůli chybějící offline image a musí je potvrdit CI.

## Nejasnosti a podstatné překážky

1. Obnovit GitHub autentizaci; bez ní nelze pushnout `09e9f08`, otevřít přímý
   candidate PR proti `main` ani spustit exact-SHA CI.
2. V Coolify neexistuje izolovaný staging. Produkční resource je zakázaný target.
3. Produkční backup journal nebyl čten. Pokud je za `0104`, musí R16-C3B nejprve
   nasadit immutable predecessor baseline. Auditovaný predecessor SHA je
   `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3` a jeho journal končí na `0104`.
4. GitHub environment stále povoluje starou phase13 branch a chybí URL/secrets.
   Privátní registry wrapper není na default branch a dosud nic nepublikoval.
5. `main` je source branch produkční aplikace. Merge zůstává zakázaný bez
   samostatného výslovného souhlasu, i kdyby produkční auto-deploy nebyl aktivní.
6. Před pilotem zbývá rozhodnout DB zesílení custodian `users.manage` a identity
   INSERT guardu. `0105` se v této fázi nepřepisuje.

## Doporučení pro další spuštění

- další fáze: R16-C3B – obnovit GitHub publish cestu, vytvořit jeden auditovatelný
  candidate PR přímo proti `main`, potvrdit exact-SHA CI, připravit privátní
  predecessor/candidate image manifesty a zřídit izolovaný staging bez spuštění
  `0105`;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze propojuje stacked Git historii, immutable GHCR
  provenance, produkčně citlivý `main`, obnovu produkční kopie do izolované DB a
  bezpečný baseline na přesný predecessor `0104`;
- očekávané činnosti: znovu ověřit `gh`, pushnout candidate branch bez force,
  otevřít draft PR proti `main`, nechat doběhnout Quality gate, upravit pouze
  staging branch policy a privátní registry wrapper, vytvořit oddělenou Coolify
  aplikaci/DB/S3/mail/alert topologii, obnovit zálohu, read-only zjistit journal a
  případně provést samostatně schválený baseline pouze do `0104`;
- soubory, které budou pravděpodobně změněny: checkpoint/evidence dokumentace,
  private `modvolt/site-logbook-registry` wrapper a případně úzké candidate
  workflow testy; produkční Compose ani produkční env se měnit nemají;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: ano – může
  publikovat privátní GHCR artifacts, měnit pouze staging GitHub policy a po
  samostatném souhlasu migrovat izolovanou staging kopii do `0104`. Aplikace
  `0105`, pilot, merge do `main` a produkce zůstávají mimo R16-C3B.

## Stop

Checkpoint R16-C3A je vytvořen. R16-C3B se automaticky nezahajuje.
