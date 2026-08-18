# FÁZE 13.3 – nezávislé security a migration review

- **Datum:** 2026-08-02.
- **Reviewovaný PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1).
- **Base:** `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f` (`main`).
- **Head:** `12d57c512550a1a273947cbc742f577faddc5f72` (`agent/phase13-staging-gate`).
- **Rozsah:** 43 lineárních commitů, 268 souborů, auth/authz, uploady,
  šifrování, veřejné tokeny, immutable evidence, recovery a release gate.
- **Verdikt:** **REQUESTED CHANGES; staging authorization BLOCKED**.
- **Mimo rozsah:** merge, deploy, workflow dispatch, produkční prostředí a migrace
  `0100_user_ui_preferences`.

## Centrální registr nálezů

| ID       | Závažnost | Stav                        | Zjištění a dopad                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Podmínka uzavření                                                                                                                                                                                                 |
| -------- | --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13.3-01 | Medium    | **BLOCKER**                 | `POST /storage/uploads` je klasifikován jen jako `authenticated`. Permission middleware proto propustí i roli `guest`, přestože její role obsahuje jen view oprávnění a obecný `requireWriteAccess` guest zápisy zakazuje. Guest může vytvořit upload ledger a privátní objekt až 25 MiB na požadavek; IP limit je 60 požadavků za 15 minut. Claim ledger brání převzetí uploadu jiným uživatelem, ale nebrání neautorizovanému zápisu, spotřebě scanneru, RAM, DB a storage ani vzniku orphan objektů. | Route musí vyžadovat explicitní write oprávnění nebo nejméně fail-closed zápisový guard; přidat negativní test pro guest a pozitivní testy schválených rolí.                                                      |
| F13.3-02 | Medium    | **BLOCKER**                 | GitHub quality gate spouští DB suites na `postgres:18-alpine`, zatímco `docker-compose.yml`, README a API image deklarují PostgreSQL 16 / `postgresql-client-16`. Zelený běh proto neprokazuje kompatibilitu migrací se stejnou hlavní verzí jako cílový provoz.                                                                                                                                                                                                                                        | Spustit plný migration/rollback a DB gate na PostgreSQL 16; nejlépe změnit CI service na 16 a získat zelený remote run na novém přesném SHA.                                                                      |
| F13.3-03 | Medium    | **ROLLOUT CONDITION**       | Migrace 0101 přenese všechny existující plaintext PPE signature tokeny s novou expirací `now() + 30 days`; confirmation token bez původní expirace dostane stejnou novou lhůtu. Tím se původně neomezené riziko zkracuje, ale i historicky starý nevyužitý bearer odkaz zůstane po cutoveru ještě 30 dní použitelný. Job/quote legacy tokeny jsou naopak `legacy_unbound` a fail-closed nepoužitelné.                                                                                                   | Na anonymizované obnovené kopii pouze spočítat nevyužité legacy PPE tokeny podle stáří, schválit maximální stáří a starší tokeny před rolloutem revokovat nebo bezpečně znovu vydat. Neexportovat jejich hodnoty. |
| F13.3-04 | Low       | **OPEN**                    | Sdílený `quotes.ts` error handler vrací neznámou `Error.message` i z veřejných tokenových rout. Upload route vrací klientovi provider code/message a do logu přidává i `AWSAccessKeyId`. Jde převážně o zděděné chování, nikoli o novou regresi, ale veřejný či guest klient může při chybě získat interní DB/storage detail a log obsahuje identifikátor credentialu.                                                                                                                                  | Pro neočekávané chyby vracet generickou odpověď s korelačním ID; detail ponechat jen v redigovaném interním logu a odstranit logování access-key identifikátoru.                                                  |
| F13.3-05 | N/A       | **ACCEPTED WITH CONDITION** | Kandidát obsahuje 0096–0099 a 0101–0102, odpovídající rollbacky, unikátní journal `idx`/`when` a žádnou 0100. Vlastní migrátor má advisory lock, recovery chybějících out-of-order položek a finální parity check. Samotná mezera 100 proto aktuální PR nerozbíjí.                                                                                                                                                                                                                                      | 0100 zůstává mimo tento PR. Pokud bude později vydána, preferovat nový následující pořadový krok a nový izolovaný migration/upgrade důkaz namísto dodatečné změny již reviewovaného headu.                        |
| F13.3-06 | Info      | **PASS**                    | Session generation/rotation, odstranění question recovery, serializovaný first-admin setup, vault step-up, default-deny route manifest, hash-only one-time veřejné tokeny, immutable job/quote evidence, private-object authorization a upload claim ownership jsou v reviewovaném kódu fail-closed v kontrolovaných hranicích.                                                                                                                                                                         | Zachovat stávající kontraktní a DB testy; PASS není staging ani produkční důkaz.                                                                                                                                  |
| F13.3-07 | Medium    | **BLOCKER**                 | PR je stále draft, nemá požadovaného reviewera, žádný submitted review ani review thread. Staging GitHub Environment a jeho ochrany/handly nebylo možné nezávisle doložit; v aktuálním procesu nejsou žádné `STAGING_*`, DB ani storage handly.                                                                                                                                                                                                                                                         | Jmenovat nezávislého reviewera a staging ownera, doložit Environment protection, izolované handly, RPO/RTO a splnit samostatný autorizační gate.                                                                  |

