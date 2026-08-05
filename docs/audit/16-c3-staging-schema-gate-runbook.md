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

## Fail-closed vstupní kontrakt

Do prázdného staging secret store se doplní hodnoty podle
`.env.staging.example`. Pro schema gate jsou navíc povinné:

- `STAGING_BUILD_SHA` – exact candidate SHA;
- `STAGING_IMAGE_MANIFEST_SOURCE_SHA` – `sourceSha` z immutable manifestu;
- `STAGING_EXTERNAL_ACCOUNTS_ENABLED=false`;
- `STAGING_BACKUP_EVIDENCE_ID` – ID nejnovějšího svázaného backup řádku;
- `STAGING_BACKUP_RESTORE_MAX_AGE_HOURS` – celé číslo 1 až 168, doporučeně 24;
- `STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION` – ponechat prázdné až do
  samostatného schválení migrace; poté pouze přesná fráze
  `APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING`.

Staging boundary preflight ověří formát, přesnou shodu SHA, explicitní
`flag=false` a potvrzení ještě před startem PostgreSQL. DB schema gate následně
porovná také `BUILD_SHA` zapečené v immutable API image.

## Bezpečné pořadí

1. Ověřit izolaci DNS/TLS, DB, storage, mailu, alert receiveru a credentials.
2. Ověřit exact-SHA CI a immutable image manifest; nespoléhat na tag bez digestu.
3. Obnovit schválenou produkční kopii do samostatného staging volume a read-only
   ověřit její exact journal. Pokud je za `0104`, použít výše popsaný oddělený
   predecessor baseline rollout.
4. Na exact stavu `0104` vytvořit novou staging-only zálohu, restore-testovat
   stejné ID a toto nejnovější ID nastavit jako schema-gate evidence.
5. Teprve po výslovném souhlasu nastavit přesnou confirmation frázi a spustit
   staging Compose.
6. One-shot `external-schema-gate` pod advisory lockem `911072468` v pre-mode
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
9. API smí startovat až po úspěšném one-shot gate. Při každém restartu ještě
   jednou provede read-only postflight a teprve potom spustí server; startup API
   již žádnou migraci automaticky neprovádí.
10. Ruční staging smoke ověří exact SHA, admin health, `0105`, 105/105,
    `runtimeEnabled=false`, prázdný inventář, interní login, desktop/mobile/PWA,
    S3 write/delete sondu a alert drill.
11. Uložit secret-free bootstrap artifact a zastavit. Pilot a změna flagu jsou
    samostatná další fáze.

## Stop podmínky

Okamžitě zastavit při neshodě SHA/digestu, sdíleném produkčním targetu, chybějící
nebo jiné migraci, hash driftu, extra DB journal řádku, schema driftu, jiném
backup ID, nešifrované či neověřené záloze, starém restore důkazu, nenulovém
externím stavu nebo flagu jiném než přesně `false`.

Při selhání před migrací se nic nemění. Při selhání během migrace API nenastartuje.
Před prvním externím datovým řádkem lze po samostatném rozhodnutí použít guarded
rollback `0105`; po vzniku externích dat pouze roll-forward a vypnutí flagu.
