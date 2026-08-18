# FÁZE 13.3 – autorizační gate izolovaného stagingu

## Aktuální rozhodnutí

**DENY / BLOCKED.** PR #1 se nesmí mergeovat, nasazovat ani použít k workflow
dispatch, dokud nejsou splněny všechny povinné body níže. Tento dokument není
deploy oprávnění a nevztahuje se na produkci.

## A. Kód a nezávislé review

- [ ] F13.3-01: upload odmítne guest a vyžaduje schválenou write hranici.
- [ ] F13.3-02: celý DB/migration/rollback gate je zelený na PostgreSQL 16.
- [ ] F13.3-03: owner schválil pravidlo pro legacy PPE tokeny a preflight nad
      anonymizovanou obnovenou kopií neukázal nepřijatelně staré aktivní odkazy.
- [ ] F13.3-04: neočekávané veřejné/storage chyby nevracejí interní detail a logy
      neobsahují access-key identifikátor.
- [ ] Nový přesný head SHA je uveden v evidenci a má zelený remote quality gate.
- [ ] Nezávislý reviewer není autor změn a odevzdal schválení bez otevřených
      blocking threadů.
- [ ] Migrace 0100 není součástí reviewovaného diffu ani journalu.

## B. GitHub Environment a vlastnictví

- [ ] GitHub Environment `staging` existuje a má protection reviewer.
- [ ] Jsou jmenováni service owner, staging owner, operator a nezávislý reviewer.
- [ ] Variables: `STAGING_BASE_URL`, `STAGING_ENVIRONMENT_ID` a
      `STAGING_MAIL_SANDBOX_CONFIRMED=true`.
- [ ] Secrets: pouze dedikované `STAGING_ADMIN_USERNAME` a
      `STAGING_ADMIN_PASSWORD`; nesdílejí se s produkcí.
- [ ] Branch/deployment policy dovoluje pouze výslovně schválený head.
- [ ] Staging URL není `modvoltapp.cz`, jeho subdoména, localhost ani HTTP.

Aktuální stav těchto bodů nebyl doložen. GitHub connector uměl přečíst PR a CI,
ale neposkytuje Environment metadata; lokální `gh auth status` při tomto auditu
ohlásil neplatný token. Z chyby 404/401 proto nelze usuzovat, zda Environment
neexistuje, nebo pouze nebyl autorizovaně čitelný.

## C. Izolace dat a infrastruktury

- [ ] Staging DB je PostgreSQL 16, oddělená od produkčního clusteru i credentials.
- [ ] Anonymizovaný DB snapshot a object recovery point mají společný čas.
- [ ] Zdrojový, staging a recovery bucket mají schválené redigované fingerprinty.
- [ ] Staging identita nemá síťovou ani IAM cestu pro zápis do produkční DB,
      storage, mailu, DNS nebo deploy platformy.
- [ ] Recovery účet/klíč je oddělený od runtime účtu; current/old/recovery key
      custody má dva vlastníky a break-glass postup.
- [ ] Target bucket je prázdný, má versioning, public-access block, encryption,
      Object Lock a schválenou nenulovou retenci.
- [ ] Mail směřuje jen do sandbox inboxu a žádná zpráva nemůže dojít zákazníkovi.
- [ ] Cleanup a retence staging dat jsou předem schválené.

## D. Migrační preflight na obnovené kopii

- [ ] Zaznamenat počet řádků, velikosti tabulek a odhad locku pro 0096–0102.
- [ ] Bez výpisu tokenů spočítat aktivní legacy job/quote/PPE tokeny podle typu,
      stavu a stáří; staré PPE tokeny revokovat nebo znovu vydat podle schválené
      politiky.
- [ ] Ověřit expand/backfill/constraint pořadí 0099, 0101 a 0102.
- [ ] Spustit forward všech migrací, parity check, cílené DB testy a povolený
      forward/down/forward cyklus pouze na nově vytvořené staging DB.
- [ ] Potvrdit, že journal obsahuje 0099 → 0101 a 0100 je nepřítomná.
- [ ] Změřit dobu 0102 backfillu a locků; překročení schváleného maintenance
      budgetu je abort.
- [ ] Rollback je roll-forward aplikační návrat, pokud guard brání bezpečnému DOWN;
      žádný guard se neobchází ručním mazáním evidence.

## E. Exact-SHA staging smoke

- [ ] Nasazené `/api/healthz.version` odpovídá přesnému reviewovanému SHA.
- [ ] Auth/session: login, logout, password invalidation, WebAuthn a vault step-up.
- [ ] Role: guest read-only včetně odmítnutého uploadu; field a manager pozitivní
      workflow podle oprávnění.
- [ ] Upload: validní soubor, limit, spoof MIME, malware/scanner unavailable,
      owner claim a autorizovaný download proti oddělenému storage.
- [ ] Veřejné tokeny: expiry, revoke, one-time consume, souběh a immutable binding.
- [ ] Desktop, mobile, PWA online/offline a identity switch bez přenosu dat.
- [ ] Mail sandbox delivery, freshness alert a příjemce jsou doložené.
- [ ] Společný DB + object restore a business smoke mají změřené RPO/RTO.
- [ ] Evidence neobsahuje secret, token, cookie, osobní data ani bearer URL.

Workflow `Staging smoke (manual, no deploy)` pouze testuje již nasazený commit a
dva boolean vstupy jsou lidské deklarace. Sám neprokazuje izolaci DB/storage/mail,
nic nenasazuje a nesmí být spuštěn před splněním A–D.

## F. Abort hranice

Okamžitě zastavit, pokud:

- se jakýkoli handle, účet, bucket, příjemce nebo origin shoduje s produkcí;
- build SHA neodpovídá schválenému headu;
- PostgreSQL major není 16 nebo parity/migrační test není plně zelený;
- zůstává aktivní guest upload, starý neschválený PPE bearer token nebo interní
  chybový detail ve veřejné odpovědi;
- storage policy vrátí `unknown`, target není prázdný nebo chybí immutable retence;
- chybí druhý reviewer, schválené RPO/RTO, rollback owner nebo evidence cleanupu.

Po splnění všech položek musí uživatel samostatně autorizovat přesný staging
dispatch. Ani úspěšný staging neautorizuje merge nebo produkční release.
