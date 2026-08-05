# R16-B – ověření vlastněných externích grantů

## Rozsah

R16-B zpřesňuje zákaznické bearer granty pro podpis zakázky, podpis a potvrzení
OOPP, rozhodnutí o nabídce a čtení veřejného QR rozvaděče. Jde o repo-level
implementaci a připravenou migraci. Produkce, staging, Coolify, DNS, secrets,
objektové úložiště ani databáze nebyly změněny. Migrace `0100` zůstává
nezahrnutá a migrace `0103` i nová `0104` zůstávají neaplikované.

R16-B nezavádí přihlášené externí účty. Současná role `guest` se nepovažuje za
bezpečný externí účet a nesmí být použita jako náhrada resource-scoped modelu.

## Architektura grantů

### Společné customer workflow tokeny

`public_access_tokens` je hash-only registr pro přesně čtyři účely:

| Účel | Resource | Jediná terminální akce |
| --- | --- | --- |
| `job_signature` | `job` | `signed` |
| `ppe_signature` | `ppe_assignment` | `signed` |
| `ppe_confirmation` | `ppe_assignment` | `confirmed` |
| `quote_decision` | `quote` | `accepted` nebo `rejected` |

Nový grant má organizaci jako vlastníka workflow; `created_by_user_id` je pouze
provenance vydavatele. Model je záměrně single-organization a neobsahuje
`organization_id`, takže nepředstavuje tenant isolation. Nové granty mají
resource type/id, neměnnou artifact binding, budoucí expiraci nejvýše 365 dnů a
explicitní owner tuple. Plaintext token se vrací jen při vydání a v databázi se
ukládá pouze SHA-256 hash a krátký prefix pro podporu.

Issue, revoke a consume používají jednu grant-family serializaci. OOPP podpis a
potvrzení jsou konfliktní varianty stejné rodiny: nové vydání zneplatní druhou
variantu a úspěšná terminální akce zneplatní sourozence. Vydavatel se uvnitř
transakce znovu ověřuje jako aktivní a s aktuálním efektivním oprávněním; zámek
uživatelského řádku synchronizuje issuance s offboardingem i změnou role nebo
permission overrides.

### Neměnná OOPP evidence

Každý nový OOPP bearer je svázán s verzovaným snapshotem assignmentu, přesným
confirmation textem a SHA-256 hashem. Veřejný GET zobrazuje snapshot, nikoli
později změněný živý řádek. Consume zamkne živý assignment, ověří jeho
způsobilost a v jedné transakci zapíše terminální stav i append-only evidence
event. Podpisový event ukládá hash PNG a object path, ne base64 podpis.

Databázový `BEFORE INSERT` trigger fail-closed ověřuje shodu assignmentu,
evidence version, tokenu, purpose/action, artifact binding, snapshot hashe a
confirmation textu. Evidence version i event mají immutable UPDATE/DELETE
triggery. Legacy OOPP token bez prokazatelné evidence binding je odmítnut a musí
být znovu vydán; historie se zpětně nevymýšlí.

### Podpis zakázky a nabídka

Podpisový grant zakázky je vázán na konkrétní neměnnou document version.
Archivovaná zakázka nový grant nevydá a veřejné zobrazení i consume končí `410`;
archivace zneplatní aktivní grant ve stejné transakci.

Grant nabídky je vázán na immutable quote version. Jeho expirace nikdy
nepřekročí inclusive konec `validUntil` v časové zóně Europe/Prague a veřejné
zobrazení i rozhodnutí tuto neměnnou hodnotu znovu ověřují.

### Fyzický QR grant rozvaděče

QR používá oddělenou rodinu: plaintext je uložen pouze šifrovaně pro pozdější
vykreslení fyzického štítku, vedle hashe a prefixu. Nové QR je vlastněno
rozvaděčem, vydavatel zůstává pouze v auditním eventu. Rotate, deactivate i
automatické vytvoření sdílejí per-board zámek, actor cutoff a nové QR mají
budoucí expiraci s výchozím i maximálním intervalem pěti kalendářních let.

Existující fyzické QR s NULL owner/expiry zůstává v expand release čitelné, aby
nasazení kódu okamžitě nezneplatnilo vytištěné štítky. Je to dočasná rollout
výjimka, ne cílový stav.

## Administrátorský kontrakt

Nové API poskytuje redigovaný inventář customer tokenů a QR grantů. Nevrací raw
token hash ani QR ciphertext. Inventory vyžaduje `users.manage`, používá stabilní
descending ID cursor a dovoluje filtrovat stav, purpose a resource. Ruční revoke
customer tokenu a deactivate QR navíc vyžadují čerstvý vault step-up a uvnitř
transakce znovu ověřují aktivního aktéra. QR service samostatně vyžaduje aktuální
`switchboards.qr.manage`.

