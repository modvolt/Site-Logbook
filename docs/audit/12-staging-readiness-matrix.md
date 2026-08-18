# FÁZE 12 – staging a release-readiness matice

## Rozhodnutí

Tento dokument je centrální registr FÁZE 12. Rozlišuje tři stavy:

- **PASS** – prokázáno v tomto checkoutu reprodukovatelnou kontrolou;
- **BLOCKED** – bezpečný důkaz vyžaduje chybějící externí staging, účet nebo
  rozhodnutí vlastníka;
- **N/A** – nebylo součástí FÁZE 12 a nesmí být z lokálního důkazu dovozováno.

Žádný lokální PASS není souhlas s produkčním deployem. Produkční DB, object
storage, secrets, mail, `modvoltapp.cz` a vzdálený repository nebyly změněny.

## Matice bran

| Brána                                                         | Stav                   | Důkaz / chybějící vstup                                                                                                                   | Release důsledek                                                                                                             |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| nový object bundle nebufferuje celý objekt                    | PASS                   | schema `modvolt-object-recovery/v2`, 8MiB autentizované bloky, streamované S3/GCS čtení a zápis                                           | v2 lze použít pro další staging drill                                                                                        |
| čitelnost bundle v1                                           | PASS                   | cílený test vytvoří, ověří a obnoví v1 bundle                                                                                             | dřívější lokální bundle nejsou v2 změnou zneplatněny                                                                         |
| změna objektu během snapshotu                                 | PASS                   | S3 čtení s `If-Match` ETag; GCS čtení konkrétní generace; délková a hash kontrola                                                         | snapshot failuje místo tiché smíšené kopie                                                                                   |
| šifrování a tamper detection                                  | PASS                   | per-chunk MVE1/AES-256-GCM, autentizovaný manifest, encrypted/plaintext SHA-256                                                           | poškozený bundle se neobnoví                                                                                                 |
| freshness kontrola                                            | PASS lokálně           | `objects:recovery freshness` autentizuje celý bundle a vrací exit 2 při překročení limitu                                                 | lze připojit k monitoringu; samotný scheduler/alert není zaveden                                                             |
| read-only policy preflight                                    | PASS lokálně           | kontrola access/TLS/versioning/Object Lock/retence/encryption/public-access-block a fingerprintu                                          | provider se během kontroly nemění                                                                                            |
| izolovaný S3 large-object drill                               | PASS                   | MinIO, 13/13 objektů, 67 109 121 B největší objekt, 8MiB chunks, read-back hash/typ/metadata                                              | reprodukovatelný lokální baseline                                                                                            |
| automatizace drillu v CI                                      | PASS lokální deklarace | krok v `.github/workflows/quality-gate.yml`, pinovaný MinIO release tag, fail-closed loopback runner                                      | není ověřeno vzdáleným runem, dokud změna není autorizovaně publikována                                                      |
| vzdálený GitHub CI                                            | BLOCKED                | default branch končí `a25c312`; nemá combined status, PR workflow run ani `quality-gate.yml`                                              | bez publikace a zeleného runu zákaz release                                                                                  |
| externí staging S3/GCS                                        | BLOCKED                | nejsou dostupné `STAGING_*`/S3/GCS přístupy ani schválený provider                                                                        | nelze tvrdit provider kompatibilitu ani off-site nezávislost                                                                 |
| oddělený účet a recovery credential                           | BLOCKED                | lokální drill záměrně používá jedny testovací MinIO credentials pro oba buckety                                                           | produkční release vyžaduje jiný účet/credential boundary                                                                     |
| immutable default retention                                   | BLOCKED                | lokální bucket prokazuje Object Lock capability, ale nemá default retention, aby byl po testu ukliditelný                                 | schválit režim a nenulovou retenci, poté preflight s minimem                                                                 |
| veřejný přístup a server-side encryption u cílového providera | BLOCKED                | MinIO lokální API není důkazem cílové policy; preflight vrací `unknown` fail-closed, pokud jsou volby vyžádány                            | cílový release gate musí použít `--require-encryption` a `--require-public-access-block`, nebo evidovat schválený ekvivalent |
| key custody a dual control                                    | BLOCKED                | není určen vlastník current/old/recovery klíčů ani break-glass postup                                                                     | recovery klíč nesmí být jen ve stejném runtime jako zdroj                                                                    |
| automatická cadence a alert delivery                          | BLOCKED                | freshness příkaz existuje; scheduler, metriky a příjemce alertu ne                                                                        | bez prokázaného alertu nelze přijmout RPO                                                                                    |
| schválené RPO/RTO                                             | BLOCKED                | lokální `recoveryPointAgeSeconds=0.604` a `recoveryTimeSeconds=2.233` jsou pouze laboratorní baseline                                     | vlastník musí stanovit cíle a ověřit je na staging objemu/topologii                                                          |
| staging DB + object restore + business smoke                  | BLOCKED                | DB restore byl lokálně prokázán ve FÁZI 10, object restore zde; anonymizovaný staging snapshot ani staging business smoke nejsou dostupné | před release provést společný bod obnovy a aplikační smoke                                                                   |
| staging login/upload/download/sign/mail/PWA                   | BLOCKED                | chybí staging URL, bezpečné test identity a mail sandbox                                                                                  | obecná release-readiness zůstává červená                                                                                     |
| produkční deploy/migrace/backfill/rotace                      | N/A                    | FÁZE 12 je bez produkční autorizace                                                                                                       | neprovádět                                                                                                                   |

## Lokální S3 evidence

- MinIO community: `RELEASE.2025-09-07T16-13-09Z`;
- SHA-256 Windows binárky:
  `af709e6ba68488404e85acdd22a3030d0f5e56a108d4b27d744f18ceb50861b4`;
- endpoint pouze `127.0.0.1:19112`;
- source/target: náhodně pojmenované `modvolt-phase12-*-test-*` buckety;
- 12 chráněných prefixů plus 1 velký objekt;
- bundle schema v2, chunk 8 388 608 B;
- 13 snapshotovaných, 13 obnovených, 13 read-back ověřených objektů;
- největší objekt 67 109 121 B;
- peak Node RSS 222 892 032 B;
- lokální recovery point age 0,604 s a celkový script baseline 2,233 s;
- po testu odstraněny obě versioned bucket historie, bundle, MinIO data, binárka
  i proces.

Časy neobsahují síťovou vzdálenost, reálný objem, throttling, DB obnovu ani
business smoke. Nejsou tedy RPO/RTO závazkem.

## Povinný externí příkazový profil

Staging/off-site preflight má být spuštěn minimálně s:

```text
preflight
--expected-fingerprint <předem schválený SHA-256>
--require-versioning
--require-object-lock
--minimum-retention-days <schválené minimum>
--require-encryption
--require-public-access-block
```

Volba `--allow-http-loopback` je povolena jen lokálnímu drillu; na stagingu ani
v produkci se nesmí použít. `unknown` je u vyžadované policy neúspěch, nikoli
měkké upozornění.

## Návrh rozhodnutí vlastníka (dosud neschváleno)

Pro další provozní schválení doporučujeme jako výchozí diskusní hodnoty:

- databázový recovery point nejvýše 1 hodina;
- off-site object bundle nejvýše 4 hodiny;
- společné DB + object obnovení a business smoke nejvýše 4 hodiny;
- immutable retence alespoň 30 dní;
- dvě osoby pro vydání recovery klíče a změnu retence.

Tyto hodnoty jsou návrh, nikoli potvrzený závazek Modvolt.
