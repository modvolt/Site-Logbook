# R09 – exact 0106 → 0107 audit evidence gate

Stav tohoto dokumentu: **LOCAL CONTROL-PLANE CONTRACT; NOT DEPLOYED**.

Tento runbook popisuje pouze izolovaný přechod staging databáze z přesného
`0106_graceful_frog_thor` na `0107_canonical_audit_evidence`. Běžný start API
nesmí migraci provést. Produkce, deploy a spuštění migrace nejsou důkazem tohoto
lokálního checkpointu a vyžadují vlastní schválený preflight.

## Neměnné hranice

- `0100` je zakázaná a nesmí být v known ani opaque journalu.
- Přechod používá výhradně čerstvou, šifrovanou a restore-testovanou zálohu
  přesného `0106`. Artefakty a potvrzení pro `0105`/`0106` se nerecyklují.
- Known lineage má přesně 106 položek před migrací a 107 po ní. Režim `clean`
  nemá opaque řádky. Režim `production-copy-restricted` má právě tyto dvě
  identifikace, bez domýšlení názvu nebo významu:

  ```json
  [
    {
      "createdAt": 1783190993468,
      "hash": "fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927"
    },
    {
      "createdAt": 1783261969512,
      "hash": "3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa"
    }
  ]
  ```

- Host runner kontroluje resolved Compose target, jediný běžící `postgres`,
  stejný live container před i po každém one-shotu, volume/network/image vazbu
  a nulový S3 povrch transition služby.
- Profile služby `exact-0106-audit-backup` a `audit-0107-transition` nejsou
  součástí běžného `docker compose up`.
- Execution výstup má `authorizesApplicationStart=false`. Aplikaci smí povolit
  až oddělený startup/release-evidence gate nad přesnými execution bajty a SHA.

## Připnuté bajty

- SQL `0107` po canonical LF normalizaci:
  `c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122`;
  checkout/raw CRLF blob se nesmí použít jako applied identity; specializovaný
  advisory-locked gate provede pouze `0107`,
  canonicalizuje LF a zapíše tracking row s `c90d91e2...`;
- snapshot `0106`: id `18841ec6-0ec2-4ae8-8ac7-8ee8c1eb34cd`, canonical LF SHA
  `32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24`;
- snapshot `0107`: id `b20520fc-59f2-4d34-9e2f-9d7ed565288a`, canonical LF SHA
  `4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb`.
- exact known journal digest `0106`:
  `sha256:cfbf74de83f99c3ca49fb717a6784265e8ef193e75e894aab9924fb7b80e16ee`;
- exact known journal digest `0107`:
  `sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313`.

`REVOKE CREATE ON SCHEMA public FROM PUBLIC` je sticky hardening. Empty-genesis
rollback nemá známou předchozí ACL, proto toto oprávnění záměrně znovu neudělí.

## Bezpečné pořadí

1. Zastavit API/web/gate kontejnery; v izolovaném Compose projektu smí běžet jen
   stávající `postgres`. Ověřit exact candidate image/source a canonical inspect
   artifact. Profil `exact-0106-audit-backup` má
   `STAGING_AUDIT_SCHEMA_ACTION=inspect` natvrdo; migrační confirmation hodnoty
   zůstávají prázdné.
2. Po samostatném schválení vytvořit čerstvou exact-0106 zálohu:

   ```powershell
   pnpm staging:create-exact-0106-audit-backup -- --env-file .env.staging --compose-file docker-compose.staging.yml --expected-source-sha <40-hex> --lineage-mode <clean|production-copy-restricted> --opaque-legacy-rows-json '<exact-json>' --inspect-inputs <binding>\staging-deployment-inspect.json --inspect-inputs-checksum <binding>\staging-deployment-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --confirm CREATE_FRESH_EXACT_0106_STAGING_BACKUP_AND_RESTORE_TEST_NO_0107 --output-dir <fresh-backup-dir>
   ```

   Výstup `staging-exact-0106-audit-backup-execution.json` a checksum nikdy
   neautorizují `0107`, start aplikace, prune ani destructive restore.

