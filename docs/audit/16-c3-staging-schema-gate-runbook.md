# R16-C3 – runbook izolovaného schema dark rollout

Datum: 2026-08-05

Tento runbook připravuje migraci `0105_smooth_nitro` pouze v novém izolovaném
stagingu. Neautorizuje merge do `main`, produkční deploy, změnu produkčních
secretů, spuštění migrace ani zapnutí externích účtů.

## Neměnné hranice

- Produkční Coolify resource `Modvolt`, doména `modvoltapp.cz`, produkční DB a
  produkční S3 zůstávají mimo rozsah.
- Staging smí použít obnovenou kopii produkční zálohy, ale musí mít vlastní
  aplikaci, síť, PostgreSQL volume, DB identitu, S3 bucket a credentials, mail
  sandbox, admin identitu a alert receiver.
- `EXTERNAL_ACCOUNTS_ENABLED` zůstává přesně `false`.
- Migrace `0100` nesmí být v journalu, souborech ani živé DB evidenci.
- V R16-C3 se nevytváří draft, scope, event ani externí uživatel. První takový
  záznam je point-of-no-return pro guarded rollback `0105`.

## Povinné vstupy

1. auditovatelný release-candidate branch a draft PR přímo proti `main`, bez
   merge;
2. zelený exact-SHA Quality gate pro konečný candidate SHA;
3. privátní immutable GHCR manifest pro stejné SHA a všechny image reference
   ve tvaru `repository@sha256:<digest>`;
4. samostatná HTTPS staging doména mimo `modvoltapp.cz` a samostatný HTTPS alert
   receiver;
5. staging-only secrets z `.env.staging.example`; žádná hodnota se nesmí převzít
   z produkce;
6. nejnovější konkrétní `backup_log.id`, který patří úspěšné, neprázdné,
   SHA-256 označené a `mve1` šifrované záloze a na témže řádku má
   `restore_status=ok` s čerstvým `restore_tested_at`;
7. staging admin s `diagnostics.view` i `users.manage`, protože smoke čte
   redigovaný inventář `/api/external-accounts`;
8. samostatný výslovný souhlas s aplikací `0105` na staging.

Obnovená produkční kopie nemusí být na `0104`, protože aktuálně běžící produkční
image je starší než R16-C2. Po restore se proto nejprve pouze přečte journal:

- pokud je přesně na `0104`, pokračuje se níže;
- pokud je za `0104`, rollout se zastaví a provede se samostatně schválený
  baseline rollout immutable predecessor image, jehož journal končí na `0104`.
  Známý auditovaný predecessor je
  `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`;
- po baseline migracích se provede interní regrese, vytvoří nová staging-only
  záloha přesného stavu `0104` a restore-test stejného backup ID;
- pokud je DB před `0104` jinak driftovaná nebo už obsahuje `0105`, nepokračuje
  se. Aktuální candidate se nikdy nesmí použít k tichému přeskočení baseline
  brány.

### Immutable predecessor publication boundary

Příprava predecessor image je oddělená od candidate publisheru. Reusable workflow
`.github/workflows/staging-predecessor-image.yml` nemá vstup pro SHA, ref ani PR a
je natvrdo svázaný s commitem
`c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3` a Git tree
`cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c`. Ověřuje 104 SQL souborů, 104 journal
řádků, ocas `0104_thin_sheva_callister` a absenci `0100` i `0105`.

Workflow smí zavolat pouze ruční wrapper
`modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml`
z privátní větve `main`. Publikuje nejvýše jednu `linux/amd64` API image do
existujícího privátního package `site-logbook-staging-api`, s provenance a SBOM.
Přesný SHA tag smí přejít pouze z absent do jedné publikované verze; jedna již
existující a vzdáleně ověřená verze je no-op. Duplicitní tag, jiný caller nebo
jiný package jsou stop.

Výstup `staging-predecessor-image.json` a GNU checksum jsou samostatný artefakt;
nenahrazují candidate manifest pěti images. Před použitím se raw bytes svážou s
odděleně schváleným checksumem a identitou caller runu:

```powershell
pnpm gate:staging-predecessor-image -- --manifest staging-predecessor-image.json --checksum staging-predecessor-image.sha256 --expected-manifest-sha256 <64-hex> --expected-caller-workflow-ref modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main --expected-run-id <id> --expected-run-attempt <attempt>
```

