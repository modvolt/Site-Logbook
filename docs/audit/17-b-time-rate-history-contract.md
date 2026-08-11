# R17-B – implementační kontrakt historie času, sazeb a korekcí

Datum návrhu: 2026-08-11  
Stav: **DESIGN READY / business policy schválena, implementace čeká na vyřešení migrační větve**  
Navazuje na: `17-a-time-rate-history-gap-audit.md`

## 1. Cíl

Po R17-B musí být možné z databáze a auditních eventů přesně doložit:

1. kdo, kdy a z jakého zdroje zaznamenal pracovní interval;
2. jaký lokální pracovní den, timezone a UTC offset byly použity;
3. která effective-dated sazba byla přiřazena a jaké hodnoty se snapshotovaly;
4. kdo a proč provedl korekci, schválení, zamítnutí nebo void;
5. který původní záznam korekce opravuje;
6. proč se výsledná session směla nebo nesměla dostat do billing draftu;
7. že pozdější sazba, void ani korekce nezměnily původní interval, event nebo známý finanční snapshot.

Migrace `0100` se do této posloupnosti nezařazuje. Číslo R17 migrace se přidělí až po integraci aktuálního `main` a opravě kolidující quote migrace.

## 2. Neměnné invarianty

### R17-I01 – přesný instant a zdroj času

- Nová timer nebo manual session má přesný UTC instant začátku a konce.
- Session nese `sourceClock` z množiny `server`, `client`, `legacy_unknown`.
- Pro `server` a `client` jsou povinné `sourceTimezone`, `sourceUtcOffsetMinutes` a `effectiveWorkDate`.
- Offset musí odpovídat timezone v daném instantu, včetně DST.
- `legacy_unknown` nesmí předstírat timezone ani efektivní pracovní den; historický backfill je povolen jen z doloženého zdroje.

### R17-I02 – rate snapshot se nepřepisuje

- Vložení, void nebo změna effective okna sazby nikdy nepřepíše nenulový snapshot existující session.
- Session s oběma snapshoty `NULL` může být doplněna pouze explicitní backfill operací.
- Backfill vyžaduje konkrétní rate version, lidský důvod, aktéra, idempotency key a event s before/after hodnotami.
- Částečný stav, kdy je jen jeden z cost/sale snapshotů `NULL`, je neplatný.

### R17-I03 – korekce je nový záznam

- Korekce nikdy nemění `startedAt`, `endedAt`, `durationSeconds`, source time ani rate snapshot původní dokončené session.
- Doporučená session korekce nese `correctsSessionId` a přebírá effective work date i snapshot sazby původní session.
- Agregovaná korekce je povolena jen managerovi, musí mít explicitní effective work date a vždy začíná jako `needs_review`.
- Korekce již vyfakturované práce vytváří nový kladný/záporný billing podklad; původní billed link se nemění.

### R17-I04 – review je auditovaná stavová změna

- Manual a correction session začínají jako `needs_review`; timer session může být `not_required`, dokud ji pravidlo neoznačí.
- Přechod `needs_review -> approved|rejected` vyžaduje oprávnění `time.approve`, lidský důvod, aktéra, serverový čas a expected revision.
- Každý přechod vytváří append-only `review_approved` nebo `review_rejected` event.
- `rejected` session se nesmí fakturovat a musí být následně voidnuta nebo opravena novou korekcí.

### R17-I05 – billing vazba se neobchází

- Prostý destruktivní void je povolen jen pro `billingStatus = unbilled` nebo `non_billable`.
- `ready` lze uvolnit pouze atomicky přes billing service, která uvolní reservation link i draft line.
- U `billed` je business void povolen pro reklamaci, chybnou zakázku nebo jiný schválený důvod, ale jedině jako nový append-only `void_requested`/`void_confirmed` event a navázaný R13 storno nebo correction-document chain. Původní session, billed link a vystavený doklad zůstávají immutable.
- Invoice draft smí rezervovat pouze `completed` session se známým snapshotem a review stavem `not_required|approved`.

### R17-I06 – worker a manager mají rozdílné capability

- `jobs.work`: vlastní timer na přiřazené zakázce; bez ručních korekcí, approval a sazeb.
- `time.manage`: ruční intervaly, návrh korekce a void oprávněné unbilled session.
- `time.approve`: approve/reject review fronty; není implicitně obsažen v `jobs.work`.
- `rates.manage`: nové rate version a explicitní backfill chybějících snapshotů.
- Cost/sale hodnoty se dál redigují přes `rates.cost.view` a `rates.sale.view`.

