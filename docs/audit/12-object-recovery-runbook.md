# FÁZE 12 – object recovery v2 runbook

## Bezpečnostní hranice

Recovery CLI je offline operátorský nástroj. Nepřepíná aplikaci, neobnovuje DB,
nemění bucket policy a neodstraňuje objekty. Restore zapisuje jen do prázdného,
odlišného storage namespace po potvrzení fingerprintu a proměnné
`OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET=true`.

Nové snapshoty používají `modvolt-object-recovery/v2`: objekt je čten jako
stream, dělen na samostatně autentizované MVE1 bloky a obnovován streamem.
Výchozí blok je 8 MiB. Ověřování a restore zůstávají kompatibilní s v1; v1 však
z principu při obnově bufferuje celý historický payload.

## 1. Předpoklady

1. Nastavit pouze credentials pro právě kontrolovaný source nebo target.
2. Načíst `BACKUP_ENCRYPTION_KEYRING` a `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` z
   recovery úschovy, ne ze stejného jediného runtime jako zdroj.
3. Source a target musí být odlišný bucket/prefix; produkční off-site cíl má mít
   také jiný účet/credential boundary.
4. Před restore uchovat výstup `identity` a schválit fingerprint dvěma osobami.
5. Na staging/produkčním endpointu nepovolit plaintext HTTP.

CLI nevypisuje access key ani secret key. Výstup preflightu obsahuje pouze
secret-free identity, fingerprint, stav provider kontrol a stabilní kódy
porušení.

## 2. Read-only preflight

```powershell
pnpm --filter @workspace/api-server objects:recovery -- identity

pnpm --filter @workspace/api-server objects:recovery -- preflight `
  --expected-fingerprint '<schválený SHA-256>' `
  --require-versioning `
  --require-object-lock `
  --minimum-retention-days 30 `
  --require-encryption `
  --require-public-access-block
```

Exit `0` znamená splnění všech vyžádaných kontrol. Exit `2` znamená
`ready=false`; `violations` je release blokátor. Provider, který danou read API
nepodporuje nebo ji credentialu nepovolí, vrátí `unknown`. U volby `--require-*`
se `unknown` vyhodnotí jako neúspěch.

`--allow-http-loopback` patří pouze do izolovaného lokálního/CI drillu.

## 3. Snapshot

Výstupní adresář nesmí existovat a musí být absolutní:

```powershell
pnpm --filter @workspace/api-server objects:recovery -- snapshot `
  --output 'D:\modvolt-recovery\2026-08-02T1200Z'
```

Volitelný `--chunk-bytes` přijímá celé číslo nejvýše 67 108 864. Výchozích
8 388 608 B je ověřený profil. Snapshot:

- inventarizuje celý private prefix;
- připne S3 čtení k ETag pomocí `If-Match`, GCS k object generation;
- při změně/zmizení objektu failuje a odstraní nedokončený bundle;
- šifruje každý blok a manifest odděleným backup keyringem;
- ukládá SHA-256 plaintextu i ciphertextu, velikost, typ a source timestamp.

Bundle přenést mimo source účet a chránit provider immutable retencí. Samotný
lokální adresář není off-site záloha.

## 4. Ověření a freshness

```powershell
pnpm --filter @workspace/api-server objects:recovery -- verify `
  --bundle 'D:\modvolt-recovery\2026-08-02T1200Z'

pnpm --filter @workspace/api-server objects:recovery -- freshness `
  --bundle 'D:\modvolt-recovery\2026-08-02T1200Z' `
  --max-age-hours 4
```

Freshness autentizuje celý bundle; nekontroluje jen nechráněný timestamp.
Zastaralý bundle vrátí JSON s `fresh=false` a exit `2`. Scheduler musí tento
exit napojit na monitor s konkrétním vlastníkem a eskalační cestou.

## 5. Restore do izolovaného cíle

Nejdříve přepnout všechny `S3_*`/GCS proměnné na nový prázdný target, spustit
preflight a opsat jeho fingerprint:

```powershell
$env:OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET='true'
pnpm --filter @workspace/api-server objects:recovery -- restore `
  --bundle 'D:\modvolt-recovery\2026-08-02T1200Z' `
  --target-fingerprint '<fingerprint targetu>'
Remove-Item Env:\OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET
```

Restore nejprve ověří celý bundle, odmítne source identity a neprázdný target,
streamuje objekty a každý objekt znovu načte a zkontroluje podle délky, SHA-256
a `Content-Type`. Při chybě může v izolovaném targetu zůstat částečný forenzní
stav; nástroj jej automaticky nemaže.

DB dump je jeden z obnovených objektů. Teprve potom se samostatně obnovuje do
nové PostgreSQL instance podle DB runbooku; nikdy se nepřepisuje původní DB.

## 6. Izolovaný CI drill

`objects:recovery:drill` má tvrdé guardy:

- `NODE_ENV=test`;
- `OBJECT_RECOVERY_DRILL_CONFIRM_ISOLATED=true`;
- pouze loopback HTTP endpoint;
- náhodné bucket názvy obsahující `phase12` a `test`;
- oddělený source a target;
- úklid všech versioned objektů, bucketů a bundle v `finally`.

Drill vytváří Object-Lock-capable a versioned buckety bez default retention,
aby je bylo možné ihned odstranit. Dokazuje schopnost API, ne platnou staging
retenci nebo credential separation.

## 7. Abort podmínky

Okamžitě zastavit release, pokud:

- fingerprint není předem schválený nebo source/target nejsou oddělené;
- kterákoliv vyžadovaná preflight kontrola není `pass`;
- bundle není čerstvý, verify neprojde nebo inventura neodpovídá očekávání;
- není dostupný starý i aktivní recovery klíč podle manifestu;
- restore hash/typ nesouhlasí byť u jediného objektu;
- DB restore a business smoke neprojdou nad stejným recovery bodem;
- nelze doložit scheduler, alert delivery, key custody a vlastníka incidentu.
