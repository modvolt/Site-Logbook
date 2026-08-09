# Checkpoint R16-C3C1 – exact-SHA CI a fixed predecessor publisher

Datum: 2026-08-09

## Stav checkpointu

**R16-C3C1 je dokončena v lokálním repozitáři.** Implementační commity na větvi
`agent/phase16c3-staging-preflight` jsou:

- `a66bc2fcf5e0dd0dfbd45c450783b12d61c1c10f` – připnutí CI Actions, oddělený
  fixed predecessor publisher a offline validátor jeho evidence;
- `820a3fc62da1c6e11b19b95c7de7b770374ac1c8` – fail-closed kontrakt privátního
  ručního wrapperu.

Produkční Coolify resource `Modvolt`, produkční DB/S3, DNS, secrets, GitHub
environment a GHCR zůstaly beze změny. Nebyl spuštěn Docker, deploy, registry
write ani migrace `0104`, `0105` nebo `0100`.

Větev zatím není na GitHubu. `gh auth status` v této Codex relaci stále vrací
neplatný token účtu `modvolt`. Public `ls-remote` přes explicitní HTTPS helper
potvrdil remote `main` a absenci candidate větve, ale push dry-run skončil bez
přihlašovacích údajů. Privátní registry repo proto nebylo měněno a draft PR ani
CI run nevznikly.

## Dokončená architektura

1. `quality-gate.yml` a `staging-smoke.yml` už nepoužívají mutable `@v4`.
   Checkout, pnpm setup, Node setup a artifact upload jsou připnuté na konkrétní
   commity ověřené v primárních GitHub repozitářích. Checkout nepersistuje
   credentials.
2. Runtime kontrakt parsuje všechny `uses:` v obou workflow, vyžaduje přesný
   allowlist, pořadí i počet a odmítne mutable ref, jiné SHA nebo přidanou Action.
3. Nový reusable workflow `staging-predecessor-image.yml` nemá vstup pro SHA,
   ref ani PR. Je natvrdo svázán s predecessorem
   `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3` a tree
   `cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c`.
4. Publisher znovu ověří exact HEAD/tree, 104 SQL souborů, 104 journal řádků,
   tail `0104_thin_sheva_callister` a absenci `0100`/`0105`. Publikuje pouze API
   image pro `linux/amd64`, s provenance a SBOM, do existujícího privátního
   `site-logbook-staging-api` package.
5. Exact predecessor tag smí být pouze absent a jednou publikovaný nebo již
   jednou přítomný a vzdáleně ověřený no-op. Před zápisem se absence opakuje;
   duplicate, jiný caller/package/digest/platform nebo neprivátní package jsou
   stop.
6. Secret-free `staging-predecessor-image.json` váže source, tree, migration
   contract, caller workflow/run, image digest, package/version IDs, remote OCI
   manifest, provenance a SBOM. Nový offline validátor hashuje raw bytes, ověří
   GNU sidecar i odděleně schválený checksum a odmítá secret-shaped obsah.
7. Privátní wrapper template je manual-only, main-only, owner-only, bez
   `secrets: inherit`, arbitrary SHA a deployment surface. Je připnutý přímo na
   implementační commit `a66bc2f` veřejného reusable workflow.

## Uložené výstupy

- `.github/workflows/staging-predecessor-image.yml`;
- `scripts/verify-staging-predecessor-image.mjs`;
- `scripts/test/staging-predecessor-image.test.mjs`;
- `docs/audit/16-c3-private-predecessor-wrapper.template.yml`;
- připnuté `.github/workflows/quality-gate.yml` a
  `.github/workflows/staging-smoke.yml`;
- rozšířený runtime kontrakt, mutation testy, package scripts a schema-gate
  runbook.

## Ověření

- bez-Dockerová staging guard/evidence/runtime/proxy/alert sada: **56/56 PASS**;
- cílená predecessor + runtime mutation sada: **26/26 PASS**;
- staging runtime kontrakt: **PASS**;
- ESLint změněných JavaScript souborů: **PASS**;
- Prettier všech změněných podporovaných souborů: **PASS**;
- YAML unique-key parse public publisheru a private wrapper template: **PASS**;
- `package.json` parse: **PASS**;
- exact predecessor commit/tree/journal/SQL inventář: **PASS**;
- `git diff --check`: **PASS**;
- pracovní strom před checkpoint dokumentem: **clean**.

Docker workflow-execution matrix nebyla spuštěna, protože host Docker je v této
auditní řadě evidován jako nefunkční a uživatel požaduje chránit stabilitu PC.

## Nejasnosti a zbývající práce

1. Uživatelské ověření `gh` se nepropsalo do prostředí tohoto Codex procesu.
   Remote write proto nebyl bezpečně možný.
2. Public candidate větev musí být publikována bez force-push, musí vzniknout
   draft PR přímo proti `main` a exact final SHA musí získat zelený Quality gate.
3. Až potom lze template vložit jako
   `.github/workflows/publish-staging-predecessor.yml` do privátního
   `modvolt/site-logbook-registry/main` a znovu ověřit jeho skutečný remote obsah.
4. Samotný GHCR predecessor write nebyl autorizován ani spuštěn. Vyžaduje
   samostatný explicitní souhlas po kontrole private wrapperu a public CI.
5. Publisher pouze připravuje immutable image. Runtime cesta
   `apply-0104-baseline`, oddělený manifest/input checksum, fresh staging backup,
   preflight `BASELINE_0104_REQUIRED` a postflight exact `READY_0104` ještě nejsou
   implementovány. Kandidátní `0105` gate se nesmí obcházet.

## Doporučení pro další spuštění

- další fáze: R16-C3C2 – remote candidate publikace, draft PR, exact-SHA CI a
  instalace privátního predecessor wrapperu bez GHCR spuštění;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: je nutné bezpečně sladit lokální 136-commitovou větev
  s dosud neexistujícím remote refem, zachovat exact commity, ověřit draft PR a
  CI vazbu a zapsat pouze commit-pinned wrapper do jiného privátního repozitáře;
- očekávané činnosti: obnovit autentizaci přímo v Codex exec prostředí, read-only
  ověřit oba repozitáře, push bez force, vytvořit draft PR proti `main`, počkat na
  exact-SHA Quality gate, vložit a validovat privátní wrapper; GHCR workflow
  nespouštět;
- soubory, které budou pravděpodobně změněny: v public repo pouze případné úzké
  CI opravy a checkpoint; v private repo
  `.github/workflows/publish-staging-predecessor.yml` a jeho validator/testy nebo
  README;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migrace,
  Coolify deploy, DNS, secrets a GHCR write obsahovat nemá. Obsahuje externí Git
  branch/PR/CI změny a commit do privátního registry repozitáře. Jakýkoli GHCR
  write zůstává další samostatně schvalovanou rizikovou operací.

## Stop

Checkpoint R16-C3C1 je vytvořen. R16-C3C2 ani runtime baseline fáze se v tomto
běhu automaticky nezahajuje.
