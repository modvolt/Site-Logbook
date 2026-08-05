# Checkpoint R16-C3B1 – staging inventory a restart gate

Datum: 2026-08-05

## Stav checkpointu

**R16-C3B1 je dokončena v lokálním repozitáři.** Implementační commit je
`d26c5fa49a3d8d6e6720b963b4551d32736bf803` na branch
`agent/phase16c3-staging-preflight`.

Produkční Coolify resource, `main`, produkční DB/S3, DNS, GitHub environments,
GHCR a secrets zůstaly beze změny. Migrace `0105` ani `0100` nebyla spuštěna.
Větev nebyla publikována, protože `gh auth status` v tomto běhu stále hlásí
neplatný token. GitHub connector potvrdil, že remote branch ani lokální commity
na GitHubu neexistují; nízkoúrovňová rekonstrukce commitů nebyla použita.

## Dokončený rozsah

- oddělen režim `inspect` pro obnovu a read-only klasifikaci migration journalu;
- přidán režim `apply-0105`, který jako jediný přijme mutation confirmation,
  sváže čerstvou zálohu a spustí standardní migrátor;
- přidán režim `steady-0105` pro idempotentní redeploy a běžný restart;
- read-only inventory přijímá pouze exact journal prefix a vrací
  `BASELINE_0104_REQUIRED`, `READY_0104` nebo `ALREADY_0105`;
- unknown/extra/middle-gap řádky, duplicate, hash drift, `0100` a stav za `0105`
  jsou fail-closed;
- state-aware gate při exact `0105` provede no-op místo chybného požadavku na
  návrat k `0104`;
- startup API ověřuje exact 105/105, schema, `flag=false` a nulová externí data,
  ale již nezávisí na stárnoucím ID/freshness přechodové zálohy;
- Compose, env příklad, runbook a runtime kontrakty odpovídají novému pořadí;
- opraven zastaralý API kontrakt, který očekával implicitní staging flag místo
  fail-closed povinné hodnoty.

## Ověření

- external schema DB-free testy: 13/13 PASS;
- staging guard/evidence/runtime/proxy/alert statická sada: 42/42 PASS;
- staging runtime kontrakt: 17/17 PASS;
- POSIX syntax boundary preflightu: PASS;
- library TypeScript: PASS;
- API TypeScript: PASS;
- API esbuild včetně inventory/gate/steady-state entrypointů: PASS;
- cílený external-account API kontrakt: 5/5 PASS;
- cílený ESLint změněných zdrojů: PASS;
- Compose a tři workflow YAML unique-key parse: PASS;
- `git diff --check`: PASS.

Docker execution harness nebyl spuštěn. Host měl přibližně 10,64 GiB volné RAM,
ale Docker daemon neodpovídal, `com.docker.service` byla zastavená a existovalo
39 visících `docker.exe` procesů s přibližně 807 MiB RAM. Spuštění 85 dalších
krátkodobých kontejnerů by zbytečně ohrozilo stabilitu počítače. Tři statické
workflow-harness scénáře dříve prošly 3/3; plná matice zůstává pro exact-SHA CI.

## Nejasnosti a zbývající práce

1. Obnovit lokální GitHub autentizaci, provést normální exact commit push a
   otevřít draft PR přímo proti `main`; connector není bezpečnou náhradou git
   object pushu.
2. Svázat pět immutable image referencí s přesným `staging-images.json` a jeho
   checksumem, ne pouze se syntaxí digestu a `sourceSha`.
3. Doplnit secret-free provisioning manifest/validator pro Coolify resource,
   veřejné domény/porty, volumes, limity a explicitní nulový dotyk produkce.
4. Zpřesnit finální evidence schema na exact `0105_smooth_nitro`, 105/105,
   `flag=false`, nulová externí data, backup bind a bootstrap artifact hash.
5. Připravit striktně připnutou immutable predecessor publication cestu pro
   `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`; nesmí přijmout libovolný starý SHA.
6. Izolovaný staging, DNS/TLS, Hetzner S3 bucket/credentials, mail sandbox a
   alert receiver zatím fyzicky neexistují. Produkční resource není povolený
   náhradní target.

## Doporučení pro další spuštění

- další fáze: R16-C3B2 – immutable image/deployment manifest binding,
  provisioning contract a exact-0105 evidence schema;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: změna propojuje supply-chain provenance, pět GHCR
  digestů, secret-free deployment vstupy, Coolify izolaci a auditní důkaz bez
  možnosti zaměnit staging za produkci;
- očekávané činnosti: přidat offline manifest/checksum validator, deployment
  input hash, provisioning manifest a fail-closed testy; podle aktuální
  autentizace případně normálně pushnout kandidátní větev a otevřít draft PR;
- soubory, které budou pravděpodobně změněny: staging validační skripty a testy,
  `.env.staging.example`, `docker-compose.staging.yml`, evidence template/checker,
  auditní dokumentace a případně privátní registry wrapper;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migraci
  obsahovat nemá. Může připravit nebo po funkční autentizaci publikovat privátní
  GHCR/GitHub artifacts a měnit pouze staging control plane; merge do `main`,
  produkce, aplikace `0105` a feature enablement zůstávají zakázané.

## Stop

Checkpoint R16-C3B1 je vytvořen. Další podfáze se v tomto běhu nezahajuje.
