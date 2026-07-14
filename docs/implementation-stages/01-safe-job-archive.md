# Etapa 1: Bezpecna archivace zakazek

## Rozsah

- Migrace `0086_quick_imperial_guard` pridava pouze nullable archivacni sloupce.
- `DELETE /api/jobs/:id` provadi soft-delete a zachovava navazujici data.
- Archivaci blokuje aktivni mereni casu a vazba na platnou fakturu.
- Archivovane zakazky lze obnovit pres `POST /api/jobs/:id/restore`.
- Bezne provozni prehledy archivovane zakazky nezahrnuji.

## Nasazeni

1. Pred nasazenim vytvorit a overit zalohu databaze.
2. Nasadit API a frontend ze stejne revize.
3. Overit migracni paritu a pritomnost `0086_quick_imperial_guard`.
4. Overit archivaci a obnovu pouze na nove testovaci zakazce.

## Rollback

Preferovany aplikacni rollback je navrat predchozi revize. Aditivni sloupce mohou
v databazi zustat a starsi aplikaci neprekazeji.

Plny databazovy rollback je v
`lib/db/rollbacks/0086_quick_imperial_guard.down.sql`. Skript se zastavi, pokud
v libovolnem ze tri archivnich sloupcu zustava metadata. Vsechny dotcene zakazky
je nejprve nutne obnovit a overit prazdne `archived_at`,
`archived_by_user_id` i `status_before_archive`.
Skript odstrani take zaznam migrace z Drizzle zurnalu, aby bylo mozne migraci
pozdeji znovu aplikovat.

## Ochrana dat

Migrace neobsahuje `UPDATE` ani `DELETE` nad tabulkou `jobs`. Archivace nemaze
vyjezdy, materialy, doklady, cas ani skladove pohyby.
