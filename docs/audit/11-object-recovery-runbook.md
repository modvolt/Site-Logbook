# FÁZE 11 – Object recovery runbook

## 1. Účel a bezpečnostní hranice

Příkaz `objects:recovery` vytváří šifrovaný recovery bundle všech objektů pod
aktuálním privátním prefixem, ověří jeho integritu a umí jej obnovit do jiného,
prázdného object store. Používá oddělený `BACKUP_ENCRYPTION_KEYRING`; plaintext
objektů ani jejich cesty nejsou v nešifrovaném manifestu.

Tento nástroj sám nezavádí plánovač, off-site přenos, bucket versioning, Object
Lock, retenci, WAL/PITR ani úschovu klíčů. Produkční R08 je možné uzavřít až po
infrastrukturním nastavení, schválení RPO/RTO a úspěšném drillu na staging kopii.

## 2. Garance v1 bundle

- výstupní adresář musí být absolutní a před spuštěním nesmí existovat;
- každý objekt je šifrován samostatným AES-256-GCM envelope a AAD váže payload
  na `bundleId` a původní object path;
- manifest s cestami, typem obsahu, velikostí a plaintext/ciphertext SHA-256 je
  rovněž šifrovaný;
- nešifrovaný `bundle.json` obsahuje jen bootstrap metadata, počet/velikost,
  key ID a hash šifrovaného manifestu;
- `verify` autentizuje manifest a každý payload a porovná obě velikosti i hashe;
- `restore` vyžaduje oddělenou storage identitu, explicitní potvrzení a přesný
  fingerprint cíle;
- restore před prvním zápisem ověří, že žádná cílová cesta již neexistuje, a po
  každém zápisu znovu porovná plaintext SHA-256;
- chyba při tvorbě odstraní pouze nově vytvořený neúplný bundle adresář.

## 3. Vytvoření a ověření bundle

Na zabezpečeném administrátorském hostu nastavte zdrojové `S3_*` nebo
`PRIVATE_OBJECT_DIR` a backup keyring. Nikdy nekopírujte secrets do příkazové
historie nebo do runbooku.

```powershell
pnpm --filter @workspace/api-server run objects:recovery -- identity
pnpm --filter @workspace/api-server run objects:recovery -- snapshot --output C:\recovery\modvolt-2026-08-02
pnpm --filter @workspace/api-server run objects:recovery -- verify --bundle C:\recovery\modvolt-2026-08-02
```

Po úspěšném `verify` přeneste celý adresář jako jednu jednotku do nezávislého,
versioned/immutable off-site úložiště s odděleným účtem. Recovery keyring a jeho
staré klíče musí mít oddělenou offline recovery kopii; bundle bez odpovídajícího
klíče nelze obnovit.

## 4. Izolovaný restore drill

1. Přepněte `S3_*`/`PRIVATE_OBJECT_DIR` na nový prázdný cílový bucket nebo
   prefix. Zdrojový a cílový secret nesmí být stejný provozní účet.
2. Spusťte `identity` a nezávisle zkontrolujte endpoint, bucket a privátní
   prefix.
3. Nastavte potvrzení pouze pro tento proces a vložte přesný fingerprint:

```powershell
$env:OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET='true'
pnpm --filter @workspace/api-server run objects:recovery -- restore `
  --bundle C:\recovery\modvolt-2026-08-02 `
  --target-fingerprint <SHA256_Z_IDENTITY>
Remove-Item Env:\OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET
```

4. Ověřte počet objektů, náhodný vzorek příloh/fotografií, všechny podepsané
   PDF a hashe. Následně obnovte šifrovaný PostgreSQL dump do nové databáze a
   spusťte aplikační business smoke. Object CLI nikdy nespouští `pg_restore`.
5. Změřte celkový čas, nejstarší bod obnovy, přenosovou rychlost a ruční kroky.
   Teprve z těchto dat lze schválit RPO/RTO.

## 5. Fail-closed stavy

Nástroj musí skončit nenulovým exit kódem při chybějícím keyringu, změně objektu
během snapshotu (nesouhlas velikosti), poškozeném descriptoru/manifestu/payloadu,
neshodě target fingerprintu, pokusu o restore do zdrojové identity, existujícím
cílovém objektu nebo neshodě hashe po zápisu. Částečně zapsaný restore se nemaže
automaticky; cílový izolovaný bucket zůstává pro forenzní kontrolu a následně se
likviduje jako celek podle provozního postupu.

## 6. Známá omezení a rozhodnutí před produkcí

- Snapshot není transakční napříč souběžně měněnými objekty. Před produkčním
  použitím je nutný provider versioning/snapshot nebo řízené write-freeze okno.
- Implementace načítá vždy jeden objekt do paměti. Před nasazením je nutné
  porovnat největší skutečný objekt a DB dump s memory limitem recovery hostu;
  pro větší artefakty doplnit streaming envelope.
- Aktuální integrační důkaz pokrývá S3/MinIO. GCS/Replit větev prošla
  typecheckem, ale vyžaduje samostatný provider drill, pokud je skutečně
  používaná.
- Nástroj bundle nikam automaticky neodesílá a nemaže staré bundle. Retence,
  immutable policy, monitoring freshness a alarmy musí vlastnit infrastruktura.
- V případě key rotation musí zůstat starý backup klíč dostupný po celou
  schválenou retenční dobu nebo musí proběhnout měřený re-encryption.

## 7. Minimální čtvrtletní protokol

Zaznamenejte bundle ID a datum, počet/velikost objektů, source/target fingerprint,
hash descriptoru, key ID (nikoli klíč), start/stop, dosažené RPO/RTO, výsledek DB
restore a business smoke, počet neshod, vlastníka drillu a ticket k nápravě.
