# R05 – provozní runbook šifrování secretů

## Rozsah a bezpečnostní hranice

Migrace `0099_secret_envelope_encryption.sql` a aplikační vrstva `mve1` chrání hodnoty uložené v PostgreSQL a nové databázové zálohy:

| Oblast | Chráněná hodnota | Kontext AAD |
|---|---|---|
| trezor zařízení | celý citlivý payload přístupu a topologie | tabulka + ID řádku + `secret` |
| SMTP | heslo | tabulka + ID řádku + `password` |
| IMAP | heslo | tabulka + ID řádku + `password` |
| OpenAI | API klíč | tabulka + ID řádku + `api_key` |
| Gmail OAuth | refresh token | tabulka + ID řádku + `refresh_token` |
| QR rozvaděče | privátní QR token | tabulka + ID řádku + `qr_token` |
| DB záloha | celý `pg_dump -Fc` | název zálohy + `pg_dump` |

Každý nový zápis používá náhodný 256bitový datový klíč, AES-256-GCM s 96bitovým IV a AAD svázané s řádkem a polem. Datový klíč se zabalí aktivním externím KEK; envelope obsahuje verzi a ID klíče, nikoli samotný KEK. Nové zápisy při chybějícím nebo neplatném keyringu selžou uzavřeně. Čtení dočasně podporuje legacy formáty, aby byl možný měřený backfill.

Tato vrstva významně snižuje dopad samostatně odcizené DB nebo zálohy. Nechrání proti kompromitaci běžícího API hostu, jeho procesového prostředí nebo účtu správce keyringu. Aktuální implementace definuje přísnou externí keyring hranici přes secrets prostředí; konkrétní produkční KMS/HSM či secret manager a jeho DR vlastnictví v repozitáři zvoleny nejsou. Provozní hodnoty typu `DATABASE_URL`, OAuth client secret a S3 credentials zůstávají mimo DB a musí je chránit Coolify nebo zvolený správce secretů.

## Požadovaná konfigurace

Použij dva nezávislé keyringy. Hodnota je kompaktní JSON objekt; každý klíč musí být přesně 32 náhodných bajtů v kanonickém Base64 a ID může obsahovat pouze písmena, číslice, tečku, podtržítko a pomlčku.

```dotenv
SECRET_ENCRYPTION_KEYRING={"2026-08":"<32-byte-base64>"}
SECRET_ENCRYPTION_ACTIVE_KEY_ID=2026-08
BACKUP_ENCRYPTION_KEYRING={"backup-2026-08":"<jiný-32-byte-base64>"}
BACKUP_ENCRYPTION_ACTIVE_KEY_ID=backup-2026-08
```

Jednotlivé hodnoty lze vygenerovat například `openssl rand -base64 32`. Skutečné klíče nevkládej do repozitáře, shell historie, ticketu ani logu. Ulož je přímo v produkčním secret manageru, omez čtení na aplikační workload a recovery roli a před cutoverem ověř zálohu konfigurace mimo aplikační DB.

`TOKEN_ENCRYPTION_KEY` je po nasazení `0099` pouze legacy read klíč pro staré Gmail/QR hodnoty. Musí zůstat dostupný do úspěšného backfillu a ověření nulového počtu legacy hodnot; nové zápisy jej nepoužívají.

## Bezpečný rollout

1. Zaznamenej počty kandidátů níže; nikdy nevypisuj hodnoty sloupců.
2. Vlož oba keyringy a aktivní ID do secret manageru. Ověř, že aplikační a backup klíče nejsou stejné a že recovery role umí jejich kontrolovanou obnovu.
3. Aplikuj expand-only migraci `0099`. Nemění žádnou existující hodnotu a ponechá legacy čtení.
4. Nasaď API se stále dostupným `TOKEN_ENCRYPTION_KEY`. Bez `0099` se nová verze API nesmí spustit.
5. Proveď dry-run proti přesně pojmenované databázi:

   ```powershell
   pnpm --filter @workspace/api-server secrets:backfill
   ```

   Výstup obsahuje pouze databázi a počty kandidátů. Pokud jsou počty neočekávané nebo příliš velké pro jedno maintenance okno, zastav rollout a rozděl migraci; současný nástroj provádí celý backfill v jedné transakci.

6. Po potvrzení názvu databáze spusť explicitní zápis:

   ```powershell
   pnpm --filter @workspace/api-server secrets:backfill -- --execute --confirm=ENCRYPT_SECRETS --database=<presny_nazev_db>
   ```

7. Zopakuj dry-run. Všechny kategorie musí mít `0`. Ověř SQL canary dotazy a přihlášení k jednomu neprodukčnímu zařízení, test SMTP/IMAP/OpenAI, Gmail import a QR načtení.
8. Vytvoř novou zálohu. V `backup_log` musí mít `encryption_format = 'mve1'` a očekávané backup key ID. Obnov ji do izolované databáze a spusť business smoke test; obnova do produkce není součástí ověření.
9. Teprve po úspěšném restore testu a nulových legacy počtech odstraň `TOKEN_ENCRYPTION_KEY`. Legacy DB sloupce zatím nemaž; jejich contract migrace vyžaduje samostatné schválení.

