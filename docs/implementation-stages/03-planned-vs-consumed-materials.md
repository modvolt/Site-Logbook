# Etapa 3: Planovany a spotrebovany material

## Rozsah

Rucne pridany material v zakazce je ve vychozim stavu `planovano`
(`materials.done = false`). Tento stav:

- nemeni skladovou zasobu,
- nevstupuje do statistik skutecne spotreby,
- nevstupuje do navrhu casove-materialove faktury,
- zustava viditelny v zakazce a v akci zakazek jako plan.

Akce `Spotrebovat` atomicky nastavi `done = true`, ulozi cas a uzivatele a
provede skladovy OUT pohyb. Pred spotrebou musi byt vyplneno kladne mnozstvi;
API tuto podminku kontroluje i mimo frontend. Akce `Do planu` nastavi `done = false`, smaze
aktualni auditni metadata stavu a prida opravny skladovy pohyb. Historie skladu
se nikdy nemaze.

Material vytvoreny ze schvaleneho prijateho dokladu je spotrebovany ihned.
Material dlouhodobe akce (`activity_material`) zachovava dosavadni okamzity
skladovy vydej; jeho workflow tato etapa nemeni.

## Datovy model a migrace

Migrace `0087_chief_marvel_apes.sql` pridava do `materials`:

- `consumed_at`,
- `consumed_by_user_id` s vazbou na `users`,
- index `materials_consumed_at_idx`.

Existujici materialy migrace oznaci jako spotrebovane a nastavi
`consumed_at = created_at`. To zachovava jejich dosavadni vyznam a nevytvari,
nemeni ani nemaze zadny skladovy pohyb.

## API a audit

`POST /api/jobs/:jobId/materials` prijima volitelne `done`, vychozi hodnota je
`false`. `PATCH /api/jobs/:jobId/materials/:materialId` prijima zmenu `done` a
ve stejne transakci:

1. ulozi stav a auditni metadata,
2. sesynchronizuje append-only skladovy ledger,
3. zapise explicitni audit `material_consumed` nebo
   `material_returned_to_plan`.

Opakovane poslani stejneho stavu je idempotentni a nevytvori dalsi skladovy
pohyb. Material rizeny dokladem nebo pouzity ve fakture nelze timto zpusobem
menit.

## Nasazeni

1. Zastavit zapisovou cast API nebo nasadit v beznem migracnim okne.
2. Spustit migraci 0087.
3. Nasadit API a frontend ze stejne revize.
4. Na nove testovaci zakazce pridat material propojeny se skladem.
5. Overit, ze stav `Planovano` nezmenil sklad ani navrh faktury.
6. Pouzit `Spotrebovat` a overit prave jeden OUT pohyb a snizeni skladu.
7. Pouzit `Do planu` a overit opravny IN pohyb, puvodni OUT v historii a
   navrat skladoveho mnozstvi.
8. Overit dve auditni udalosti a vylouceni planovane polozky z fakturace.

## Rollback

Rollback aplikace a migrace se provadi spolecne pri zastavenem API. Manualni
skript `lib/db/rollbacks/0087_chief_marvel_apes.down.sql` nejdrive overi, ze
neexistuje zadny radek `materials.done = false` ani nezrekonstruovatelna
historie skutecne spotreby.

Pokud planovane materialy nebo skutecna auditni historie existuji, rollback se
zastavi bez zmen. Legacy backfill lze odvodit z `created_at`, ale skutecne
`consumed_at` a `consumed_by_user_id` se nesmi zahodit. V takovem pripade se
ponecha aditivni schema nebo se audit nejprve bezpecne prevede do kompatibilniho
modelu. Skladove pohyby ani materialy rollback nemaze.

## Testy

- Cisty domenovy test overuje rozdil job materialu a materialu dlouhodobe akce.
- Kontraktni test hlida transakcni zmenu stavu, auditni metadata a reconcile.
- Kontraktni test hlida filtr `done = true` v obou fakturacnich dotazech.
- Migracni test hlida zachovavajici backfill bez `DELETE`.
- Rollback test hlida blokaci pri existenci planovanych radku.
- Opt-in databazovy test overuje plan -> spotreba -> navrat do planu vcetne
  append-only skladovych pohybu.

Databazovy test vyzaduje izolovanou DB, `DATABASE_URL` a
`ATOMIC_JOB_DB_TEST_ENABLED=true`. Bez tohoto explicitniho prepinace se
nespusti ani pri nahodne nastavenem produkcnim pripojeni.