Tento publisher pouze připraví immutable image. Neautorizuje GHCR zápis bez
samostatného potvrzení, nenasazuje ji, nekontaktuje Coolify a nespouští migrátor.
One-shot runtime vazba `apply-0104-baseline`, její backup/input checksumy a
pre/postflight přes exact stav `0104` zůstávají samostatnou následující branou.

## Fail-closed vstupní kontrakt

Do prázdného staging secret store se doplní hodnoty podle
`.env.staging.example`. Pro schema gate jsou navíc povinné:

- `STAGING_BUILD_SHA` – exact candidate SHA;
- `STAGING_IMAGE_MANIFEST_SOURCE_SHA` – `sourceSha` z immutable manifestu;
- `STAGING_IMAGE_MANIFEST_B64` – přesné raw bytes `staging-images.json` jako
  jednořádkové base64, nikdy ručně sestavený JSON;
- `STAGING_IMAGE_MANIFEST_SHA256` – odděleně schválený SHA-256 raw manifestu;
- `STAGING_PROVISIONING_MANIFEST_SHA256` – SHA-256 validovaného observed Coolify
  provisioning manifestu;
- `STAGING_DEPLOYMENT_INPUTS_SHA256` – hash kanonických secret-free vstupů pro
  právě zvolený režim; `inspect`, `apply-0105` a `steady-0105` mají každý jiný hash;
- `STAGING_EXTERNAL_ACCOUNTS_ENABLED=false`;
- `STAGING_SCHEMA_ACTION` – přesně jeden z režimů níže;
- `STAGING_BACKUP_EVIDENCE_ID` – ID nejnovějšího svázaného backup řádku;
- `STAGING_BACKUP_RESTORE_MAX_AGE_HOURS` – celé číslo 1 až 168, doporučeně 24;
- `STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION` – ponechat prázdné až do
  samostatného schválení migrace; poté pouze přesná fráze
  `APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING`.

Režimy jsou záměrně oddělené:

- `inspect` – confirmation musí být prázdné, backup ID/age jsou povinné a smí se
  spustit pouze PostgreSQL plus read-only inventory;
- `apply-0105` – vyžaduje přesnou confirmation frázi a čerstvě svázaný backup;
  pouze tento režim smí spustit standardní migrátor;
- `steady-0105` – confirmation i historické backup ID/age musí být prázdné;
  povolí pouze exact-0105 read-only restart gate.

Staging boundary preflight ověří formát, přesnou shodu SHA, explicitní
`flag=false` a kontrakt zvoleného režimu ještě před startem PostgreSQL. DB schema
gate následně porovná také `BUILD_SHA` zapečené v immutable API image.

## Offline supply-chain a provisioning vazba

Pět image referencí se nesmí přepisovat samostatně. Po stažení image artifactu
se nejprve ověří raw manifest, jeho GNU checksum a odděleně schválený checksum:

```powershell
pnpm gate:staging-image-manifest -- --manifest staging-images.json --checksum staging-images.sha256 --expected-manifest-sha256 <64-hex> --expected-source-sha <40-hex> --expected-caller-workflow-ref <exact-ref> --expected-run-id <id> --expected-run-attempt <attempt>
```

Nový Coolify resource se popíše kopií
`docs/audit/16-c3-staging-provisioning.template.json`. Manifest neobsahuje hesla,
tokeny, access keys ani keyringy. Režim `observed` musí obsahovat skutečné nové
resource/network/volume identifikátory a explicitní seznam zakázaných produkčních
targetů:

```powershell
pnpm gate:staging-provisioning -- --file staging-provisioning.json --expected-source-sha <40-hex>
```

Teprve oba PASS výsledky smějí atomicky vytvořit tři kanonické input artefakty a
secret-free Coolify hodnoty. Existující evidence adresář se nepřepisuje:

```powershell
pnpm gate:staging-deployment-binding -- --manifest staging-images.json --checksum staging-images.sha256 --provisioning staging-provisioning.json --expected-manifest-sha256 <64-hex> --expected-source-sha <40-hex> --expected-caller-workflow-ref <exact-ref> --expected-run-id <id> --expected-run-attempt <attempt> --backup-evidence-id <id> --backup-restore-max-age-hours 24 --output-dir staging-binding-evidence
```

`staging-provisioning-observed.json` je kanonická podoba provisioning artefaktu,
jejíž raw SHA se rovná hodnotě vložené do deployment inputů.
`staging-deployment-environment.json` je secret-free přenosový soubor. Obsahuje
samostatné hodnoty pro inspect, transition a steady režim; produkční nebo staging
secrets se do něj nikdy neukládají.

