# Checkpoint R16-C3B2 – immutable deployment a evidence binding

Datum: 2026-08-05

## Stav checkpointu

**R16-C3B2 je dokončena v lokálním repozitáři.** Implementační commit je
`92bf4677d7ac02cffc86a66ab240884574258219` na větvi
`agent/phase16c3-staging-preflight`.

Produkční Coolify resource `Modvolt`, `main`, produkční DB/S3, DNS, secrets,
GitHub environments a GHCR zůstaly beze změny. Nebyl spuštěn Docker, deploy,
image publication ani migrace `0105`/`0100`.

Větev nebyla publikována. Aktuální relace i po uživatelském potvrzení `gh`
vrátila `gh auth status` s HTTP 401 a neplatným tokenem. Bundled Git postrádá
HTTPS remote helper; dostupný MinGit jej našel až po explicitním exec path, ale
neměl credential. SSH kontrola skončila `Permission denied (publickey)`.

## Dokončená architektura důkazu

Řetězec je nyní fail-closed a secret-free:

1. offline validator hashuje přesné raw bytes `staging-images.json`, ověří GNU
   sidecar, odděleně schválený checksum, přesný caller workflow/run a všech pět
   private `linux/amd64` GHCR package vazeb včetně provenance/SBOM flagů;
2. provisioning validator vyžaduje observed Coolify resource, přesně dvě veřejné
   služby, privátní DB/API/Mailpit, samostatnou síť, čtyři nové volumes, staging S3
   namespace, nulový průnik s evidovanými produkčními targety a aktuální limity
   2,75 CPU / 2816 MiB;
3. binding generator vytvoří tři rozdílné kanonické input artefakty pro `inspect`,
   `apply-0105` a `steady-0105`, kanonický provisioning artefakt a secret-free env
   přenos; existující evidence nepřepisuje;
4. runtime preflight znovu dekóduje manifest, ověří raw checksum, přesné image
   reference/package metadata a přepočítá checksum aktuálních runtime vstupů;
5. schema transition log obsahuje source SHA, exact 0105/105 stav, explicitní
   absenci 0100, nulový externí stav, backup bind a transition input hash;
6. staging smoke ukládá source/run ID, image/provisioning/steady checksumy,
   exact 0105 stav a SHA-256 sidecar bootstrap artefaktu;
7. release evidence schema v4 znovu hashuje a obsahově porovnává všech osm raw
   artefaktů. Samotné deklarované hashe už PASS nevytvoří.

## Uložené výstupy

- `scripts/verify-staging-image-manifest.mjs`;
- `scripts/check-staging-provisioning.mjs`;
- `scripts/check-staging-deployment-binding.mjs`;
- `docs/audit/16-c3-staging-provisioning.template.json`;
- schema-v4 `docs/audit/13-staging-evidence.template.json`;
- aktualizovaný runtime, smoke workflow, runbook a kontraktní testy.

## Ověření

- offline manifest/provisioning/deployment/evidence testy: 12/12 PASS;
- kompletní DB-free external schema sada: 13/13 PASS;
- staging guard/evidence/runtime/proxy/alert statická sada: 47/47 PASS;
- staging runtime kontrakt: PASS;
- POSIX syntax boundary preflightu: PASS;
- library TypeScript build: PASS;
- API TypeScript: PASS;
- staging E2E TypeScript: PASS;
- cílený ESLint: PASS;
- API esbuild včetně schema gate entrypointu: PASS mimo sandbox; sandbox selhal
  pouze kvůli zákazu čtení nadřazených cest;
- Compose a workflow YAML unique-key parse: PASS;
- JSON templates parse: PASS;
- provisioning template záměrně fail-closed: PASS;
- `git diff --check`: PASS.

Docker workflow-execution matrix nebyla spuštěna. Hostův Docker daemon byl již v
R16-C3B1 nefunkční a uživatel výslovně požadoval chránit stabilitu počítače.

## Nejasnosti a zbývající práce

1. `gh`/Git autentizace v Codex relaci není funkční; commit ani předchozí lokální
   R16-C3 commity zatím nejsou doloženy na remote a draft PR neexistuje.
2. Odděleně schválený image manifest checksum stále potřebuje důvěryhodný kanál
   (Actions UI/approval evidence nebo později podepsanou artifact attestation).
   Checksum uložený ve stejném artifactu s JSONem není sám autentizace.
3. Provisioning dokazuje privátní Mailpit bez relay/forwardingu. Nedokazuje
   firewallový zákaz veškerého odchozího TCP; pokud je požadován tvrdý no-egress,
   musí vzniknout samostatný platformní/firewall důkaz.
4. Skutečný observed Coolify staging resource, dvě DNS/TLS domény, izolovaná síť,
   volumes a Hetzner S3 bucket zatím neexistují. Template proto správně neprojde.
5. `quality-gate.yml` a `staging-smoke.yml` stále používají některé GitHub Actions
   přes mutable `@v4`; před prvním důvěryhodným exact-SHA CI během je nutné je
   připnout na ověřené commit SHA.
6. Immutable predecessor publication cesta pro
   `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3` ještě není připravena. Produkční
   kopie může po restore vyžadovat oddělený baseline postup do exact 0104.

## Doporučení pro další spuštění

- další fáze: R16-C3C – GitHub candidate publication, pinned exact-SHA CI a
  predecessor/private-registry preflight;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze propojí veřejný candidate SHA, draft PR,
  mutable GitHub Actions, privátní caller repository, dvoustupňovou GHCR
  publikaci a přesně omezenou predecessor cestu bez možnosti zaměnit SHA;
- očekávané činnosti: opravit autentizaci viditelnou této relaci, pushnout pouze
  kandidátní větev, otevřít draft PR proti `main`, připnout Actions, získat zelený
  exact-SHA Quality gate, auditovat private registry wrapper a připravit nebo po
  samostatném souhlasu provést private no-deploy image publication;
- soubory, které budou pravděpodobně změněny: `.github/workflows/quality-gate.yml`,
  `.github/workflows/staging-smoke.yml`, staging runtime kontrakty/testy, auditní
  dokumentace a případně wrapper workflow v privátním registry repozitáři;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migraci ani
  Coolify deploy obsahovat nemá. Může obsahovat externí GitHub branch/PR/CI změny
  a po zvláštním potvrzení vytvoření privátních immutable GHCR package versions.

## Stop

Checkpoint R16-C3B2 je vytvořen. Další podfáze se v tomto běhu nezahajuje.
