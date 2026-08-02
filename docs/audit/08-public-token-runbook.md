# FÁZE 8.11 – rollout veřejných tokenů

Tento runbook popisuje bezpečný produkční přechod migrace `0101_public_access_token_lifecycle.sql` a implementace `a749475`. Není záznamem provedeného deploye. Produkční zásah vyžaduje samostatné schválení, zálohu a jmenovaného provozního vlastníka.

## 1. Předpoklady a metriky

Před začátkem zaznamenej commit aplikace, přesný název cílové DB, aktuální nejvyšší migrační záznam a zálohu s ověřenou obnovitelností. Nikdy nevypisuj `DATABASE_URL` ani raw tokeny do ticketu nebo logu.

Success podmínky:

- migrace je aplikována právě jednou a tabulka/constrainty/indexy odpovídají `0101`;
- všechny instance zapisují nové tokeny pouze hash-only a staré instance už neběží;
- dry-run vykáže `unmatched = 0` pro všechny čtyři účely;
- po řízeném cleanupu je `plaintext = 0` i `unmatched = 0`;
- canary ověří nový odkaz, replay, expiraci/revokaci a souběžný quote accept/reject bez úniku credentialu do odpovědi nebo logu.

Abort podmínky:

- journal/schema neodpovídá očekávanému commitu nebo se objeví duplicitní/neznámé migrační číslo;
- záloha nebo restore důkaz chybí;
- libovolný unmatched token, neočekávaný počet řádků nebo SQL chyba;
- během smíšeného provozu stále vzniká legacy plaintext;
- zvýšené 5xx, legitimní nové odkazy vracejí 404/410 nebo dvě konkurenční quote akce uspějí.

## 2. Expand a aplikační cutover

1. Zastav paralelní změny schématu a ověř aktuální journal. Tento release obsahuje pořadí `0099` → `0101`; rozpracovaná `0100_user_ui_preferences` do něj nesmí být dodatečně vložena.
2. Vytvoř a ověř obnovitelnou zálohu. Zaznamenej pouze její ID/hash a čas, ne credentials.
3. Aplikuj expand migraci. Ta vytvoří `public_access_tokens` a importuje hashe legacy job/OOPP/quote tokenů, ale nemaže plaintext.
4. Ověř počty tabulky podle účelu, počet duplicit a integritu constraintů. Rozdíly proti předmigrační inventuře jsou abort.
5. Nasaď API a frontend z jednoho schváleného release. Postupně odstav všechny staré API instance; teprve poté pokračuj.
6. Vytvoř izolované canary záznamy a ověř HTTP hranice: malformed 400, unknown 404, replay 409, expired/revoked 410. Ověř, že jedna ze dvou paralelních quote akcí prohraje.

## 3. Měřený cleanup plaintextu

Příkazy spouštěj z důvěryhodného checkoutu stejného commitu s `DATABASE_URL` předaným chráněným secret mechanismem. Dry-run nic nemaže:

Nejdřív na izolované anonymizované kopii spusť read-only age gate s maximálním stářím schváleným service ownerem. Skript vypisuje pouze agregované počty a stáří, nikdy tokeny nebo jejich prefixy:

```powershell
$env:NODE_ENV = "test"
$env:PUBLIC_TOKEN_PREFLIGHT_CONFIRM_ISOLATED = "true"
pnpm --filter @workspace/api-server public-tokens:preflight -- --database=<PRESNY_NAZEV_IZOLOVANE_DB> --max-age-days=<SCHVALENE_MAXIMUM>
```

`decision: BLOCK` a exit code 2 znamenají, že existuje aktivní legacy PPE odkaz starší než schválený limit. Rollout zastav, odkazy revokuj nebo znovu bezpečně vydej a preflight opakuj. `created_at` je pro PPE signature konzervativní horní odhad stáří, protože legacy schema nemá samostatný čas vydání signature tokenu.

Poté proveď stávající dry-run cleanup plánu:

```powershell
pnpm --filter @workspace/api-server public-tokens:backfill
```

Výstup bezpečně zaznamenej jako agregované počty. Pokud je kterákoli hodnota `unmatched` nenulová, zastav rollout; skript execute stejně odmítne.

Po schválení přesného dry-run výsledku spusť cleanup s názvem DB přesně odpovídajícím cestě v `DATABASE_URL`:

```powershell
pnpm --filter @workspace/api-server public-tokens:backfill -- --execute --database=<PRESNY_NAZEV_DB> --confirm=CLEAR_PUBLIC_TOKEN_PLAINTEXT
```

Bezprostředně zopakuj dry-run. Všechny hodnoty `plaintext` a `unmatched` musí být nula. Ověř také, že nové vydání odkazu legacy sloupce znovu neplní.

## 4. Rollback a obnova

Preferovaný návrat před cleanupem je rollback aplikace při zachování expand tabulky. Starší aplikace může používat zachovaný legacy plaintext; nejdřív však zastav nové writery a ověř, že downgrade rozumí aktuálním doménovým stavům.

Schema rollback `0101_public_access_token_lifecycle.down.sql` používej pouze v krátkém před-cutover okně. Guard jej odmítne, pokud existuje nový, revokovaný či spotřebovaný token nebo hash bez přesně obnovitelného plaintextu. Guard se nesmí obcházet.

Po cleanupu plaintextu nebo po prvním novém/spotřebovaném credentialu je návrat **roll-forward only**: ponech tabulku, oprav aplikaci, zneplatni dotčené odkazy a bezpečně vydej nové. Obnova staré DB zálohy by mohla obnovit replayovatelné tokeny; je přípustná jen jako plná havarijní obnova se současnou revokací/rotací veřejných odkazů a reconciliation externích akcí.

## 5. Následné sledování

Po dobu dohodnutého okna sleduj počty vydaných, revokovaných, expirovaných a spotřebovaných tokenů podle účelu, poměr 400/404/409/410 veřejných rout a chyby odeslání odkazů. Logy nesmějí obsahovat raw URL query token ani request body podpisu. Incident nebo odchylku řeš rotací dotčeného odkazu; nepokoušej se raw token rekonstruovat z hashe.

Automatický purge metadat není součástí FÁZE 8.11. Retenční lhůtu pro hash/prefix, auditní metadata a vazbu na podpisový důkaz je nutné schválit v navazující GDPR/compliance práci před zavedením mazací úlohy.
