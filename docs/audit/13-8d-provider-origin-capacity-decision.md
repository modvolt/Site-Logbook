# FÁZE 13.8D – provider, origin, kapacita a production drift decision gate

- **Datum:** 2026-08-03.
- **Rozsah:** read-only server capacity, redigované produkční `View changes` a
  rozhodovací packet pro storage, origin, retention, PPE limity, image policy a
  staging resource limits.
- **Výchozí lokální commit:** `bd113437102a706ec37e4282b5f64b08c6dd433d`.
- **Publikovaný staging commit:** `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Verdikt:** **DECISION GATE COMPLETE / PROVISIONING A PRODUCTION REBUILD BLOCKED**.
- **Produkce:** bez Save, změny, stopu, restartu, rebuildu, deploye a upgradu.
- **S3/Coolify/DNS:** nebyl vytvořen ani změněn žádný resource.
- **Migrace:** nebyla spuštěna DB ani migrace; `0100` zůstává vyloučená.

Tento dokument neobsahuje plaintext secret, bucket, access key ani úplný diff
produkční konfigurace. Coolify diff byl zpracován redigovaně a do evidence se ukládá
jen typ pole, směr a počet řádků zobrazený management plane.

## Centrální registr zjištění a rozhodnutí

| ID        | Stav                   | Zjištění / rozhodnutí                                                                                                                                                                        | Dopad                                                                                                                                                                       |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13.8D-01 | PASS / LIMITED         | Host má 4 CPU, 8 122 368 000 B RAM, 4 759 302 144 B dostupné RAM, žádný swap a 18 068 520 960 B volného prostoru na root/Docker filesystému.                                                 | Omezený staging runtime se pravděpodobně vejde; první lokální multi-image build na sdíleném produkčním hostu není bezpečně doložený.                                        |
| F13.8D-02 | HIGH                   | Docker drží 13,82 GB images, 1,622 GB volumes a přibližně 2,37 GiB idle container memory. Produkce nemá CPU/RAM limity.                                                                      | Build spike může vytlačit produkci z RAM nebo zaplnit disk. Před prvním deployem zavést limity a preferovat předpřipravené immutable images.                                |
| F13.8D-03 | BLOCKER                | Coolify eviduje právě jednu neaplikovanou změnu, pole `Docker Compose`, s příznakem `REBUILD REQUIRED`. Zobrazené `FROM` má 240 řádků a `TO` 238 řádků; UI neposkytlo bezpečný řádkový diff. | Nelze určit, které dva řádky byly odebrány ani zda je uložená varianta zamýšlená. Produkční rebuild zůstává zakázaný do získání kanonického Compose diffu a rollback plánu. |
| F13.8D-04 | RECOMMENDED / OWNER    | Pro strict gate je doporučen nový AWS S3 bucket v `eu-central-1`, s explicitním SSE-S3, Block Public Access, versioningem, Object Lockem a staging-only IAM identitou.                       | Hetzner varianta z F13.8C zůstává bez SSE-C adaptace nekompatibilní. AWS účet a případný náklad musí schválit owner před provisioningem.                                    |
| F13.8D-05 | PENDING OWNER          | Preferovaný origin je user-owned HTTPS domain mimo `modvoltapp.cz`. Dočasný `sslip.io` host nad `91.99.67.4` je jen fallback.                                                                | Bez doložené vlastní zóny nebo výslovného časově omezeného `sslip.io` waiveru se DNS/resource nevytváří.                                                                    |
| F13.8D-06 | READY                  | Navržená Object Lock politika je `GOVERNANCE`, 30 dní.                                                                                                                                       | Shoduje se s existujícím recovery runbook minimem. Mazání uzamčených verzí nemusí být okamžitě možné.                                                                       |
| F13.8D-07 | READY                  | Staging PPE politika je `ppe_signature:30` a `ppe_confirmation:30`; parametry zůstávají samostatně typované.                                                                                 | Hodnoty odpovídají defaultní expiraci nově vydávaných tokenů a `docker-compose.staging.yml`. Preflight smí běžet až nad izolovanou obnovenou DB.                            |
| F13.8D-08 | REQUIRED BEFORE DEPLOY | Navržené runtime limity jsou celkem přibližně 2,25 CPU a 2,25 GiB: API 1 CPU/1 GiB, PostgreSQL 0,5 CPU/768 MiB, Mailpit 0,25 CPU/256 MiB, web 0,25 CPU/128 MiB a preflight 0,25 CPU/128 MiB. | Limity vložit do staging Compose jako source of truth a ověřit Compose config; nejsou autorizací ke startu.                                                                 |
| F13.8D-09 | REQUIRED BEFORE DEPLOY | Node, Nginx, PostgreSQL, Mailpit a Alpine base/runtime images jsou stále tagované bez digestu.                                                                                               | Připnout digesty nebo použít předem publikované SHA images. Změna vytvoří nový staging SHA a zneplatní dosavadní exact-SHA Quality gate.                                    |
| F13.8D-10 | PASS                   | Read-only server příkazy ani Coolify `View changes` neprovedly mutation. Modal nebyl potvrzen žádným pokračovacím tlačítkem a nebyl spuštěn rebuild.                                         | Produkční runtime i konfigurace zůstaly nezměněné.                                                                                                                          |

## Server capacity evidence

Read-only příkazy proběhly v Coolify server terminalu. Nebyly čteny env, soubory,
logy ani secrets a nebyl proveden cleanup/restart.

| Metrika        | Důkaz                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| CPU            | `nproc = 4`; load average `1.07 / 0.57 / 0.48`; uptime 37 dní                                |
| RAM            | total 8 122 368 000 B; used 3 363 065 856 B; available 4 759 302 144 B                       |
| swap           | 0 B                                                                                          |
| disk           | `/dev/sda1`; 39 964 635 136 B total; 20 206 931 968 B used; 18 068 520 960 B available; 53 % |
| Docker disk    | images 13,82 GB, jen 570,9 MB reclaimable; volumes 1,622 GB; build cache 0 B                 |
| Docker runtime | 16 aktivních containerů; přibližně 2,37 GiB agregované idle memory                           |
| engine         | Docker Server 29.5.2                                                                         |

Závěr není „host má dost místa pro libovolný build“. Je pouze tento:

1. staging runtime s výše uvedenými service limity může být po dalších gatech
   přijatelný na sdíleném hostu;
2. bez swapu a s 18,1 GB volného disku není bezpečné jako první krok paralelně buildit
   API, web, Mailpit a preflight vedle neomezené produkce;
3. preferovaný build model je CI/předpřipravený registry image připnutý na digest;
   nouzová alternativa je explicitně serializovaný build se zvláštním change window,
   disk/RAM stop podmínkami a rollbackem;
4. po startu se musí znovu změřit RAM, load, disk a health; při memory pressure nebo
   neočekávaném restartu se staging zastaví, ne navyšuje na úkor produkce.

Coolify dokumentuje, že defaultně nemusí mít container žádný resource limit a buildy
jsou resource-intensive. U Compose je konfiguračním source of truth samotný Compose;
podporované override klíče zahrnují `cpus`, `mem_limit` a `mem_reservation`:

- [Coolify Applications](https://coolify.io/docs/applications/)
- [Coolify Docker Compose](https://coolify.io/docs/applications/build-packs/docker-compose)
- [Coolify installation capacity guidance](https://coolify.io/docs/get-started/installation)
- [Coolify Compose overrides](https://coolify.io/docs/knowledge-base/custom-compose-overrides)

## Redigovaný production drift

Uživatel bezprostředně před akcí schválil pouze redigované čtení `View changes` a
výslovně zakázal uložení, změnu, stop i build.

Coolify ukázal:

```text
1 configuration change
REBUILD REQUIRED
BUILD
FIELD: Docker Compose
FROM: zkrácený náhled, 240 lines
TO:   zkrácený náhled, 238 lines
```

Viditelný začátek obou náhledů obsahoval stejný service klíč `postgres`, image
`postgres:16-alpine` a začátek stejné restart policy. Rozdíl, který UI zobrazilo, byl
jen počet skrytých řádků. Z toho **nelze** odvodit, že změna je bezpečná, že se týká jen
dvou řádků, ani že odpovídá některému checkoutu. Lokální root Compose ani Compose v
nasazeném commitu nemají přímo stejný fyzický počet řádků; UI zřejmě zobrazuje vlastní
normalizovanou reprezentaci.

Před jakýmkoli budoucím produkčním rebuildem je povinné:

1. získat nebo exportovat celé `FROM` a `TO` bez plaintext secretů;
2. normalizovat Compose a vytvořit strukturální diff service/volume/port/env **názvů**;
3. zvlášť zkontrolovat odstranění MinIO, credential scope, volumes a public ports;
4. doložit aktuální DB/S3 backup a produkční rollback;
5. rebuild autorizovat novým explicitním souhlasem. Tento checkpoint jej neautorizuje.

## Storage decision packet

### Doporučená strict varianta

Použít samostatný AWS účet, nebo minimálně samostatnou staging IAM identitu bez přístupu
k jiné aplikaci:

| Položka                     | Doporučená hodnota                                                               |
| --------------------------- | -------------------------------------------------------------------------------- |
| region                      | `eu-central-1`                                                                   |
| endpoint                    | `https://s3.eu-central-1.amazonaws.com`                                          |
| path style                  | `false`                                                                          |
| bucket                      | nový `site-logbook-staging-*`, jméno nevkládat do Git                            |
| encryption                  | explicitní default SSE-S3; SSE-KMS je možná pozdější vyšší-assurance varianta    |
| public access               | všechny čtyři Block Public Access přepínače `true`                               |
| versioning                  | `Enabled`                                                                        |
| Object Lock                 | zapnout při vytvoření bucketu                                                    |
| default retention           | `GOVERNANCE`, 30 dní                                                             |
| runtime identity            | pouze přesný staging bucket a potřebné object/list akce; žádný produkční přístup |
| provisioning/audit identity | oddělená od runtime key; nevkládat do Coolify                                    |