3. Vytvořit nový binding z přesných inspect a backup execution bajtů:

   ```powershell
   pnpm gate:staging-audit-0107-binding -- --expected-source-sha <40-hex> --lineage-mode <clean|production-copy-restricted> --opaque-legacy-rows-json '<exact-json>' --inspect-inputs <binding>\staging-deployment-inspect.json --inspect-inputs-checksum <binding>\staging-deployment-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --backup-execution <backup>\staging-exact-0106-audit-backup-execution.json --backup-execution-checksum <backup>\staging-exact-0106-audit-backup-execution.sha256 --expected-backup-execution-sha256 <64-hex> --output-dir <fresh-0107-binding-dir>
   ```

   Přenést secret-free hodnoty z `staging-audit-0107.env`; confirmation zůstává
   prázdná. Ověřit zvlášť canonical transition/inspect checksumy.

4. Teprve po schválení one-shotu spustit přesný transition runner:

   ```powershell
   pnpm staging:apply-audit-0107-transition -- --env-file .env.staging --compose-file docker-compose.staging.yml --expected-source-sha <40-hex> --transition-inputs <binding>\staging-audit-0107-transition.json --transition-inputs-checksum <binding>\staging-audit-0107-transition.sha256 --expected-transition-inputs-sha256 <64-hex> --inspect-inputs <binding>\staging-audit-0107-inspect.json --inspect-inputs-checksum <binding>\staging-audit-0107-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --backup-execution <backup>\staging-exact-0106-audit-backup-execution.json --backup-execution-checksum <backup>\staging-exact-0106-audit-backup-execution.sha256 --expected-backup-execution-sha256 <64-hex> --confirm APPLY_0107_AUDIT_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING --output-dir <fresh-0107-execution-dir>
   ```

   Runner před stateful one-shotem znovu ověří canonical resolved Compose a
   secret-free live Postgres projection, uloží jejich digesty do canonical
   intentu a po one-shotu je ověří znovu. První pokus musí vrátit `APPLIED`.
   `NOOP` je přípustný pouze při recovery se shodným již uloženým intentem.

5. Offline ověřit všechny exact bajty:

   ```powershell
   pnpm gate:staging-audit-0107-execution -- --expected-source-sha <40-hex> --transition-inputs <binding>\staging-audit-0107-transition.json --transition-inputs-checksum <binding>\staging-audit-0107-transition.sha256 --expected-transition-inputs-sha256 <64-hex> --inspect-inputs <binding>\staging-audit-0107-inspect.json --inspect-inputs-checksum <binding>\staging-audit-0107-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --backup-execution <backup>\staging-exact-0106-audit-backup-execution.json --backup-execution-checksum <backup>\staging-exact-0106-audit-backup-execution.sha256 --expected-backup-execution-sha256 <64-hex> --intent <execution>\staging-audit-0107-intent.json --intent-checksum <execution>\staging-audit-0107-intent.sha256 --expected-intent-sha256 <64-hex> --execution <execution>\staging-audit-0107-execution.json --execution-checksum <execution>\staging-audit-0107-execution.sha256 --expected-execution-sha256 <64-hex>
   ```

6. Až oddělený startup/release-evidence gate přijme canonical intent i
   execution bytes, jejich SHA, stejný `BUILD_SHA`, exact 107 known migrations a exact opaque
   lineage, lze samostatně schválit start nové aplikace. Runtime migrator musí
   zůstat vypnutý.

## Stop podmínky

Okamžitě zastavit při chybějícím/duplicitním/extra known řádku, přítomnosti
`0100`, jiných opaque identitách, odlišném SQL/snapshot hashi, existujícím
audit objektu na exact `0106`, chybějícím singleton headu na `0107`, jiné live
Postgres identitě, dalším běžícím service, S3 povrchu transition gate, staré či
neobnovené záloze, částečném intentu/execution výstupu nebo nejistém výsledku
commitu. Neprovádět slepý retry, rollback ani start API.

Před pozdějším production rolloutem je navíc stop podmínkou jakýkoli rozdíl
mezi deployed a desired Coolify Compose konfigurací. Staging evidence se nesmí
použít k tichému přijetí produkčního provisioning driftu; production potřebuje
vlastní observed/resolved target binding.