Pro read-only inventuru se nastaví `STAGING_SCHEMA_ACTION=inspect`, spustí se jen
izolovaný PostgreSQL a po obnovení schválené kopie se zavolá:

```powershell
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d postgres
docker compose --env-file .env.staging -f docker-compose.staging.yml run --rm --no-deps external-schema-gate node dist/external-schema-inventory.mjs
```

Výsledek může být pouze `BASELINE_0104_REQUIRED`, `READY_0104` nebo
`ALREADY_0105`. Neznámý řádek, mezera uprostřed journalu, duplicate, hash drift,
`0100` nebo řádek za `0105` končí chybou. Inventory nevypisuje DB URL, object
path, hash zálohy ani key ID.

## Bezpečné pořadí

1. Ověřit izolaci DNS/TLS, DB, storage, mailu, alert receiveru a credentials.
2. Ověřit exact-SHA CI a immutable image manifest; nespoléhat na tag bez digestu.
3. V režimu `inspect` obnovit schválenou produkční kopii do samostatného staging
   volume a výše uvedeným příkazem read-only ověřit její exact journal. Pokud
   inventory vrátí `BASELINE_0104_REQUIRED`, použít oddělený predecessor baseline
   rollout; jiný drift je stop.
4. Na exact stavu `0104` vytvořit novou staging-only zálohu, restore-testovat
   stejné ID a toto nejnovější ID nastavit jako schema-gate evidence.
5. Teprve po výslovném souhlasu nastavit `STAGING_SCHEMA_ACTION=apply-0105`,
   přesnou confirmation frázi a spustit pouze `external-schema-gate` včetně jeho
   závislostí.
6. State-aware one-shot `external-schema-gate` pod advisory lockem `911072468`
   nejprve přijme idempotentní exact-0105 stav jako read-only no-op. Pro nový
   přechod v pre-mode
   vyžaduje:
   - přesných 104 DB migration řádků a přesné hashe do `0104`;
   - žádné extra nebo duplicitní řádky a žádnou `0105`;
   - journal přesně 105 položek, ocas `0104 -> 0105`, správný snapshot chain a
     pinned hashe obou migrací;
   - nulový výskyt `0100`;
   - absenci všech schema objektů `0105`;
   - shodu DB name/user/host a platný nejnovější backup evidence řádek.
7. Stejný one-shot container spustí standardní `dist/migrate.mjs`.
8. Post-mode vyžaduje přesných 105 migration řádků, kompletní validované
   constraints/indexy/funkce a povolené triggery `0105`, všechny existující
   uživatele typu `internal` a nulu externích users/profilů/scopes/events.
9. Po úspěšném přechodu se nastaví `STAGING_SCHEMA_ACTION=steady-0105` a vymaže
   confirmation i obě backup evidence proměnné. API smí startovat až po
   úspěšném one-shot gate. Při každém restartu provede exact-0105 read-only
   steady-state kontrolu a teprve potom spustí server; startup API již žádnou
   migraci automaticky neprovádí a není svázaný se stářím historické zálohy.
10. Ruční staging smoke ověří exact SHA, admin health, `0105`, 105/105,
    `runtimeEnabled=false`, prázdný inventář, interní login, desktop/mobile/PWA,
    S3 write/delete sondu a alert drill.
11. Uložit secret-free bootstrap artifact a zastavit. Pilot a změna flagu jsou
    samostatná další fáze.

Finální schema-v4 release evidence se ověřuje pouze spolu se všemi osmi raw
artefakty; deklarované hashe bez zdrojových bytes nestačí:

```powershell
pnpm gate:staging-evidence -- --file staging-release-evidence.json --image-manifest staging-images.json --inspect-inputs staging-deployment-inspect.json --transition-inputs staging-deployment-transition.json --steady-inputs staging-deployment-steady.json --schema-gate-evidence staging-schema-gate.json --backup-evidence staging-backup-evidence.json --provisioning staging-provisioning-observed.json --bootstrap staging-bootstrap-summary.json
```

## Stop podmínky

Okamžitě zastavit při neshodě SHA/digestu, sdíleném produkčním targetu, chybějící
nebo jiné migraci, hash driftu, extra DB journal řádku, schema driftu, jiném
backup ID, nešifrované či neověřené záloze, starém restore důkazu, nenulovém
externím stavu nebo flagu jiném než přesně `false`.

Při selhání před migrací se nic nemění. Při selhání během migrace API nenastartuje.
Před prvním externím datovým řádkem lze po samostatném rozhodnutí použít guarded
rollback `0105`; po vzniku externích dat pouze roll-forward a vypnutí flagu.