OpenAPI, Zod klient, React klient, route policy a deterministický route manifest
jsou součástí stejného kontraktu.

## Logy a citlivá data

- Pino request serializer, explicitní error log a in-memory 5xx ring redigují
  tokenové path a zahazují query string;
- generic audit rediguje tokeny, secrets i `signatureDataUrl` a používá
  redigovanou path také pro skip rozhodnutí;
- QR access audit ukládá pouze hash IP a normalizovaný SHA-256 User-Agentu;
- vnitřní Nginx nevytváří access log pro legacy bearer routy;
- `Referrer-Policy: no-referrer` brání odeslání legacy tokenové URL v Referer.

Tato ochrana neovládá browser history, Nginx error log ani vnější
Coolify/Traefik logy. Provozní rollout proto nesmí tvrdit nulový únik URL, dokud
nebude vnější proxy redigovaně ověřena a následující release nepřesune browser
token do fragmentu a API credential do `Authorization` hlavičky.

## Migrace, preflight a backfill

`0104_thin_sheva_callister.sql` je expand-only DDL navazující na `0103`:

- přidává nullable owner metadata pro legacy řádky;
- přidává OOPP evidence tabulky, FK, CHECK, indexy a immutable/binding triggery;
- zpřísňuje artifact binding a purpose-specific terminal actions;
- nemění ani nemaže existující data a neobsahuje credential backfill.

Před aplikací je povinný read-only preflight historických `consume_action`:

```text
pnpm --filter @workspace/api-server public-tokens:preflight-consume-actions -- --database=<exact_database_name>
```

Owner a QR backfill skripty mají bezpečný dry-run, exact database confirmation a
nevypisují secrets. Public token backfill pouze přiřadí legacy aktivní granty
organizaci; nepřepisuje hash, expiraci ani lifecycle stav. QR backfill vyžaduje
explicitní společné datum expirace pro aktivní perpetual legacy štítky. Žádný
preflight ani backfill nebyl v R16-B spuštěn proti stagingu nebo produkci.

Rollback je povolen pouze před prvním owner/evidence zápisem. Jakmile existuje
nová provenance nebo immutable evidence, guard rollback zablokuje a vyžaduje
roll-forward recovery, aby nedošlo ke ztrátě bezpečnostní historie.

## Lokální ověření

Bez Dockeru, bez připojení k databázi a bez produkčních credentials:

- celý workspace a API TypeScript: PASS;
- OpenAPI Orval/Zod codegen a deterministický manifest 411 rout: PASS;
- `drizzle-kit check` pro schema/journal/snapshot: PASS;
- celý hermetický release gate: 35/35 script contracts, 130/130 frontend,
  15/15 live-events a 463/463 API unit/contract testů, API i PWA build: PASS;
- quality gate: ESLint bez warnings, peer dependencies bez problému a dependency
  audit bez známé zranitelnosti: PASS;
- cílený nový migration/preflight/log balík 27/27: PASS;
- `git diff --check`, scope guard `0100` a secret-pattern scan: PASS.

DB-backed PPE, token, QR, rollback a concurrency testy jsou záměrně zařazené do
izolovaného GitHub Quality gate s PostgreSQL. Přímý lokální běh bez
`DATABASE_URL` se fail-closed odmítl; lokální Docker nebyl kvůli stabilitě
počítače spuštěn.

## Povinný release gate

Repo-level zelený PR není souhlas s migrací ani deployem. Před prvním runtime
nasazením musí samostatně projít:

1. úplná a ověřená záloha produkce a restore zkouška na izolované kopii;
2. přesná migrační posloupnost včetně dosud neaplikované `0103`, nikdy `0100`;
3. read-only consume-action preflight;
4. staging/obnovená kopie: aplikace `0104`, dry-run obou ownership backfillů a
   explicitně schválený apply;
5. nulový počet partial owner tuple, aktivních public grantů bez ownera,
   enabled QR bez ownera a enabled QR bez finite expiry;
6. race testy issue/revoke/consume/offboarding a skutečný rollback guard;
7. redigované ověření inner Nginx i outer Coolify/Traefik access/error logů;
8. teprve poté samostatné rozhodnutí o produkčním deployi a migraci.

## Zbytkové hranice pro R16-C

- dvourelease fragment/header přechod: nejprve compatibility expand, až potom
  změna producentů odkazů; fyzické legacy QR se nesmí odstranit bez inventury a
  přetisku;
- bezpečné přihlášené externí účty: deny-by-default account type, resource
  scopes, expirace na každém requestu/list query, interní custodian a transfer
  při offboardingu;
- centrální public rate limit před body parserem pro podpisová a rozhodovací
  POST volání; současná QR čtení již limiter mají;
- service-worker/identity policy pro token-free public API a no-store fetch;
- staging E2E důkaz, že žádný network request URL, access/error log ani audit
  neobsahuje raw token nebo Authorization hlavičku.
