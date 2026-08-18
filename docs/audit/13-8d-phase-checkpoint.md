# Checkpoint FÁZE 13.8D – provider/origin/capacity a production drift gate

- **Datum:** 2026-08-03.
- **Stav podfáze:** **COMPLETE**.
- **Verdikt:** **DECISION GATE COMPLETE / HARDENING REQUIRED / PROVISIONING BLOCKED**.
- **Výchozí lokální SHA:** `bd113437102a706ec37e4282b5f64b08c6dd433d`.
- **Publikované staging SHA:** `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Produkce:** `View changes` pouze redigovaně přečteno; bez Save, stopu, rebuildu,
  deploye, restartu a změny env/secretu.
- **Externí systémy:** žádný Coolify/S3/DNS resource nebyl vytvořen ani změněn.
- **Migrace 0100:** nepřítomná, nedotčená a nadále vyloučená.

## Uložené výstupy

- [centrální F13.8D evidence a decision packet](13-8d-provider-origin-capacity-decision.md)
- [předchozí capability preflight](13-8c-external-capability-preflight.md)
- [předchozí provisioning manifest](13-8c-provisioning-change-manifest.md)

## Shrnutí

Read-only server evidence potvrdila 4 CPU, přibližně 8,12 GB RAM, 4,76 GB dostupné
RAM, 18,07 GB volného disku a nulový swap. Omezený staging runtime se na host
pravděpodobně vejde, ale lokální multi-image build vedle neomezené produkce není
bezpečně doložený. Doporučené service limity jsou přibližně 2,25 CPU a 2,25 GiB celkem;
preferovány jsou předpřipravené immutable images místo prvního buildu na shared hostu.

Výslovně schválené redigované `View changes` ukázalo jediný production drift:
`Docker Compose`, `REBUILD REQUIRED`, z 240 na 238 normalizovaných řádků. Coolify
nezobrazil řádkový obsah změny. Proto nebylo možné určit odstraněné řádky a produkční
rebuild zůstává blokovaný do semantického diffu a rollback plánu.

Strict storage doporučení je nový AWS S3 bucket v `eu-central-1` s explicitním SSE-S3,
Block Public Access, versioningem, Object Lockem, 30denní `GOVERNANCE` retencí a
staging-only IAM identitou. AWS účet/náklad nebyl autorizován. Hetzner stále vyžaduje
samostatnou SSE-C adaptaci a security review.

Origin preferuje user-owned HTTPS zone mimo `modvoltapp.cz`; dočasný `sslip.io` fallback
vyžaduje explicitní waiver. PPE limity jsou v packetu stanovené samostatně na
`ppe_signature:30` a `ppe_confirmation:30`. Před prvním deployem jsou povinné digest
piny všech base/runtime images, což vytvoří nové exact SHA a vyžádá nový Quality gate.

## Provedené kontroly

- read-only `nproc`, `free`, `df`, `docker system df`, `docker stats`, `uptime`: PASS;
- kapacitní vyhodnocení runtime versus build headroom: PASS / build BLOCKED;
- unikátní production `View changes` locator před akcí: PASS (`count = 1`);
- redigované načtení jediného driftu bez secret hodnot: PASS;
- kontrola, že diff označuje pouze `Docker Compose` a vyžaduje rebuild: PASS;
- přesný semantic/line diff: BLOCKED, Coolify poskytl jen zkrácené náhledy;
- provider capability decision: AWS doporučeno, owner/provisioning PENDING;
- origin decision: user-owned domain doporučen, konkrétní zóna/waiver PENDING;
- PPE/retention/resource/image policy packet: PASS;
- žádný produkční nebo externí mutation: PASS;
- plaintext secret scan, docs link scan a `git diff --check`: provést před lokálním
  commitem tohoto checkpointu.

## Nevyřešené otázky

1. Má owner dostupný samostatný AWS účet a schválí náklad varianty `eu-central-1`, nebo
   požaduje zvláštní Hetzner SSE-C implementační fázi?
2. Jaká user-owned domain/zone mimo `modvoltapp.cz` bude použita; případně schválí owner
   dočasný, časově omezený `sslip.io` waiver?
3. Jak bezpečně získat plný strukturální `FROM`/`TO` production Compose diff bez
   plaintext secretů před jakýmkoli rebuildem?
4. Bude image build publikován z CI do registry, nebo vznikne zvláštní serializované
   host build change window? Doporučena je CI/registry varianta.

Tyto otázky neblokují další code-only hardening. Blokují však vytvoření externích
resources a první build/deploy.

## Jednoznačný checkpoint

FÁZE 13.8D zde končí. Capacity, provider/origin recommendation, PPE/retention/image
policy a redigovaný production drift byly zmapovány. Tento checkpoint neautorizuje
změnu produkce, AWS/Hetzner/Coolify/DNS provisioning, vložení secretů, workflow dispatch,
build, deploy, start API, DB preflight, migrace, merge ani push. Automaticky se
nepokračuje do F13.8E.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8E – code-only staging capacity a reproducibility hardening;
  doplnit per-service CPU/RAM limity, připnout base/runtime image digesty a připravit
  bezpečnou předpublikovanou image strategii; stále nevytvářet resource a nespouštět
  deploy;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** změna ovlivní build reproducibilitu, supply-chain
  hranici, sdílenou produkční kapacitu a přesný staging release contract; chyba může
  vést k buildu na produkčním hostu nebo k nasazení jiného image/SHA;
- **očekávané činnosti:** ověřit aktuální registry digesty z primárních registrů,
  rozhodnout CI/registry versus serializovaný build, přidat `cpus`, `mem_limit` a
  `mem_reservation` ke každé staging službě, připnout Node/Nginx/PostgreSQL/Mailpit/
  Alpine digesty, přidat kontraktní testy, spustit Compose validaci, cílené testy a celý
  Quality gate a připravit nové exact-SHA publication evidence; push/publikace jen po
  novém výslovném souhlasu;
- **soubory, které budou pravděpodobně změněny:** `docker-compose.staging.yml`,
  `artifacts/api-server/Dockerfile`, `artifacts/stavba/Dockerfile`,
  `deploy/staging/mailpit/Dockerfile`, `deploy/staging/preflight/Dockerfile`, relevantní
  staging contract testy a podle zvolené image cesty `.github/workflows/*.yml` plus
  `docs/audit/13-8e-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** F13.8E nesmí
  obsahovat DB ani migraci `0100`, produkční změnu, S3/Coolify/DNS provisioning, env
  Save, build na shared hostu ani deploy. Rizikové jsou supply-chain digesty, resource
  limity a případná registry publication; publikace/push vyžadují nový úzký souhlas.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
„Pokračuj další fází“.