AWS dokumentuje API pro Block Public Access, explicitní default encryption a povinnost
zapnout Object Lock při vytvoření bucketu. IAM policy musí omezit bucket i object ARN:

- [S3 GetPublicAccessBlock](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetPublicAccessBlock.html)
- [S3 Object Lock configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html)
- [S3 default bucket encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-bucket-encryption.html)
- [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [S3 bucket policy examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html)

Bucket, účet, credential ani policy se v této fázi nevytvořily. Hetzner zůstává možný
jen přes samostatnou SSE-C/provider-equivalent implementační a security-review fázi;
strict gate se kvůli němu nesmí změnit na fail-open.

## Origin decision packet

1. **Preferováno:** nový user-owned domain/zone mimo `modvoltapp.cz`, například
   samostatná staging doména s jedním `A` záznamem na aplikační server.
2. **Dočasný fallback:**
   `site-logbook-staging-<opaque>.91.99.67.4.sslip.io`, pouze s explicitním owner
   waiverem, časovým omezením a veřejně důvěryhodným HTTPS certifikátem.
3. **Zakázáno:** `modvoltapp.cz`, jeho subdomény, produkční cookie/domain scope,
   self-signed certifikát a domain na privátních službách.

Konkrétní user-owned zóna nebyla doložena a `sslip.io` waiver nebyl udělen. Origin je
proto stále blocking vstup pro resource provisioning, nikoli pro následující code-only
hardening.

## PPE, retention a image policy

Pro staging readiness packet se stanoví:

```text
--max-age-days=ppe_signature:30
--max-age-days=ppe_confirmation:30
```

Hodnoty jsou oddělené podle typu, i když jsou stejné. Odpovídají 30denní expiraci
nových PPE signature i confirmation tokenů v `ppe.ts`, `public-access-token.ts` a
`docker-compose.staging.yml`. Preflight zůstává pouze read-only nad izolovanou
obnovenou DB; výsledek `BLOCK` neautorizuje automatický cleanup.

Object Lock minimum je 30 dní v režimu `GOVERNANCE`, shodně s
`12-object-recovery-runbook.md`. Před změnou na delší dobu je nutné znovu posoudit
náklady a nemožnost rychlého cleanupu.

Před prvním staging deployem připnout digesty minimálně pro:

- `node:24-slim` v API a web builder/runtime Dockerfile;
- `nginx:1.27-alpine`;
- `postgres:16-alpine`;
- `axllent/mailpit:v1.30.0`;
- `alpine:3.22.1` v Mailpit a preflight images.

Digest pinning a resource limity změní repozitář. Po jejich implementaci musí vzniknout
nový exact SHA, cílené testy, celý Quality gate a nový publication checkpoint. Dosavadní
zelený gate pro `7f4bd719…` se nesmí přenést na změněný strom.

## Přesné stop podmínky pro další práci

- žádný staging resource/bucket/domain, dokud owner neschválí provider účet a origin;
- žádný build na sdíleném hostu bez image/build strategie a limitů;
- žádný production rebuild, dokud není k dispozici semantický Compose diff a rollback;
- žádný production env Save, S3 credential reuse ani globální Coolify S3 profil;
- žádný API start před storage preflightem, izolovanou DB a migration gate;
- žádná migrace `0100`.

## Co nebylo provedeno

- nebyl kliknut Save, Reload Compose File, Redeploy, Stop ani Upgrade;
- nebyla potvrzena žádná změna z `View changes`;
- nebyl vytvořen AWS/Hetzner resource, účet, bucket, key, policy ani retention;
- nebyl vytvořen Coolify project/environment/resource, DNS záznam ani certifikát;
- nebyl spuštěn build, workflow, deploy, API, DB, S3 write probe ani migrace;
- nebyl proveden produkční cleanup, Docker prune ani zapnutí swapu;
- nebyl změněn produkční ani staging kód.
