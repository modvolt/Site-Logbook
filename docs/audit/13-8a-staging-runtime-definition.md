# FÁZE 13.8A – hardened staging runtime definition

- **Datum:** 2026-08-02.
- **Výchozí lokální commit:** `ac643c0c5353`.
- **Rozsah:** samostatná staging Compose definice, secret-free vstupní kontrakt,
  build identity, izolovaný mail sandbox a lokální Docker ověření.
- **Verdikt:** **RUNTIME DEFINITION PASS / LIVE STAGING PROVISIONING BLOCKED**.
- **Produkce:** bez přístupu a beze změny.
- **Coolify/GitHub:** bez vytvoření resource, deploye, workflow dispatch nebo push.
- **DB a migrace:** PostgreSQL ani výchozí API příkaz nebyly spuštěny; žádná migrace
  nebyla aplikována. Migrace 0100 zůstává nepřítomná a vyloučená.

## Centrální registr zjištění

| ID | Stav | Zjištění | Dopad / uzavření |
| --- | --- | --- | --- |
| F13.8A-01 | PASS | `docker-compose.staging.yml` je úplná samostatná definice pěti služeb: `staging-preflight`, `postgres`, `mailpit`, `api`, `web`. MinIO ani bucket-init služba ve stagingu nejsou; podle rozhodnutí vlastníka aplikace používá externí S3. | Staging se nesmí slučovat s root produkčním/lokálním Compose. |
| F13.8A-02 | PASS | Compose nepublikuje žádný host port a nedefinuje vlastní síť. Pouze `web:80` smí dostat Coolify domain; PostgreSQL, API a Mailpit zůstávají privátní. | Návrh odpovídá Coolify per-resource network modelu a omezuje omylem veřejné služby. |
| F13.8A-03 | PASS / BLOCKED LIVE | Všechny deployment vstupy mají prefix `STAGING_`. Preflight vyžaduje HTTPS S3 endpoint, bucket v namespace `site-logbook-staging`, provider-issued least-privilege credential a explicitní path-style režim. | Statická izolace je doložena. Existence, fingerprint, versioning, Object Lock/default retention, encryption a public-access policy skutečného bucketu zatím doloženy nejsou. |
| F13.8A-04 | PASS | Mailpit je připnut na `v1.30.0`, nemá relay/forwarding ani veřejný port, vyžaduje STARTTLS a běží jako UID 10001. Privátní serverový klíč a veřejná CA jsou v oddělených volumes; API vidí pouze CA. | Ověřený STARTTLS přenos z API obrazu a zachycení zprávy v sandboxu prošly. |
| F13.8A-05 | PASS | Stejný povinný plný SHA vstup se propisuje do API `BUILD_SHA`, frontendového `VITE_BUILD_SHA` a tagů vlastních staging obrazů. | Lokální syntetický sentinel byl nalezen v obou finálních obrazech; nejde o deployované SHA. |
| F13.8A-06 | PASS | Preflight odmítá produkční/loopback origin, chybný project namespace, neúplné secrets, HTTP nebo nestaging S3, neplatný JSON keyring a shodný aktivní aplikační/zálohovací klíč. Hodnoty nevypisuje. | Chybná konfigurace skončí před startem PostgreSQL a dalších dlouho běžících služeb. |
| F13.8A-07 | PASS | Po restartu hosta běží WSL `2.7.11.0`, kernel `6.18.33.2-2` a Docker Server `29.6.1`. | Lokální image build a izolované runtime testy jsou znovu proveditelné. |
| F13.8A-08 | LIMITED | API image stále obsahuje startup mechanismus migrací a při budoucím skutečném startu je aplikuje. Tato fáze API spouštěla jen s přepsaným jednorázovým Node/sh entrypointem. | Pořadí `0096 → 0097 → 0098 → 0099 → 0101 → 0102` nebylo na DB provedeno; patří do samostatně autorizovaného migračního preflightu. |
| F13.8A-09 | RISK | Existující aplikační Dockerfiles používají pohyblivé base tagy v rámci řady (`node:24-slim`, `nginx:1.27-alpine`) a PostgreSQL je `postgres:16-alpine`. Testovací build zaznamenal aktuální digest, Compose jej ale neuzamyká. | Před prvním staging deployem rozhodnout, zda release policy vyžaduje digest pinning všech base/runtime obrazů. |

## Architektura a hranice

| Služba | Úloha | Síť / publikace | Stavová data |
| --- | --- | --- | --- |
| `staging-preflight` | Fail-closed validace originu, SHA, S3 a secrets bez jejich výpisu. | Pouze interní default network; jednorázová. | Žádná. |
| `postgres` | Nová staging-only PostgreSQL 16 databáze. | Jen interní `5432`, bez domain/host portu. | `staging_pgdata`. |
| `mailpit` | Uzavřený SMTP/UI sandbox, povinné ověřené STARTTLS. | Jen interní `1025` a `8025`, bez domain/host portu. | TLS private volume `staging_mailtls`; veřejná CA `staging_mailca`; zprávy jsou efemérní. |
| `api` | Produkční build API se staging-only env a externím S3. | Jen interní `5000`, bez domain/host portu. | DB a externí S3; lokálně žádný API datový volume. |
| `web` | Nginx/PWA build s exact `VITE_BUILD_SHA`. | Jediná služba určená pro Coolify domain na container portu `80`. | Žádná. |

