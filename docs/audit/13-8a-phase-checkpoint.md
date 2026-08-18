# Checkpoint FÁZE 13.8A – hardened staging runtime definition

- **Datum:** 2026-08-02.
- **Stav podfáze:** **COMPLETE**.
- **Verdikt:** **RUNTIME DEFINITION PASS / LIVE STAGING PROVISIONING BLOCKED**.
- **Výchozí lokální commit:** `ac643c0c5353`.
- **Produkce:** bez přístupu a beze změny.
- **Vzdálené změny:** žádný push, workflow dispatch, Coolify resource ani deploy.
- **Migrace:** PostgreSQL a default API startup nebyly spuštěny; 0100 je nepřítomná
  a vyloučená.

## Uložené výstupy

- [centrální registr a architektura staging runtime](13-8a-staging-runtime-definition.md)
- [samostatná staging Compose definice](../../docker-compose.staging.yml)
- [secret-free staging env kontrakt](../../.env.staging.example)
- [staging preflight](../../deploy/staging/preflight/preflight.sh)
- [izolovaný Mailpit wrapper](../../deploy/staging/mailpit/entrypoint.sh)

## Shrnutí architektury

Staging je definován jako samostatný Compose runtime s pěti službami:
`staging-preflight`, PostgreSQL, Mailpit, API a web. MinIO byl na základě rozhodnutí
vlastníka odstraněn; objektová data míří do nového externího staging S3 bucketu přes
HTTPS a samostatný least-privilege credential. Compose bucket ani jeho policy nemění.

Pouze web na container portu 80 smí dostat Coolify domain. Ostatní služby nemají host
port ani domain a Compose nedefinuje vlastní síť. Preflight skončí před startem
stavových služeb, pokud origin, exact SHA, S3 hranice nebo secrets nejsou jednoznačně
staging-only. Mailpit nemá relay/forwarding, vyžaduje ověřené STARTTLS a API vidí jen
veřejnou CA, nikoli privátní serverový klíč.

## Ověření

Finální Compose config, plný build všech vlastních staging obrazů, exact SHA v API a
web artefaktu, fail-closed preflight, izolace Mailpit klíče a ověřené STARTTLS prošly.
Prošly také lint, 13/13 staging kontraktních testů, staging E2E typecheck, shell/Node
syntax, whitespace a credential-pattern scan. Docker je po instalaci WSL a restartu
hosta funkční.

Skutečný S3 nebyl kontaktován. PostgreSQL, default API příkaz, migrace, Coolify,
staging URL, GitHub staging workflow ani produkce nebyly spuštěny. Všechny testovací
kontejnery, sítě a volumes byly odstraněny; zůstává pouze lokální image/build cache.

## Nejasnosti

- chybí přesné nové staging S3 hodnoty a důkaz versioningu, Object Lock/retention,
  encryption, public-access blocku a storage fingerprintu;
- chybí samostatný origin mimo `modvoltapp.cz`, DNS a Coolify resource;
- chybí publikované exact SHA této definice a nový remote Quality gate;
- service owner ještě neurčil oba typované PPE age limity;
- není rozhodnuto, zda před deployem připnout všechny base obrazy digestem.

## Jednoznačný checkpoint

FÁZE 13.8A zde končí. Lokální runtime definice je připravena a ověřena, ale není
publikována ani nasazena. Automaticky se nepokračuje do push, Coolify provisioning,
S3/DB přístupu, migrací, smoke, merge nebo produkce.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8B – exact-SHA publication gate; zkontrolovat rozdíl proti
  aktuálnímu draft PR headu, publikovat pouze ověřené změny F13.8A a vyžádat zelený
  remote Quality gate na přesném novém SHA, bez Coolify resource nebo deploye;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze mění vzdálený kandidát a musí zachovat přesný
  vztah commit–image–CI, nepublikovat nesouvisející worktree změny a zabránit tomu,
  aby samotný push byl zaměněn za autorizaci k deployi nebo migracím;
- **očekávané činnosti:** ověřit PR/branch stav, zkontrolovat lokální checkpoint a
  scope, pushnout přesný commit na správnou kandidátní větev, počkat na Quality gate,
  ověřit remote SHA a uložit F13.8B evidence. Nevytvářet S3 credential/bucket ani
  Coolify resource a nespouštět staging workflow;
- **soubory, které budou pravděpodobně změněny:** pouze `docs/audit/13-8b-*`, pokud
  remote gate nenajde konkrétní závadu. Runtime soubory F13.8A se nemají měnit bez
  nového doloženého nálezu;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** migrace, DB,
  S3 a Coolify se v F13.8B nemají měnit a 0100 zůstává vyloučená. Rizikem je vzdálený
  push a změna PR headu; skutečný S3/Coolify provisioning a budoucí automatická
  aplikace migrací `0096–0099` a `0101–0102` patří až do další samostatně autorizované
  fáze.