## Bezpečnostní review podle oblasti

### Autentizace a relace

- Login, setup a WebAuthn úspěch regenerují session; selhání uložení session
  nevrací úspěšnou odpověď.
- `session_generation` invaliduje staré relace po změně hesla nebo deaktivaci.
- Obnova účtu přes bezpečnostní otázku byla odstraněna a první admin setup je
  serializovaný databázovým advisory lockem.
- Vault step-up je vázaný na session a při chybějícím, starém nebo budoucím čase
  selže uzavřeně.

V této oblasti nebyl potvrzen nový High nebo Critical nález. Produkční proxy
topologie, WebAuthn origin/RP a skutečné session cookies ale nebyly v této fázi
testovány proti `modvoltapp.cz`.

### Autorizace a soubory

Route manifest obsahuje 402 rout a neznámé či nezařazené routy jsou odmítnuty.
Privátní object download vyžaduje existující DB referenci a oprávnění všech
navázaných modulů. Upload claim je svázán s `uploaded_by_user_id`, takže jiný
uživatel nemůže staged objekt přivlastnit. Tato ochrana však nenahrazuje oprávnění
k samotnému vytvoření staged uploadu; proto F13.3-01 zůstává blocker.

### Veřejné tokeny a immutable evidence

Nové tokeny používají kryptograficky náhodnou hodnotu, v DB ukládají pouze
SHA-256, mají expiraci, revokaci a atomické one-time consume. Job a quote tokeny
musí být vázané na immutable verzi; legacy neprovázané tokeny jsou odmítnuty.
Rozhodnutí a podpisové události jsou append-only a chráněné DB triggery.

PPE legacy tokeny nemají dokumentový binding a zůstává u nich rollout podmínka
F13.3-03. Veřejné quote routy navíc dědí příliš podrobnou neočekávanou chybovou
odpověď F13.3-04.

## Migrační review

Reviewovaný head přidává migrace:

1. 0096 – session generation;
2. 0097 – durable API idempotency ledger;
3. 0098 – object upload ledger;
4. 0099 – expand-only sloupce envelope encryption;
5. 0101 – hash-only lifecycle veřejných tokenů a legacy backfill;
6. 0102 – immutable job/quote verze, evidence události a token binding.

Všechny mají odpovídající rollback soubor s fail-closed guardem, pokud by rollback
zahodil používaná data nebo auditní důkaz. Forward SQL 0096–0101 nepoužívá
`DELETE`, `DROP` ani `TRUNCATE`. Migrace 0102 provádí backfill
`public_access_tokens.artifact_binding_status` a následně nastavuje `NOT NULL`;
na historickém objemu proto může držet tabulkový lock. Čistý CI běh neprokazuje
délku zámku ani datové anomálie na obnovené kopii.

Journal má 102 položek bez duplicit `idx` a `when`; konec je 96, 97, 98, 99,
101, 102. Migrace 0100 je na přesném PR headu nepřítomná. Tento závěr výslovně
nepovoluje její přidání ani aplikaci.

## Ověřené důkazy

- PR je otevřený mergeable draft na přesném headu `12d57c5`; remote `main`
  zůstává na `a25c312`.
- GitHub Actions run
  [30754695026](https://github.com/modvolt/Site-Logbook/actions/runs/30754695026)
  je `completed/success` na přesném headu.
- GitHub uvádí 0 submitted reviews a 0 review threads.
- `git diff --check a25c312..12d57c5`: PASS.
- 0100 v tree: ABSENT; šest forward migrací, šest rollbacků a šest snapshotů:
  přítomno.
- Journal: 102 entries, 0 duplicate idx, 0 duplicate when.
- Staging/DB/storage proměnné v aktuálním procesu: žádné nalezené; jejich hodnoty
  nebyly čteny ani vypisovány.

Remote zelený gate se považuje za platný unit/build/izolovaný DB/MinIO důkaz,
nikoli za schválení stagingu. Dva potvrzené Medium blockery a chybějící nezávislý
reviewer brání staging autorizaci i případnému merge.
