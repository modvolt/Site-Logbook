# FÁZE 13.8C – read-only external S3 a Coolify capability preflight

- **Datum:** 2026-08-03.
- **Rozsah:** živá inventura Coolify, produkčního S3 profilu, odděleného Coolify S3
  profilu, hostitele a veřejných hranic; pouze čtení.
- **Výchozí lokální commit:** `179a8dd2e8c87ef0c7b66e357759c550b9933888`.
- **Publikovaný staging commit:** `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Verdikt:** **CAPABILITY PREFLIGHT COMPLETE / LIVE PROVISIONING BLOCKED**.
- **Produkce:** žádný save, rebuild, deploy, restart, stop, upgrade ani změna secretu.
- **S3:** žádný bucket API call, zápis, vytvoření bucketu/credential/policy ani změna
  versioningu, Object Locku nebo retence.
- **Migrace:** žádná DB ani migrace nebyla spuštěna; 0100 zůstává vyloučená.

Hodnoty secretů nejsou v tomto dokumentu. Bucket, access key, secret a interní Coolify
handly jsou reprezentovány pouze délkou a prvním 12znakovým prefixem SHA-256. Tyto
otisky slouží jen k porovnání identity, ne k autentizaci.

## Centrální registr zjištění

| ID        | Stav             | Zjištění                                                                                                                                                                                                                                                                                                                                                       | Dopad / rozhodnutí                                                                                                                                                                                                                                                            |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13.8C-01 | PASS             | Přihlášený resource `production → Modvolt (localhost)` je správná produkční Site Logbook aplikace. Coolify ji eviduje jako Docker Compose resource nad veřejným repozitářem `modvolt/Site-Logbook`, větví `main`, selektorem `HEAD` a spuštěným commitem `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.                                                           | Produkční identita je zmapována bez změny. Interní fingerprinty: project `sha256:c439b5c4c590`, environment `sha256:d8ae235d0ef3`, application `sha256:8cf4308eba34`, server `sha256:96f702d7c8c0`.                                                                           |
| F13.8C-02 | LIMITED          | Coolify má jediný server `localhost`, jediný zjištěný environment `production` a čtyři běžící aplikace. Samostatný staging environment/resource zatím neexistuje. Coolify umí vytvořit nový resource a pro Compose standardně vytváří per-resource síť, ale staging by sdílel host, proxy a failure domain s produkcí.                                         | Izolace resource/network je technicky možná; hostová a provozní izolace není. Nový staging se nesmí vytvořit klonem produkce.                                                                                                                                                 |
| F13.8C-03 | PASS / UNAPPLIED | Produkční **požadovaná** aplikační konfigurace obsahuje externí Hetzner Object Storage endpoint, region `fsn1` a path-style `false`. Bucket má fingerprint `sha256:a0d3e4a0659c` (délka 11), access key `sha256:fc0db17050a0` (délka 20) a secret `sha256:bda531de99b0` (délka 40).                                                                            | Požadovaný profil je externí a není shodný s globálním Coolify S3 profilem. Coolify ale hlásí jednu neaplikovanou konfigurační změnu, proto bez samostatně schváleného diffu nelze tvrdit, že stejný profil používá právě běžící container.                                   |
| F13.8C-04 | PASS / LIMITED   | Preview environment variables obsahují samostatnou výchozí sadu s `http://minio:9000`, regionem `us-east-1`, path-style `true` a prázdným bucketem. Preview deployments jsou vypnuté.                                                                                                                                                                          | Nejde o aktivní produkční S3 profil. Při budoucím stagingu se preview scope nesmí omylem použít a MinIO výchozí hodnoty musí být nahrazeny staging-only hodnotami.                                                                                                            |
| F13.8C-05 | PASS             | Globální Coolify S3 storage `Modvolt` je `Usable`, používá stejný provider endpoint, ale jiný region label, bucket i credentials. Bucket fingerprint je `sha256:d0ce3aa996ed`, key `sha256:0568d82785c1`, secret `sha256:c95489af319f`; žádný fingerprint se neshoduje s aplikačním profilem. Coolify uvádí, že tento storage nepoužívá žádný backup schedule. | Profil je od aplikace oddělený, ale aktuálně není důkazem aktivní zálohy. Interní storage handle má fingerprint `sha256:dd5e73abd659`.                                                                                                                                        |
| F13.8C-06 | BLOCKER          | Hetzner podporuje versioning a Object Lock, který musí být zapnut při vytvoření bucketu. Nemá však výchozí server-side encryption; oficiálně podporuje pouze SSE-C. Stávající release preflight vyžaduje pro přísný gate detekovatelnou default encryption a S3 Public Access Block API.                                                                       | Hetzner není bez dalšího rozhodnutí kompatibilní s plným existujícím strict gate. Je nutné zvolit provider s podporovanou default encryption/public-access kontrolou, nebo navrhnout a zvlášť schválit SSE-C/provider-equivalent implementaci. Gate se nesmí potichu oslabit. |
| F13.8C-07 | BLOCKER          | Hetzner access key má ve výchozím stavu přístup ke všem bucketům stejného Hetzner projektu. Nový key ve stejném projektu by proto sám o sobě nebyl staging-only.                                                                                                                                                                                               | Staging vyžaduje samostatný Hetzner projekt bez produkčních bucketů, nebo ověřenou bucket policy dokazující, že credential nemůže číst ani měnit produkci. Pouhé nové key ID nestačí.                                                                                         |
| F13.8C-08 | HIGH             | Všech šest kontrolovaných produkčních S3 proměnných je označeno jako build-time i runtime a `Use Docker Build Secrets` je vypnuto. Pro aplikaci jsou tyto hodnoty potřeba až za běhu.                                                                                                                                                                          | Nový staging musí mít credentials runtime-only. Produkční náprava vyžaduje samostatné schválení, kontrolu neaplikovaného diffu a rebuild; v této fázi se nic neměnilo.                                                                                                        |
| F13.8C-09 | HIGH             | Produkční root Compose stále definuje `minio`, `createbuckets`, volume `miniodata` a host porty `9000/9001`. Při externích S3 hodnotách jsou provider credentials současně použity jako lokální MinIO root credentials, i když API míří jinam. Veřejný test portů `9000/9001` z tohoto klienta skončil timeoutem; port `8000` Coolify odpověděl.               | Firewall zřejmě blokuje přímý externí MinIO přístup, ale zbytečný container, volume, published port a credential reuse zůstávají. Produkční Compose se v auditní fázi nemění; staging Compose MinIO neobsahuje.                                                               |
| F13.8C-10 | HIGH             | Coolify management plane je dostupný přes veřejnou IPv4 na nešifrovaném HTTP portu `8000`. Instance běží na `v4.1.1`, UI nabízí novější verzi; oficiální upstream eviduje `v4.1.2`. Coolify současně hlásí nedostupnou real-time službu.                                                                                                                       | Před rizikovým provisioningem zavést vlastní HTTPS instance domain, ověřit backup/restore Coolify a následně omezit přímý veřejný port `8000`. Upgrade patří do samostatného změnového okna s backupem.                                                                       |
| F13.8C-11 | BLOCKER          | Produkční resource hlásí `1 unapplied configuration change` a vyžaduje rebuild. `View changes` nebylo otevřeno, protože může zpřístupnit další citlivé hodnoty. Veřejné `/api/healthz` vrací `storageStatus: ok`, `migrationParity: true`, ale `version: dev`.                                                                                                 | Běžící storage je funkční, ale provider identity ani přesné build SHA nejsou z runtime důkazu prokázané. Před jakýmkoli produkčním rebuildem je nutný samostatně schválený redigovaný diff a rollback plán.                                                                   |
| F13.8C-12 | BLOCKER          | Server metrics jsou vypnuté. Produkční resource nemá CPU ani memory limit (`0`/unlimited). Na hostu jsou čtyři aplikace; dvě mají evidované restarty a `Modvolt` má health stav `unknown`.                                                                                                                                                                     | Bez kapacitních metrik a explicitních limitů nelze bezpečně spustit staging build ani pětislužbový runtime na stejném hostu. Nejprve doložit kapacitu a stanovit staging CPU/RAM limity.                                                                                      |
| F13.8C-13 | BLOCKER          | Server nemá wildcard domain. `modvoltapp.cz` směřuje na stejný host a DNS je u WEDOS, ale staging kontrakt zakazuje `modvoltapp.cz` i jeho subdomény. Samostatný user-owned staging origin nebyl doložen.                                                                                                                                                      | Preferován je samostatný uživatelem ovládaný domain/zone s HTTPS. `sslip.io` je technicky možná nižší-assurance varianta, ale vyžaduje výslovný owner waiver kvůli cizí DNS zóně.                                                                                             |
| F13.8C-14 | PASS             | Publikovaný staging SHA `7f4bd719…` má zelený exact-SHA Quality gate. Samostatný `docker-compose.staging.yml` nepoužívá MinIO, nepublikuje host porty a spoléhá na Coolify per-resource network.                                                                                                                                                               | Budoucí resource musí používat přesnou větev a SHA, `docker-compose.staging.yml`, vypnutý Auto Deploy a zapnuté zahrnutí source commitu do buildu.                                                                                                                            |