## 3. Datový kontrakt

Následující názvy jsou cílový kontrakt; přesný Drizzle diff vznikne až po integraci migrační větve.

### `work_sessions`

Nová pole:

| Pole                        | Typ                  | Pravidlo                                                                        |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `source_clock`              | text                 | `server`, `client`, `legacy_unknown`; legacy default pouze pro existující řádky |
| `source_timezone`           | text nullable        | IANA timezone pro doložené nové záznamy                                         |
| `source_utc_offset_minutes` | integer nullable     | rozsah `-840..840`, musí odpovídat instantu a timezone                          |
| `effective_work_date`       | date nullable        | jediný kalendářní den používaný pro rate lookup                                 |
| `recorded_at_utc`           | timestamptz          | serverový okamžik přijetí/založení nového záznamu                               |
| `corrects_session_id`       | integer nullable     | self-FK `ON DELETE RESTRICT`; pouze source `correction`                         |
| `correction_reason`         | text nullable        | povinný a netriviální pro source `correction`                                   |
| `reviewed_at`               | timestamptz nullable | vyplněno pro approved/rejected                                                  |
| `reviewed_by_user_id`       | integer nullable     | FK users, `ON DELETE SET NULL`                                                  |
| `review_decision_reason`    | text nullable        | lidský důvod rozhodnutí                                                         |
| `revision`                  | integer              | začíná 1 a roste při povolené stavové změně                                     |

Změny kontrol:

- `review_status`: `not_required`, `needs_review`, `approved`, `rejected`;
- correction vyžaduje `corrects_session_id` nebo explicitní aggregate scope/effective date;
- voided session nesmí mít `billing_status in ('ready', 'billed')`;
- cost a sale snapshot jsou oba `NULL`, nebo oba nenulové;
- completed non-correction duration zůstává nezáporná, correction může být kladná i záporná.

### `work_session_events`

Nové event typy:

- `review_approved`;
- `review_rejected`;
- `rate_snapshot_backfilled`;
- `correction_created`;
- `void_requested`;
- `void_confirmed`;
- `billing_reservation_released`.

Event payload má explicitní schemaVersion a pouze nezbytná auditní data. Integrita/hash chain a export se řídí R09; R17 event nesmí obsahovat neomezený request body ani secret.

FK parentu se změní z `ON DELETE CASCADE` na `ON DELETE RESTRICT`. Produkční role nesmí mít UPDATE/DELETE nad event ledgerem.

## 4. API kontrakt

### Manual session

`POST /jobs/{jobId}/work-sessions` a activity varianta doplní:

- `sourceTimezone`;
- `sourceUtcOffsetMinutes`;
- `effectiveWorkDate`;
- `reason` místo obecného note pro auditní účel;
- `idempotencyKey`.

Server ověří, že oba instanty, offset, timezone a effective date tvoří konzistentní kombinaci. Nová manual session začíná jako `needs_review`.

### Korekce

Nový endpoint:

`POST /jobs/{jobId}/work-sessions/{sessionId}/corrections`

Povinné vstupy:

- `durationDeltaSeconds`;
- `reason`;
- `expectedRevision`;
- `idempotencyKey`.

Session-linked korekce převezme effective date a rate snapshot původní session. Agregovaný legacy endpoint „nastav celkový čas“ smí zůstat pouze jako manager adapter, který vyžaduje `effectiveWorkDate`, vytvoří correction row/event a nic nepřepisuje.

### Review

Nový endpoint:

`POST /jobs/{jobId}/work-sessions/{sessionId}/review`

Body:

```json
{
  "decision": "approved",
  "reason": "Ověřeno podle montážního výkazu",
  "expectedRevision": 3
}
```

Povolené decision: `approved`, `rejected`. Endpoint vyžaduje `time.approve` a row/advisory lock.

### Void

DELETE bez důvodu se odstraní z klientského workflow. Nová cesta:

`POST /jobs/{jobId}/work-sessions/{sessionId}/void`

Body obsahuje `reason` a `expectedRevision`. Service před změnou kontroluje billing status a případnou vazbu na correction chain.

Pro `billed` body navíc obsahuje bounded `reasonCode` (`complaint`, `wrong_job`, `other`) a odkaz na schválený účetní correction intent. Operace nemění původní session na důkazně neviditelný stav: atomicky přidá time void event, zápornou work-session korekci se stejným effective work date a rate snapshotem a R13 účetní correction/storno vazbu. Pokud nelze vytvořit celý řetězec, neprovede se nic.

