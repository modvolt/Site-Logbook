# R15-D – ověření bezpečné obnovy dead-letter zásilky

## Rozsah

R15-D přidává úzký administrátorský workflow pro zobrazení redigovaných
dead-letter záznamů a opětovné zařazení právě jednoho záznamu. Tato část nic
nenasazuje, nepublikuje image, nemění DNS/TLS/secrety, neaplikuje migraci a
nepřistupuje k produkční databázi. Migrace `0103` z R15-B2 zůstává podmínkou
pozdější staging aktivace; `0100` zůstává nezařazena.

## Implementovaný kontrakt

- `GET /api/admin/health/operational-alert-outbox/dead-letters` vrací nejvýše 50
  nejnovějších redigovaných řádků a vyžaduje `diagnostics.manage`;
- `POST /api/admin/health/operational-alert-outbox/{id}/requeue` přijímá pouze
  kladné celočíselné ID, přesný počet pokusů, přesný dead-letter čas a jeden ze
  čtyř pevných důvodů;
- globální access policy vyžaduje pro mutaci současně `diagnostics.view` a
  `diagnostics.manage`; route má navíc vlastní `diagnostics.manage` obranu;
- globální identity-scoped middleware vyžaduje `X-Stavba-Offline-Scope` a
  `Idempotency-Key`, odmítá opětovné použití klíče pro jiné tělo a přehrává
  dokončenou odpověď pro totožný retry;
- databázová transakce zamkne jediný řádek pomocí `FOR UPDATE`, porovná stav a
  obě optimistic preconditions, teprve potom jej změní na `pending`;
- počet pokusů se vynuluje, lease a terminal časové značky se vyčistí, ale
  poslední failure category a HTTP status se zachovají;
- requeue přímo nic neodesílá; další claim provádí běžný worker s novým lease
  tokenem a novým omezeným osmipokusovým cyklem;
- ve stejné transakci vzniká právě jeden explicitní audit
  `operational_alert.dead_letter.requeued`; generický mutation audit přesně tuto
  route přeskočí;
- bulk endpoint, volný text a incident payload nejsou součástí kontraktu.

## Redakce a audit

Operator list obsahuje pouze `outboxId`, provozní `code`, `severity`,
`transitionKind`, `attemptCount`, `lastFailureCategory`, `lastHttpStatus`,
`deadLetteredAt` a `createdAt`. Neobsahuje event key, fingerprint, payload,
příjemce, identity, owner, runbook, metriku, naměřenou hodnotu, object path,
URL/token ani secret.

Audit summary je serverem vytvořený JSON s pevným důvodem, předchozím počtem
pokusů a dead-letter časem. Neobsahuje request body mimo allowlist, incident data
ani transportní konfiguraci. Audit a změna stavu mají společný commit/rollback.

## Ověřovací matice

Lokálně bez Dockeru/PostgreSQL:

- strict unique-key OpenAPI YAML parse: PASS;
- OpenAPI codegen a `typecheck:libs`: PASS;
- fail-closed route manifest: 405 unikátních routes;
- 25 cílených kontraktových testů: PASS;
- API TypeScript check: PASS;
- cílený ESLint bez warningů: PASS;
- `git diff --check`: PASS.

Izolovaný PostgreSQL test je připraven pro GitHub Quality gate a ověřuje:

1. redigovaný list a přesný allowlist polí;
2. `404` pro neexistující ID a `409` pro zastaralý počet/čas bez mutace a auditu;
3. dva souběžné requeue pokusy s různými klíči vedou právě k jednomu úspěchu;
4. reset počtu pokusů, vyčištění lease/terminal polí a zachování failure metadata;
5. právě jeden atomický audit bez citlivých polí;
6. další worker claim začíná pokusem 1 a starý lease ACK zůstává neplatný;
7. append-only incident event zůstává beze změny.

Lokální DB běh úmyslně neproběhl: Docker/PostgreSQL test se deleguje na izolované
CI databáze, aby se zachovala stabilita uživatelova počítače.

## Externí hranice

Endpoint nesmí být použit, dokud cílové prostředí nemá aplikovanou migraci `0103`
a ověřený receiver. Tento repo-level checkpoint neautorizuje requeue skutečných
produkčních záznamů. Staging aktivace, migrace, deploy, receiver secret a fault
drill zůstávají samostatnými, explicitně řízenými kroky.
