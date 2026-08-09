# Checkpoint R16-C3C3C-B3 – exact-head private wrapper merge

Datum: 2026-08-09

## Výsledek

**Schválený private PR #3 byl označen ready a bezpečně sloučen do private
`main`. Publisher nebyl spuštěn a GHCR zůstal beze změny.**

- private repo: `modvolt/site-logbook-registry`;
- PR: [#3](https://github.com/modvolt/site-logbook-registry/pull/3);
- schválený head: `10246b4656f6e6b5cf86b537948a36aaead82a54`;
- původní base: `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`;
- merge commit a nový private `main`:
  `064adcfd43920d624670acad1a442375f37deee5`;
- merge metoda: standardní merge commit, exact match-head, bez admin override;
- zdrojová větev nebyla smazána.

## Důkaz identity merge

Merge commit má přesně dva očekávané rodiče:

1. `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc` – původní private `main`;
2. `10246b4656f6e6b5cf86b537948a36aaead82a54` – schválený PR head.

Wrapper `.github/workflows/publish-staging-predecessor.yml` na novém private
`main` má:

- Git blob `6e0ff648028b0e7dfbe41e83ed456471969b93a7`;
- velikost 1498 bytes;
- SHA-256
  `d16ea4e40ed8bfab9b102e19647d1a95b0f28554ee503681f6fa424232ed0a76`;
- přesnou bajtovou shodu s veřejnou auditovanou template;
- caller group `site-logbook-registry-publication`;
- `cancel-in-progress: false`.

## Provedené kontroly

- GitHub identita: `modvolt`, potřebné scope včetně `read:packages`;
- public PR #15: open, draft, unmerged, exact head
  `532b45799a076e4f56185366ae3e9e055ccd6723`;
- public Quality run `31335963994`: `completed/success`, event `pull_request`,
  exact head;
- private PR #3 před zápisem: open, draft, mergeable, clean, exact head/base;
- PR scope: 1 commit, 1 file, 1 insertion, 1 deletion;
- vzdálený PR wrapper proti veřejné template: exact blob/bytes/SHA-256;
- PR po zápisu: merged, non-draft, merge commit exact;
- private `main`: exact merge commit;
- workflow ID `330628153`: `active`;
- publisher run ledger: stále pouze historický failed run `31335035618`;
- GHCR container package count: `0`;
- GHCR target `site-logbook-staging-api` count: `0`;
- zdrojová branch: zachována na exact head.

## Bezpečnostní hranice

- nebyl proveden workflow dispatch ani rerun;
- nebyl proveden GHCR zápis;
- nebyl proveden deploy, Coolify, DB, S3, DNS ani secrets zásah;
- nebyla spuštěna žádná migrace;
- `0100` zůstává nezařazena a `0105` nebyla spuštěna;
- produkční systém nebyl dotčen.

## Nejasnosti a zbývající kroky

1. Opravené oddělení concurrency je aktivní na private `main`, ale runtime
   příčina původního fail-closed běhu bude definitivně potvrzena až novým,
   samostatně schváleným dispatch.
2. GHCR je stále prázdné. Případný další dispatch může vytvořit první immutable
   predecessor image a je nevratným externím zápisem.
3. Před novým dispatch je nutné znovu ověřit public exact-head CI, private main
   blob, nulový GHCR target a absenci souběžného publisher běhu.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-C – samostatně schválený jeden fixed predecessor
  publisher dispatch z ověřeného private `main`, s okamžitým sledováním a
  post-run GHCR/provenance/SBOM evidencí;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze může provést první nevratný privátní GHCR
  zápis a musí přesně rozlišit fail-closed, verified-noop a jedinou povolenou
  publikaci bez deploye;
- očekávané činnosti: read-only preflight public PR/CI, private main, workflow a
  GHCR; po novém výslovném souhlasu právě jeden dispatch; sledování jediného runu;
  ověření image digestu, amd64 manifestu, provenance, SBOM, artifactu a nulového
  deploy/migration dopadu;
- soubory, které budou pravděpodobně změněny: žádný produkční kód; pouze lokální
  veřejný auditní registr a nový checkpoint, pokud nebude nalezen nový blokátor;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: migrace ani
  deploy ne. Ano, může obsahovat jeden nevratný privátní GHCR package write a
  vyžaduje nový samostatný výslovný souhlas.

## Stop

Checkpoint R16-C3C3C-B3 je vytvořen. Další dispatch ani jiná fáze nebyly
zahájeny.