Vlastní Compose sítě byly odstraněny. Coolify dokumentace upozorňuje, že u Compose
resource může vlastní síť způsobit, že Traefik zvolí nesprávnou IP a vrací náhodné
504. Izolaci proto dodá automatická per-resource síť Coolify; domain se přiřadí jen
webové službě:

- <https://coolify.io/docs/applications/build-packs/docker-compose>
- <https://coolify.io/docs/knowledge-base/docker/compose>

## Secret a S3 kontrakt

`.env.staging.example` je záměrně nevyplněná šablona a je jedinou povolenou `.env.*`
výjimkou v Git. Vyžaduje nové, staging-only hodnoty:

- origin mimo `modvoltapp.cz` a jeho subdomény;
- plný lowercase 40znakový commit SHA;
- nové PostgreSQL a session secrets;
- externí HTTPS S3 endpoint, region a bucket začínající `site-logbook-staging`;
- nový provider-issued access key omezený pouze na staging bucket;
- dva validní JSON keyringy s rozdílnými 32bytovými aktivními klíči.

FÁZE 13.8A S3 nekontaktovala. Nevytvořila bucket, credential, policy, versioning,
Object Lock ani retention. Tyto vlastnosti musí další živá fáze ověřit existujícím
read-only recovery-storage preflightem a uložit secret-free fingerprint/evidence.
Produkční S3 bucket ani credentials se nesmějí znovu použít.

## Mail sandbox

Mailpit `v1.30.0` je security-fixed release a staging Compose nepředává žádné relay
nebo forwarding proměnné. Na prvním startu vznikne staging-only CA a certifikát se SAN
`mailpit`; CA private key je po podpisu odstraněn. API má read-only jen veřejnou CA,
zatímco serverový private key zůstává v samostatném volume Mailpitu. Mailpit vyžaduje
STARTTLS a aplikace již používá `requireTLS`, `rejectUnauthorized` a TLS 1.2+.

Reference:

- <https://github.com/axllent/mailpit/releases>
- <https://mailpit.axllent.org/docs/configuration/smtp/>
- <https://mailpit.axllent.org/docs/integration/healthcheck/>

## Provedené kontroly

- secret-free `.env.staging.example` skončil při `docker compose config --quiet`
  fail-closed; úplná syntetická konfigurace prošla;
- finální service inventory: `staging-preflight`, `postgres`, `mailpit`, `api`, `web`;
- žádné `ports:` ani vlastní `networks:` ve staging Compose;
- plný finální build čtyř vlastních obrazů (`staging-preflight`, `mailpit`, `api`,
  `web`): PASS;
- exact syntetické SHA `0123456789abcdef0123456789abcdef01234567` v API image env a
  ve frontend artefaktu: PASS;
- validní preflight: PASS; HTTP S3, bucket mimo staging namespace, neplatný keyring a
  znovupoužitý aktivní klíč: správně odmítnuty bez úniku hodnot;
- Mailpit health, CA-only mount do API, ověřené STARTTLS a zachycení zprávy: PASS;
- shell syntax obou entrypointů, `node --check`, `git diff --check`: PASS;
- `pnpm run lint`: PASS;
- `pnpm run test:staging-contract`: 13/13 PASS;
- `pnpm run typecheck:e2e:staging`: PASS;
- credential-pattern scan a kontrola prázdných secret polí: PASS;
- testovací kontejnery, default networks a prázdné volumes byly odstraněny.

Lokální testovací Docker images/build cache zůstaly jen pro opakovatelnost. Nebyl
spuštěn PostgreSQL service, default API startup, web proti reálnému API, skutečný S3,
Coolify ani autentizované staging E2E.

## Nevyřešené otázky pro živý staging

1. Jaký je přesný externí S3 endpoint, region, nový staging bucket a path-style režim?
2. Kdo vytvoří nový least-privilege S3 credential a doloží, že nemůže zapisovat do
   produkčního bucketu?
3. Jsou na staging bucketu zapnuty versioning, Object Lock, default retention,
   encryption a blok veřejného přístupu; jaký je očekávaný fingerprint?
4. Jaký samostatný HTTPS origin mimo `modvoltapp.cz` bude použit a kdo ovládá DNS?
5. Je v Coolify dostupný samostatný resource/server a kdo vloží secrets bez jejich
   přenosu do repozitáře nebo auditu?
6. Jaké hodnoty `--max-age-days` schválí service owner zvlášť pro `ppe_signature` a
   `ppe_confirmation`?
7. Má release policy před prvním deployem vyžadovat digest pinning Node, Nginx a
   PostgreSQL obrazů?

Dokud nejsou odpovědi doloženy a změny publikovány se zeleným Quality gate na přesném
SHA, zůstává Coolify provisioning, API start a migrační preflight **BLOCKED**.
