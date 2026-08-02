# Checkpoint FÁZE 13.8C – external capability preflight

- **Datum:** 2026-08-03.
- **Stav podfáze:** **COMPLETE**.
- **Verdikt:** **READ-ONLY PREFLIGHT COMPLETE / LIVE PROVISIONING BLOCKED**.
- **Výchozí lokální SHA:** `179a8dd2e8c87ef0c7b66e357759c550b9933888`.
- **Publikované staging SHA:** `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Produkce:** bez Save, View changes, rebuild, deploye, restartu, upgradu a změny
  env/secretu.
- **S3/Coolify/DNS:** nebyl vytvořen ani změněn žádný resource.
- **Migrace 0100:** nepřítomná, nedotčená a nadále vyloučená.

## Uložené výstupy

- [centrální capability evidence](13-8c-external-capability-preflight.md)
- [autorizovatelný provisioning change manifest](13-8c-provisioning-change-manifest.md)
- [předchozí exact-SHA checkpoint](13-8b-phase-checkpoint.md)

## Shrnutí

Živá read-only inventura potvrdila správný produkční resource, jediný Coolify host a
technickou možnost vytvořit nový per-resource Compose staging. Produkční požadovaný
S3 profil míří na externí Hetzner Object Storage; preview MinIO hodnoty jsou v jiném
scope a preview deployments jsou vypnuté. Globální Coolify S3 profil má jiné bucketové
i credential fingerprinty, je `Usable`, ale nepoužívá jej žádný backup schedule.

Provisioning přesto není bezpečně autorizovatelný. Hetzner nemá default at-rest
encryption, pouze SSE-C, a credentials jsou bez policy platné pro všechny buckety
stejného projektu. Existing strict release gate proto vyžaduje provider/encryption
rozhodnutí. Dále chybí samostatný origin, server capacity evidence, resource limits,
retention a oba typované PPE age limity.

Na produkci byla nalezena jedna neaplikovaná konfigurační změna. S3 hodnoty jsou
zbytečně build-time i runtime a build secret režim je vypnutý. Root Compose stále
spouští MinIO/createbuckets a používá stejné hodnoty jako externí S3; veřejné porty
`9000/9001` z kontrolního klienta neodpověděly. Produkční runtime health je zelený,
ale vrací `version: dev`, takže neprokazuje exact SHA ani aktivní storage provider.

Coolify management plane běží přes veřejný HTTP port `8000`, real-time služba není
dostupná, metrics jsou vypnuté a produkční resource nemá CPU/RAM limity. Upgrade,
HTTPS instance domain, zavření portu nebo produkční rebuild nebyly v této auditní fázi
provedeny.

## Provedené kontroly

- live Coolify project/environment/resource/server/storage inventura: PASS;
- redigované porovnání produkčního a Coolify S3 profilu: PASS, identity oddělené;
- rozlišení production/preview env scope: PASS;
- kontrola build/runtime flags a build secret režimu: PASS, nález `F13.8C-08`;
- veřejný health endpoint: PASS pro DB/storage/migration parity, build identity FAIL;
- externí port preflight: Coolify `8000` reachable, MinIO `9000/9001` timeout;
- DNS A/NS inventura: PASS, samostatný staging origin BLOCKED;
- oficiální Hetzner/Coolify capability review: PASS, provider compatibility BLOCKED;
- žádný plaintext secret uložen do repozitáře: ověřit finálním pattern scanem;
- `git diff --check` a dokumentační kontroly: provést po uložení checkpointu.

## Jednoznačný checkpoint

FÁZE 13.8C zde končí. Read-only capability preflight a mutation manifest jsou hotové.
Tento checkpoint neautorizuje `View changes`, produkční rebuild, Coolify/S3/DNS
provisioning, vložení staging secretů, start API, workflow dispatch, migrace, merge ani
produkci. Automaticky se nepokračuje do F13.8D.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8D – provider/origin/capacity a produkční drift decision
  gate; po samostatném úzkém souhlasu pouze redigovaně přečíst `View changes`, zvolit
  storage encryption model, nový origin, retention, PPE age limity a resource limits;
  stále nevytvářet resource ani nespouštět deploy;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** je nutné rozhodnout security hranici mezi produkcí a
  stagingem, vyřešit Hetzner encryption/IAM incompatibilitu a oddělit neškodné čtení
  neaplikovaného diffu od produkčního rebuild triggeru;
- **očekávané činnosti:** získání explicitního souhlasu pro redigovaný production
  config diff, volba provideru nebo návrh SSE-C varianty, výběr user-owned originu,
  kapacitní preflight hostu, návrh CPU/RAM limitů, schválení retention a hodnot
  `--max-age-days` zvlášť pro `ppe_signature` a `ppe_confirmation`, finalizace přesného
  mutation checklistu pro pozdější F13.8E;
- **soubory, které budou pravděpodobně změněny:** pouze `docs/audit/13-8d-*`; při volbě
  Hetzner SSE-C se produkční kód nemá měnit bez nové samostatné implementační fáze a
  security review;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** F13.8D nemá
  obsahovat migrace, S3/Coolify/DNS vytvoření, env Save, rebuild ani deploy a 0100
  zůstává vyloučená. Rizikem je pouze přístup k citlivému production config diffu;
  skutečné resource mutations patří nejdříve do samostatně schválené F13.8E a první
  API start s automatickými migracemi až do ještě pozdějšího gate.