## Canary dotazy bez úniku hodnot

```sql
SELECT
  count(*) FILTER (WHERE secret_ciphertext IS NULL) AS device_without_envelope,
  count(*) FILTER (WHERE ip_address IS NOT NULL OR pin IS NOT NULL OR username IS NOT NULL
    OR password IS NOT NULL OR email IS NOT NULL OR note IS NOT NULL
    OR users <> '[]'::jsonb OR network_topology <> '[]'::jsonb) AS device_legacy_values
FROM device_credentials;

SELECT
  (SELECT count(*) FROM email_settings
    WHERE password IS NOT NULL OR (password_ciphertext IS NOT NULL AND left(password_ciphertext, 5) <> 'mve1.')) AS smtp_legacy,
  (SELECT count(*) FROM email_import_settings
    WHERE password IS NOT NULL OR (password_ciphertext IS NOT NULL AND left(password_ciphertext, 5) <> 'mve1.')) AS imap_legacy,
  (SELECT count(*) FROM openai_settings
    WHERE api_key IS NOT NULL OR (api_key_ciphertext IS NOT NULL AND left(api_key_ciphertext, 5) <> 'mve1.')) AS openai_legacy,
  (SELECT count(*) FROM email_import_accounts
    WHERE refresh_token_encrypted IS NOT NULL AND left(refresh_token_encrypted, 5) <> 'mve1.') AS gmail_legacy,
  (SELECT count(*) FROM switchboards
    WHERE qr_token_ciphertext IS NOT NULL AND left(qr_token_ciphertext, 5) <> 'mve1.') AS qr_legacy;
```

Dotazy vracejí pouze počty. Ciphertext, plaintext, keyring ani dešifrovaná data se nesmějí kopírovat do auditních výstupů.

## Rotace klíčů

### Aplikační secrety

1. Přidej nový náhodný klíč do `SECRET_ENCRYPTION_KEYRING`, nastav jeho ID jako aktivní a ponech staré klíče pro čtení.
2. Nasaď konfiguraci a proveď dry-run. Nástroj vybere legacy hodnoty i envelopes s jiným než aktivním ID.
3. Spusť potvrzený backfill, zopakuj dry-run a ověř, že žádný řádek neodkazuje na staré ID.
4. Až po funkčních testech a ověřené recovery konfiguraci odstraň starý klíč z keyringu.

### Zálohy

Přidej nový klíč do `BACKUP_ENCRYPTION_KEYRING` a nastav jej jako aktivní. Starý backup klíč ponech, dokud všechny zálohy, které jej používají, neskončí standardní retenční dobou nebo nebudou nahrazeny ověřenou novou zálohou. Před odebráním každého starého klíče proveď restore test nejstarší stále podporované zálohy. R05 staré backup objekty hromadně nepřepisuje ani nemaže.

## Selhání, tamper a rollback

| Stav | Očekávané chování | Provozní reakce |
|---|---|---|
| chybí keyring nebo aktivní ID | nový secret/backup vrátí bezpečnou chybu, plaintext se neuloží | obnovit schválenou konfiguraci; neobcházet šifrování |
| envelope odkazuje na neznámé ID | čtení selže uzavřeně | obnovit odpovídající starý klíč z recovery úložiště |
| ciphertext, tag nebo AAD byly změněny | autentizace AES-GCM selže, bez fallbacku na legacy | incident, izolace zdroje změny, obnova z ověřené zálohy |
| backfill selže | jeho jediná DB transakce se vrátí zpět | opravit příčinu, zopakovat dry-run a následně execute |
| nová aplikace musí být vrácena | starší aplikace nerozumí novým envelopes | preferovat roll-forward; nevracet aplikaci bez kompatibilního readeru |
| rollback `0099` po encrypted zápisech | down migrace se úmyslně zablokuje | zachovat sloupce a roll-forward; nejprve obnovit funkční keyring |

Rollback schématu je bezpečný pouze před prvním encrypted zápisem. Po cutoveru je primární recovery postup obnova správných klíčů a roll-forward, nikoli převod dat zpět do plaintextu.

## Co ve FÁZI 8.9 nebylo provedeno

- nebyla čtena ani měněna produkční DB, produkční secrets nebo `modvoltapp.cz`;
- nebyla aplikována produkční migrace, backfill, rotace, záloha ani obnova;
- nebyl vybrán ani nakonfigurován konkrétní KMS/HSM provider;
- nebyl proveden push ani deploy.

Před produkcí musí provozní vlastník schválit key custody, emergency access, audit přístupu, rotaci, retenci starých backup klíčů a restore drill.
