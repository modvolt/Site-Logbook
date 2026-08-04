# R15-C – staging alert rollout verification

## Rozsah

R15-C připravuje bezpečný, opakovatelný rollout nezávislého alert receiveru do
odděleného stagingu. Tato část nevytváří DNS, TLS, secret, GHCR package ani volume,
nic nenasazuje a neaplikuje migraci `0103` ani `0100`.

## Implementovaný kontrakt

- staging runtime má šest služeb; receiver je pull-only immutable image a zvyšuje
  hard limit pouze na 2,5 CPU a 2432 MiB;
- receiver běží s read-only root filesystemem, bez Linux capabilities, s
  `no-new-privileges`, 128MiB limitem a samostatným persistentním receipt volume;
- API čeká na exact-SHA receiver health a webhook je aktivní pouze pro přesný
  veřejný HTTPS hostname a staging-only bearer token;
- preflight odmítá produkční, loopback, privátní, interní, single-label a společný
  app/receiver hostname, mutable image i slabý token;
- privátní GHCR publisher rozšiřuje append-only stavový automat ze čtyř na pět
  balíčků a receiver publikuje až po ověření předchozích image;
- manuální smoke vyžaduje třetí výslovné potvrzení, ověří exact SHA API i receiveru
  a prokáže první přijetí plus persistentní duplicate ACK;
- secret-free drill evidence se zapisuje výhradně do nového souboru mimo repo;
- finální staging evidence schema v3 rozlišuje přímý receiver smoke, skutečný
  durable outbox delivery a dead-man trigger/recovery.

## Bezpečnostní invarianty

1. Produkční `modvoltapp.cz` ani jeho subdomény nejsou povoleným staging targetem.
2. Receiver a aplikace musí mít různé veřejné HTTPS hostname.
3. Token se čte pouze z prostředí; workflow, evidence ani dokumentace jeho hodnotu
   neukládají.
4. Deployment používá přesný 40znakový source SHA a image digest.
5. Automatický synthetic smoke se nevydává za důkaz durable outboxu ani dead-man
   fault drillu.
6. Workflow nic nenasazuje; externí provisioning a fault injection vyžadují
   samostatně potvrzený izolovaný staging.

## Lokální ověření

- 29 cílených Node testů: PASS;
- `check-staging-runtime-contract`: PASS, 6 služeb, 5 immutable custom image,
  2,5 CPU, 2432 MiB;
- strict unique-key YAML parse obou změněných workflow: PASS;
- cílený ESLint bez warningů: PASS;
- workspace TypeScript check všech čtyř relevantních projektů: PASS;
- `git diff --check`, kontrola rozsahu migrací a hard-coded token pattern: PASS;
- lokální Docker workflow harness úmyslně nespuštěn: Docker engine v tomto systému
  při předchozí sondě zamrzl; plný 64stavový publisher harness musí provést GitHub
  Quality gate.

## Externí ověření, které tato část neprovedla

- publikace pěti privátních GHCR image a ověření digest/provenance/SBOM;
- vytvoření staging receiver DNS/TLS, persistentního volume a secret custody;
- nasazení přesného SHA a staging aplikace migrace `0103`;
- reálný durable outbox, restart-volume, dead-man trigger/recovery a log-alert drill;
- finální schema-v3 staging evidence gate.

Tyto body nejsou autorizací změny produkce a musí proběhnout pouze proti explicitně
ověřenému oddělenému staging targetu.