### Backfill chybějící sazby

Vytvoření rate version nemá vedlejší update session. Samostatná operace nejprve vrátí dry-run seznam pouze `NULL` snapshotů a následně s confirmation tokenem provede idempotentní backfill s eventem pro každý řádek.

## 5. Online migrační pořadí

1. **Preflight:** počty session podle source/status/review/billing, počet částečných snapshotů, billed/ready voided konflikty, DB timezone, rozsah timestampů a doložitelnost historického clock source.
2. **Expand:** nullable auditní sloupce, nové event typy, indexes a `NOT VALID` kontroly; žádná domnělá historická timezone.
3. **Dual-write release:** nové API zapisuje starý kompatibilní tvar i novou provenienci; čtení preferuje nové doložené hodnoty.
4. **Proven backfill:** pouze řádky s doloženým UTC/timezone zdrojem; ostatní `legacy_unknown`.
5. **Validate:** constrainty, orphan/duplicate check, journal/snapshot parity a concurrency testy.
6. **Contract release:** povinná provenance pro nové řádky, staré mutační endpointy vypnuté nebo převedené na adapter.

Žádný krok nesmí automaticky spustit migraci při startu API. Apply a případný backfill jsou oddělené one-shot operace s backup/restore evidence podle R08 a testovací izolací podle R14.

## 6. Povinná test matrix

### DB a service

- timer a manual session přes půlnoc v Europe/Prague v zimním i letním čase;
- oba směry změny DST a neexistující/duplicitní lokální čas;
- backdated rate nezmění známý snapshot;
- explicitní backfill změní pouze oba `NULL` snapshoty a zapíše přesný event;
- correction zachová origin bytes a rate snapshot;
- duplicate correction/backfill idempotency key je no-op, změněný payload je conflict;
- billed/ready session nelze voidnout bez atomického reservation/correction chainu;
- `needs_review` nelze fakturovat, approved ano, rejected ne;
- dva souběžné review/void requesty s jednou revision: právě jeden úspěch;
- event UPDATE/DELETE a parent delete jsou odmítnuty produkční DB rolí.

### Permission a API

- field worker ovládá pouze svůj timer na přiřazeném jobu;
- field worker nemůže číst cizí session, ručně korigovat, approve, void ani spravovat sazby;
- `time.manage` bez `time.approve` může vytvořit návrh, ale ne schválit;
- cost/sale snapshot se nikdy nevrací bez odpovídajícího view permission;
- OpenAPI a generated route manifest klasifikují všechny nové endpointy fail-closed.

### Billing

- draft snapshotuje přesnou duration/rate/amount a další rate version jej nezmění;
- smazání draftu atomicky uvolní reservation a zapíše event;
- issued invoice zachová billed link; pozdější korekce vytvoří nový adjustment podklad;
- žádná void/correction cesta nevytvoří stav „work summary session chybí, invoice link zůstává bez vysvětlení“.

## 7. Exit evidence R17

R17 je hotové pouze pokud:

1. migrace a rollback/preflight mají schválený exact SHA a byly ověřeny na izolované produkční kopii;
2. journal/snapshot parity je zelená a `0100` zůstává nezařazena;
3. všechny nové řádky mají validní source-time provenance;
4. legacy řádky bez důkazu jsou explicitně unknown;
5. backdated rate mutation a void bez důvodu mají negativní DB/API test; billed-session void má pozitivní test úplného correction chainu a negativní test každé neúplné varianty;
6. review queue je proveditelná v API i administrátorském UI;
7. invoice preview/draft používá explicitní snapshot a correction chain je exportovatelný;
8. exact-head Quality, full-stack, recovery/staging smoke a audit export gate jsou zelené.

## 8. Kritická rozhodnutí

Business volby byly potvrzeny 2026-08-11:

1. Korekce konkrétní session dědí její rate snapshot a effective work date. Agregovaná korekce musí mít explicitní effective date a approval.
2. Business void billed práce je povolen například při reklamaci nebo chybné zakázce, ale nesmí přepsat původní session ani vystavený doklad; musí atomicky vytvořit append-only time event a R13 correction nebo storno chain.

Ostatní technické detaily lze realizovat podle tohoto kontraktu bez dalšího dílčího rozhodování.