## Zmapovaná živá architektura

```text
Coolify Root Team
└─ My first project
   └─ production
      └─ Modvolt (Docker Compose, localhost)
         ├─ postgres  ─ persistent pgdata
         ├─ minio    ─ persistent miniodata, externě blokované 9000/9001
         ├─ createbuckets
         ├─ api      ─ DB + požadovaný externí S3 profil
         └─ web      ─ jediná služba s https://modvoltapp.cz

Coolify global S3 storage "Modvolt"
└─ jiný bucket + jiné credentials; usable; bez backup schedule

Budoucí staging (zatím neexistuje)
└─ nový project/environment/resource na stejném hostu
   ├─ staging-preflight
   ├─ postgres
   ├─ mailpit
   ├─ api ─ nový externí S3 profil
   └─ web ─ jediný HTTPS origin
```

## Provider a platform capability

Hetzner Object Storage umí versioning a Object Lock/retention; Object Lock musí být
zvolen při vytvoření bucketu a nelze jej doplnit později. Oficiální dokumentace zároveň
uvádí, že objekty nejsou standardně šifrovány at rest a dostupné je SSE-C. Access key
je bez bucket policy platný pro všechny buckety stejného projektu:

- [Hetzner Versioning](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-versioning/)
- [Hetzner Object Lock retention](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-object-lock-retention/)
- [Hetzner encryption FAQ](https://docs.hetzner.com/storage/object-storage/faq/general/)
- [Hetzner S3 credentials a least privilege](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/)
- [Hetzner supported actions](https://docs.hetzner.com/storage/object-storage/supported-actions/)

Coolify podporuje samostatnou per-resource Compose síť, privátní služby bez domain/host
portu, požadované env proměnné a automatické HTTPS po přiřazení FQDN. Source commit se
do buildu nezahrnuje automaticky a musí být explicitně zapnut:

- [Coolify Docker Compose](https://coolify.io/docs/applications/build-packs/docker-compose)
- [Coolify environment variables](https://coolify.io/docs/knowledge-base/environment-variables)
- [Coolify domains a HTTPS](https://coolify.io/docs/knowledge-base/domains)
- [Coolify DNS configuration](https://coolify.io/docs/knowledge-base/dns-configuration)
- [Coolify upgrade s povinným backupem](https://coolify.io/docs/get-started/upgrade/)
- [Coolify releases](https://github.com/coollabsio/coolify/releases)

## Co nebylo provedeno

- nebyl otevřen `View changes`, logy, Coolify terminal ani private key;
- nebyl spuštěn `Fetch Server Details`, `Check for Updates`, `Validate Connection`,
  upgrade, proxy restart ani resource refresh;
- nebyl kontaktován produkční bucket přes S3 API a nebyl proveden storage write probe;
- nebyl vytvořen project, environment, resource, volume, domain, DNS záznam, bucket,
  credential, policy ani secret;
- nebyl spuštěn deploy, rebuild, workflow, DB, API startup ani migrace;
- plaintext secret ani úplný bucket/access-key identifikátor nebyl uložen do Git.

## Nevyřešené otázky

1. Jaký provider splní strict encryption/public-access gate: jiný S3 provider, nebo
   zvlášť navržená Hetzner SSE-C/provider-equivalent cesta?
2. Jaký nový Hetzner/cloud projekt a bucket policy prokážou nulový přístup staging key
   k produkčnímu bucketu?
3. Jaký user-owned origin mimo `modvoltapp.cz` bude použit; případně kdo schválí
   dočasný `sslip.io` waiver?
4. Jaká je skutečná kapacita serveru a jaké CPU/RAM limity dostane staging resource?
5. Co přesně obsahuje jedna neaplikovaná produkční změna a jaký je rollback před
   případným rebuildem?
6. Jaké hodnoty `--max-age-days` schválí owner zvlášť pro `ppe_signature` a
   `ppe_confirmation`?
7. Vyžaduje první staging deploy digest pinning Node, Nginx a PostgreSQL obrazů?

F13.8C neautorizuje odpověď na tyto otázky změnou živého systému. Návrh přesného
pořadí budoucích změn je v [provisioning manifestu](13-8c-provisioning-change-manifest.md).
